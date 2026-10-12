import { afterEach, expect, test } from "bun:test";
import { createConversationService, type Store } from "@valerie/core";
import { required, scheduledFixture } from "../reminders/test-fixture";
import { bindConversationTools } from "./catalog";
import { createDailyTools } from "./daily";
import { createToolRegistry } from "./registry";
import { describeReminderTime } from "./reminder-time";
import { createReminderTools } from "./reminders";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(at = "2026-09-15T18:10:23.456Z", pinned = true) {
  const f = scheduledFixture(at);
  stores.push(f.store);
  f.reminders.savePermissions({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageReminders: true,
  });
  const registry = createToolRegistry(f.store, [
    ...createReminderTools(f.store, {
      now: f.now,
      permissions: { manageReminders: pinned },
      structuredTime: true,
    }),
    ...createDailyTools(f.store, { now: f.now, extended: true }),
  ]);
  let n = 0;
  const call = (
    args: Record<string, unknown>,
    source: ReturnType<typeof f.accept>,
    operation = `op-${n++}`,
    name = "reminder_write",
  ) =>
    registry.execute(
      { id: operation, name, arguments: JSON.stringify(args) },
      { turnId: source.turnId, operationKey: operation, signal: new AbortController().signal },
      () => {},
    );
  const save = (sourceId: string, changes: Record<string, unknown> = {}) => ({
    action: "save",
    title: "Bring sketchbook",
    purpose: "Bring the sketchbook on an outing.",
    originalTimeIntent: "In twenty minutes",
    allowFallback: false,
    relativeMinutes: 20,
    sourceIds: [sourceId],
    ...changes,
  });
  return { ...f, call, save };
}

test("relative writes use the request instant across generation delays and replay, with a saved local confirmation", async () => {
  const f = fixture(),
    source = f.accept("Remind me in twenty minutes to bring my sketchbook.");
  f.advance(5 * 60000);
  const args = f.save(source.sourceId),
    result = await f.call(args, source, "stable-save");
  expect(result).toMatchObject({
    status: "succeeded",
    result: {
      reminder: { dueAt: "2026-09-15T18:30:23.456Z", version: 1 },
      confirmation: {
        taskState: "active",
        deliveryConfirmed: false,
        due: {
          at: "2026-09-15T18:30:23.456Z",
          localDateTime: "2026-09-15T13:30:23.456",
          timezone: "America/Chicago",
        },
      },
      timeResolution: {
        source: { sourceId: source.sourceId, receivedAt: "2026-09-15T18:10:23.456Z" },
      },
    },
  });
  f.advance(25 * 60000);
  expect(await f.call(args, source, "stable-save")).toEqual(result);
  expect(f.reminders.list()).toHaveLength(1);
  expect(f.reminders.listOccurrences()).toHaveLength(1);
  expect(describeReminderTime("2026-09-15T18:30:23.456Z", "America/Chicago").display).toContain(
    "1:30:23 PM CDT",
  );
});

test("snoozing twenty minutes never asks the model to manufacture a UTC offset", async () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" });
  const source = f.accept("Snooze that reminder for twenty minutes.");
  f.advance(60000);
  expect(
    await f.call(
      {
        action: "snooze",
        id: reminder.id,
        expectedVersion: reminder.version,
        occurrenceId: reminder.currentOccurrenceId,
        originalTimeIntent: "Twenty minutes from now",
        relativeMinutes: 20,
        sourceIds: [source.sourceId],
      },
      source,
    ),
  ).toMatchObject({
    status: "succeeded",
    result: { reminder: { dueAt: "2026-09-15T18:30:23.456Z", version: 2 } },
  });
  expect(f.reminders.readOccurrence(reminder.currentOccurrenceId)?.status).toBe("cancelled");
});

test("today and tomorrow use the request's local date even if generation crosses midnight", async () => {
  const f = fixture("2026-09-16T04:59:00.000Z"),
    source = f.accept("Tomorrow at 8 a.m., please.");
  f.advance(120000);
  expect(
    await f.call(
      f.save(source.sourceId, { relativeMinutes: undefined, dayOffset: 1, localTime: "08:00" }),
      source,
    ),
  ).toMatchObject({
    status: "succeeded",
    result: { reminder: { dueAt: "2026-09-16T13:00:00.000Z" } },
  });
});

test("a snooze repair names only missing fields and still requires the saved version", async () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" });
  const source = f.accept("Snooze that reminder for twenty minutes.");
  const args = {
    action: "snooze",
    id: reminder.id,
    occurrenceId: reminder.currentOccurrenceId,
    relativeMinutes: 20,
    sourceIds: [source.sourceId],
  };
  const missingBoth = await f.call(args, source);
  expect(missingBoth).toMatchObject({
    status: "rejected",
    field: "expectedVersion",
    reason: "missing_fields",
  });
  expect(missingBoth.message).toContain("Missing: expectedVersion, originalTimeIntent.");
  const missingVersion = await f.call({ ...args, originalTimeIntent: "In twenty minutes" }, source);
  expect(missingVersion.message).toContain("Missing: expectedVersion.");
  expect(f.reminders.read(reminder.id)?.version).toBe(1);
  expect(
    await f.call(
      { ...args, expectedVersion: reminder.version, originalTimeIntent: "In twenty minutes" },
      source,
    ),
  ).toMatchObject({
    status: "succeeded",
    result: { reminder: { version: 2, dueAt: "2026-09-15T18:30:23.456Z" } },
  });
});

test("local writes report DST gaps and distinguish repeated hours without model arithmetic", async () => {
  const f = fixture("2026-01-01T00:00:00.000Z"),
    source = f.accept("Please save these clock times.");
  for (const [localDateTime, occurrence, at, adjustment] of [
    ["2026-03-08T02:30", "first", "2026-03-08T08:00:00.000Z", "gap_forward"],
    ["2026-03-08T02:30:30.456", "first", "2026-03-08T08:00:00.000Z", "gap_forward"],
    ["2026-11-01T01:30", "first", "2026-11-01T06:30:00.000Z", "repeated"],
    ["2026-11-01T01:30", "second", "2026-11-01T07:30:00.000Z", "repeated"],
  ]) {
    expect(
      await f.call(
        f.save(source.sourceId, { relativeMinutes: undefined, localDateTime, occurrence }),
        source,
      ),
    ).toMatchObject({
      status: "succeeded",
      result: {
        reminder: { dueAt: at },
        timeResolution: { adjustment, requestedLocalDateTime: localDateTime },
        confirmation: { due: { at } },
      },
    });
  }
  expect(
    await f.call(
      f.save(source.sourceId, {
        relativeMinutes: undefined,
        localDateTime: "2026-09-16T08:00",
        timezone: "Asia/Kathmandu",
      }),
      source,
    ),
  ).toMatchObject({
    status: "succeeded",
    result: { reminder: { dueAt: "2026-09-16T02:15:00.000Z" } },
  });
});

test("edits preserve exact instants and expiry unless explicitly replaced or cleared", async () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(
      f.fields({ dueAt: "2026-11-01T07:30:27.891Z", expiresAt: "2026-11-02T00:00:00.000Z" }),
      { actor: "owner" },
    );
  const source = f.accept("Just rename that reminder, keeping its schedule.");
  const args = f.save(source.sourceId, {
    relativeMinutes: undefined,
    id: reminder.id,
    expectedVersion: reminder.version,
    title: "Bring blue sketchbook",
  });
  expect(await f.call(args, source)).toMatchObject({
    status: "succeeded",
    result: {
      reminder: { dueAt: reminder.dueAt, expiresAt: reminder.expiresAt, version: 2 },
      timeResolution: { method: "preserved" },
    },
  });
  expect(
    await f.call({ mode: "reminder", id: reminder.id }, source, "read-saved", "daily_read"),
  ).toMatchObject({
    status: "succeeded",
    result: {
      savedSchedule: {
        due: { localDateTime: "2026-11-01T01:30:27.891", at: reminder.dueAt },
        expiry: { at: reminder.expiresAt },
      },
    },
  });
  expect(await f.call({ ...args, expectedVersion: 2, clearExpiry: true }, source)).toMatchObject({
    status: "succeeded",
    result: { reminder: { expiresAt: null, dueAt: reminder.dueAt, version: 3 } },
  });
});

test("invalid or mixed time choices cannot save a reminder", async () => {
  const f = fixture(),
    source = f.accept("Remind me later.");
  for (const changes of [
    { localDateTime: "2026-09-16T08:00" },
    { relativeMinutes: undefined, localDateTime: "2026-09-15T18:30:00-05:00" },
    { relativeMinutes: undefined, localDateTime: "2026-09-15T18:30:00Z" },
    { relativeMinutes: undefined, dueAt: "2026-09-15T18:30:00Z" },
    { relativeMinutes: undefined, dayOffset: 1 },
    { relativeMinutes: undefined, dayOffset: 1, localTime: "28:00" },
    { relativeMinutes: undefined, localDateTime: "2026-02-30T08:00" },
    { occurrence: "second" },
    { expiresLocalDateTime: "2026-09-16T08:00", clearExpiry: true },
    { expiresLocalDateTime: "2026-09-15T10:00" },
  ])
    expect(await f.call(f.save(source.sourceId, changes), source)).toMatchObject({
      status: "rejected",
    });
  expect(f.reminders.list()).toHaveLength(0);
});

test("relative timing requires an original current source and an explicit choice when messages differ", async () => {
  const f = fixture(),
    old = f.accept("A previous time request.");
  f.reply();
  f.advance(60000);
  const one = f.accept("Set a reminder in twenty minutes.", { mediaGroupId: "timing-album" });
  f.advance(60000);
  const two = f.accept("Also another note.", { mediaGroupId: "timing-album" });
  expect(one.turnId).toBe(two.turnId);
  expect(await f.call(f.save(old.sourceId), one)).toMatchObject({
    status: "rejected",
    reason: "current_request_required",
  });
  const args = f.save(one.sourceId, { sourceIds: [one.sourceId, two.sourceId] });
  expect(await f.call(args, one)).toMatchObject({
    status: "rejected",
    reason: "ambiguous_time_source",
  });
  expect(await f.call({ ...args, timeSourceId: old.sourceId }, one)).toMatchObject({
    status: "rejected",
    reason: "current_request_required",
  });
  expect(await f.call({ ...args, timeSourceId: one.sourceId }, one)).toMatchObject({
    status: "succeeded",
    result: { reminder: { dueAt: "2026-09-15T18:31:23.456Z" } },
  });
});

test("forwarded, fully quoted, incomplete and foreign sources cannot anchor a duration", async () => {
  for (const variant of ["forwarded", "quoted", "incomplete", "foreign"] as const) {
    const f = fixture(),
      text = "Remind me in twenty minutes.";
    const source = f.accept(text, {
      chatId: variant === "foreign" ? "99" : "42",
      metadata: {
        version: 1,
        provenance: variant === "forwarded" ? "forwarded" : "original",
        incomplete: variant === "incomplete",
        replyQuote: null,
        quotedRanges: variant === "quoted" ? [{ offset: 0, length: text.length }] : [],
      },
    });
    const target = variant === "foreign" ? f.accept("A different conversation.") : source;
    expect(await f.call(f.save(source.sourceId), target)).toMatchObject({ status: "rejected" });
    expect(f.reminders.list()).toHaveLength(0);
  }
});

test("structured writes retain pinned and live permissions and optimistic conflict checks", async () => {
  const blocked = fixture(undefined, false),
    denied = blocked.accept("Remind me in twenty minutes.");
  expect(await blocked.call(blocked.save(denied.sourceId), denied)).toMatchObject({
    status: "rejected",
    code: "permission_denied",
  });
  const f = fixture(),
    source = f.accept("Remind me in twenty minutes.");
  const result = await f.call(f.save(source.sourceId), source);
  expect(result.status).toBe("succeeded");
  const reminder = required(f.reminders.list()[0]);
  expect(
    await f.call(f.save(source.sourceId, { id: reminder.id, expectedVersion: 99 }), source),
  ).toMatchObject({ status: "rejected", reason: "reminder_conflict" });
  f.reminders.savePermissions({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageReminders: false,
  });
  expect(await f.call(f.save(source.sourceId), source)).toMatchObject({
    status: "rejected",
    code: "permission_denied",
  });
  expect(f.reminders.list()).toHaveLength(1);
});

test("queued v3 snapshots keep UTC writes and their atomic habit contract", async () => {
  const f = fixture(),
    definitions = [
      ...createDailyTools(f.store, { extended: true, habitPractice: true }),
      ...createReminderTools(f.store),
    ].map(({ name, description, parameters }) => ({ name, description, parameters }));
  const service = createConversationService(f.store, {
    now: f.now,
    dailyTools: true,
    reminderTools: true,
    agreementTools: true,
    captureToolCatalog: () => ({ revision: "agreements-018-v3", schemas: definitions }),
  });
  const source = f.accept("Save a reminder for my sketchbook."),
    turn = required(service.startNextTurn());
  const bound = bindConversationTools(f.store, turn.snapshot, { now: f.now });
  expect(required(bound.tools.find((t) => t.name === "daily_progress")).parameters).toEqual(
    required(definitions.find((t) => t.name === "daily_progress")).parameters,
  );
  const registry = createToolRegistry(f.store, bound.tools);
  expect(
    await registry.execute(
      {
        id: "legacy",
        name: "reminder_write",
        arguments: JSON.stringify({
          action: "save",
          ...f.fields({ dueAt: "2026-09-15T18:30:00.000Z" }),
          expiresAt: undefined,
          sourceIds: [source.sourceId],
        }),
      },
      { turnId: turn.id, operationKey: "legacy", signal: new AbortController().signal },
      () => {},
    ),
  ).toMatchObject({
    status: "succeeded",
    result: { reminder: { dueAt: "2026-09-15T18:30:00.000Z" } },
  });
});
