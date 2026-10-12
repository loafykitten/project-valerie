import { afterEach, expect, test } from "bun:test";
import { createDynamicService, type Store } from "@valerie/core";
import { required, scheduledFixture } from "../reminders/test-fixture";
import { createAgreementTools } from "./agreements";
import { createDailyTools } from "./daily";
import { createGroupedDynamicTools } from "./grouped-dynamic";
import { createToolRegistry } from "./registry";
import { createReminderTools } from "./reminders";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(pinned = true) {
  const f = scheduledFixture();
  stores.push(f.store);
  f.agreements.saveSettings({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageHabits: true,
    allowValerieManageRules: true,
    allowValerieManageReminders: true,
  });
  const dynamic = createDynamicService(f.store);
  dynamic.saveSettings({
    expectedVersion: dynamic.getSettings().version,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  const permissions = { manageHabits: pinned, manageRules: pinned },
    reminderPermissions = { manageReminders: pinned };
  const registry = createToolRegistry(f.store, [
    ...createAgreementTools(f.store, { permissions, now: f.now }),
    ...createReminderTools(f.store, { permissions: reminderPermissions, now: f.now }),
    ...createDailyTools(f.store, {
      extended: true,
      now: f.now,
      agreementPermissions: permissions,
      reminderPermissions,
      offeredToolNames: ["daily_read", "agreement_write", "reminder_write"],
    }).filter((tool) => tool.name === "daily_read"),
    ...createGroupedDynamicTools(f.store, {
      permissions: { manageFocus: pinned, logNotes: pinned },
    }),
  ]);
  let operation = 0;
  const call = (
    name: string,
    args: Record<string, unknown>,
    source: ReturnType<typeof f.accept>,
    extra: Record<string, unknown> = {},
  ) =>
    registry.execute(
      { id: `call-${operation}`, name, arguments: JSON.stringify(args) },
      {
        turnId: source.turnId,
        operationKey: `operation-${operation++}`,
        signal: new AbortController().signal,
        ...extra,
      },
      () => {},
    );
  const subject = f.daily.saveBehavior(
    { name: "Creative practice", valueKind: "count", unit: "sessions" },
    { actor: "owner" },
  );
  const habit = {
    name: "Creative time",
    reason: "Make room for something enjoyable.",
    behaviorId: subject.id,
    fullPractice: "Paint a tile.",
    smallerPractice: "Choose a color.",
    cadence: { kind: "every_waking_day" },
    slots: ["morning", "evening"],
    effectiveAt: f.now().toISOString(),
    threshold: 1,
  };
  return { ...f, registry, call, subject, habit };
}

test("agreement writes require matching complete payloads, retain shared evidence, and enforce pinned plus live scopes", async () => {
  const f = fixture(),
    source = f.accept("Let's make painting a tile a creative habit.");
  const args = {
    target: "habit",
    action: "save",
    habit: { ...f.habit, sourceIds: [source.sourceId] },
  };
  const saved = await f.call("agreement_write", args, source);
  expect(saved).toMatchObject({
    status: "succeeded",
    result: { habit: { behaviorId: f.subject.id, version: 1 } },
  });
  expect(await f.call("agreement_write", { ...args, note: {} }, source)).toMatchObject({
    status: "rejected",
    code: "invalid_arguments",
  });
  expect(
    await f.call("agreement_write", { ...args, habit: { ...args.habit, slots: [] } }, source),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  expect(
    await f.call("agreement_write", { ...args, habit: { ...args.habit, threshold: 0 } }, source),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  expect(await f.call("agreement_write", args, source, { turnKind: "heartbeat" })).toMatchObject({
    status: "rejected",
    code: "unavailable_tool",
  });
  f.agreements.saveSettings({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageHabits: false,
    allowValerieManageRules: true,
  });
  expect(await f.call("agreement_write", args, source)).toMatchObject({
    status: "rejected",
    code: "permission_denied",
  });
  const blocked = fixture(false),
    current = blocked.accept("Let's save a creative habit.");
  expect(
    await blocked.call(
      "agreement_write",
      {
        target: "habit",
        action: "save",
        habit: { ...blocked.habit, sourceIds: [current.sourceId] },
      },
      current,
    ),
  ).toMatchObject({ status: "rejected", code: "permission_denied" });
});

test("valid owner-authored rule and reminder fields can round-trip model edits, with exact current reminder versions", async () => {
  const f = fixture();
  const rule = f.agreements.saveRule(
    {
      name: "Allow honest feelings",
      meaning: "Painful disclosures are welcome.",
      reason: "Make room for honest connection.",
      scope: "a".repeat(350),
      effectiveAt: f.now().toISOString(),
      expiresAt: null,
      timezone: "America/Chicago",
      window: null,
      exceptions: [],
      condition: null,
    },
    { actor: "owner" },
  );
  const reminder = f.reminders.saveReminder(
    f.fields({ purpose: "", originalTimeIntent: "", dueAt: "2026-09-15T19:00:00.000Z" }),
    { actor: "owner" },
  );
  const source = f.accept(
    "Please rename the feelings rule and make the fern reminder a little later.",
  );
  const ruleResult = await f.call(
    "agreement_write",
    {
      target: "rule",
      action: "save",
      rule: {
        id: rule.id,
        expectedVersion: rule.version,
        name: "Welcome honest feelings",
        meaning: rule.meaning,
        reason: rule.reason,
        scope: rule.scope,
        effectiveAt: rule.effectiveAt,
        timezone: rule.timezone,
        exceptions: rule.exceptions,
        sourceIds: [source.sourceId],
      },
    },
    source,
  );
  expect(ruleResult).toMatchObject({
    status: "succeeded",
    result: { rule: { version: 2, scope: rule.scope } },
  });
  const input = {
    id: reminder.id,
    expectedVersion: reminder.version,
    title: reminder.title,
    purpose: "",
    originalTimeIntent: "",
    dueAt: "2026-09-15T19:30:00.000Z",
    timezone: reminder.timezone,
    allowFallback: true,
    sourceIds: [source.sourceId],
  };
  expect(await f.call("reminder_write", { action: "save", ...input }, source)).toMatchObject({
    status: "succeeded",
    result: { reminder: { version: 2, purpose: "", originalTimeIntent: "" } },
  });
  expect(await f.call("reminder_write", { action: "save", ...input }, source)).toMatchObject({
    status: "rejected",
    reason: "reminder_conflict",
  });
  expect(
    await f.call("reminder_write", { action: "save", ...input, title: "x".repeat(121) }, source),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
});

test("grouped focus writes preserve receipts and reject mixed actions or non-owner source evidence", async () => {
  const f = fixture(),
    source = f.accept("I want a creative focus for the next few weeks.");
  const input = {
    title: "Creative enjoyment",
    reason: "Enjoy making things.",
    startDate: "2026-09-15",
    reviewDate: "2026-10-27",
    practices: ["Notice an enjoyable moment."],
    indicators: [],
    sourceIds: [source.sourceId],
  };
  expect(await f.call("growth_focus_write", { action: "save", save: input }, source)).toMatchObject(
    { status: "succeeded" },
  );
  expect(
    await f.call("growth_focus_write", { action: "save", save: input, set_state: {} }, source),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  const foreign = f.accept("A request from another chat.", { chatId: "999" });
  expect(
    await f.call(
      "reminder_write",
      {
        action: "save",
        ...f.fields(),
        expiresAt: undefined,
        sourceIds: [foreign.sourceId],
      },
      source,
    ),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  const forwarded = f.accept("Please remind me to water a fern.", {
    metadata: {
      version: 1,
      provenance: "forwarded",
      quotedRanges: [],
      replyQuote: null,
      incomplete: false,
    },
  });
  expect(
    await f.call(
      "reminder_write",
      {
        action: "save",
        ...f.fields(),
        expiresAt: undefined,
        sourceIds: [forwarded.sourceId],
      },
      forwarded,
    ),
  ).toMatchObject({ status: "rejected", reason: "current_request_required" });
  expect(f.reminders.list()).toHaveLength(0);
});

test("opportunity evidence is bounded at every level and metric pages start with the newest period", async () => {
  const f = fixture();
  const habit = f.agreements.saveHabit(
    {
      ...f.habit,
      cadence: { kind: "every_waking_day" },
      slots: ["morning", "evening"],
      smallerPractice: null,
    },
    { actor: "owner" },
  );
  let dayId = "";
  for (let dayIndex = 0; dayIndex < 6; dayIndex++) {
    f.set(`2026-09-${15 + dayIndex}T18:00:00.000Z`);
    const current = f.daily.currentDay();
    const day = required(
      f.daily.recordWakingReport(
        {
          report: "day_start",
          mode: "current",
          expectedCurrentDayId: current?.id ?? null,
          expectedDayVersion: current?.version ?? null,
          occurred: { at: f.now().toISOString(), timezone: "America/Chicago", basis: "exact" },
          summary: "A new fictional waking day.",
        },
        { actor: "owner" },
      ).day,
    );
    dayId = day.id;
    f.agreements.opportunities(day.id);
    for (let i = 0; i < 20; i++) {
      f.advance(1000);
      f.daily.recordProgressReport(
        {
          behaviorId: f.subject.id,
          wakingDayId: day.id,
          occurred: { at: f.now().toISOString(), timezone: "America/Chicago", basis: "exact" },
          summary: `A distinct fictional practice ${i}.`,
          mode: "occurrence",
          value: 1,
        },
        { actor: "owner" },
      );
    }
  }
  const source = f.accept("Show my recent practice history.");
  const opportunities = await f.call(
    "daily_read",
    { mode: "opportunities", dayId, limit: 1 },
    source,
  );
  expect(opportunities.status).toBe("succeeded");
  const item = required(
    (
      opportunities.result as {
        items: {
          eventIds: string[];
          eventCount: number;
          progress: { eventIds: string[]; value: number };
        }[];
      }
    ).items[0],
  );
  expect(item.eventIds).toHaveLength(5);
  expect(item.progress.eventIds).toHaveLength(5);
  expect(item.eventCount).toBe(20);
  const metrics = await f.call(
    "daily_read",
    { mode: "habit_metrics", period: "day", limit: 2 },
    source,
  );
  expect(metrics.status).toBe("succeeded");
  expect((metrics.result as { periods: unknown[] }).periods).toEqual(
    f.agreements.metrics({ period: "day", habitId: habit.id }).periods.slice(0, 2),
  );
  expect(metrics.result).toMatchObject({ returnedPeriods: 2, omittedPeriods: 4 });
});

test("malformed model arguments receive fixed repair guidance without coercion or private-value echoes", async () => {
  const f = fixture(),
    source = f.accept("Please remind me about the fern.");
  const reminder = await f.call(
    "reminder_write",
    {
      action: "save",
      ...f.fields(),
      expiresAt: undefined,
      allowFallback: "true",
      sourceIds: "private-unvalidated-source",
    },
    source,
  );
  expect(reminder).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  expect(reminder.message).toContain("JSON boolean");
  expect(reminder.message).toContain("array");
  expect(reminder.message).not.toContain("private-unvalidated-source");
  expect(f.reminders.list()).toHaveLength(0);
  const corrected = await f.call(
    "reminder_write",
    {
      action: "save",
      ...f.fields(),
      expiresAt: undefined,
      allowFallback: true,
      sourceIds: [source.sourceId],
    },
    source,
  );
  expect(corrected.status).toBe("succeeded");
  const wrongNote = await f.call(
    "agreement_write",
    { target: "rule", action: "log_note", rule: { summary: "private-unvalidated-note" } },
    source,
  );
  expect(wrongNote.message).toContain("NOT rule");
  expect(wrongNote.message).toContain("ruleVersion");
  expect(wrongNote.message).not.toContain("private-unvalidated-note");
  const wrongFocus = await f.call(
    "growth_focus_write",
    {
      action: "set_state",
      id: "private-unvalidated-focus",
      expectedVersion: 1,
      state: "paused",
      sourceIds: [source.sourceId],
    },
    source,
  );
  expect(wrongFocus.message).toContain("set_state:{id,expectedVersion,state,sourceIds}");
  expect(wrongFocus.message).not.toContain("private-unvalidated-focus");
  for (const tool of [reminder, wrongNote, wrongFocus])
    expect(Buffer.byteLength(tool.message ?? "")).toBeLessThanOrEqual(1000);
});

test("habit save and read receipts expose the saved unit and target while numeric partial progress keeps its amount", async () => {
  const f = fixture(),
    subject = f.daily.saveBehavior(
      { name: "Sketching time", unit: "minutes", valueKind: "count" },
      { actor: "owner" },
    );
  const day = required(
    f.daily.recordWakingReport(
      {
        report: "day_start",
        mode: "current",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        occurred: { at: f.now().toISOString(), timezone: "America/Chicago", basis: "exact" },
        summary: "A fictional waking day.",
      },
      { actor: "owner" },
    ).day,
  );
  const source = f.accept(
    "Please make ten minutes of sketching the full practice, with a two-minute smaller version.",
  );
  const saved = await f.call(
    "agreement_write",
    {
      target: "habit",
      action: "save",
      habit: {
        ...f.habit,
        behaviorId: subject.id,
        fullPractice: "Sketch for ten minutes.",
        smallerPractice: "Sketch for two minutes.",
        threshold: 10,
        sourceIds: [source.sourceId],
      },
    },
    source,
  );
  expect(saved).toMatchObject({
    status: "succeeded",
    result: {
      measurement: { behaviorId: subject.id, unit: "minutes", valueKind: "count", fullTarget: 10 },
    },
  });
  const habitId = (saved.result as { habit: { id: string } }).habit.id;
  const listed = await f.call("daily_read", { mode: "habits" }, source);
  expect((listed.result as { items: unknown[] }).items).toContainEqual(
    expect.objectContaining({
      id: habitId,
      threshold: 10,
      fullPractice: "Sketch for ten minutes.",
      smallerPractice: "Sketch for two minutes.",
      behavior: {
        id: subject.id,
        version: subject.version,
        name: subject.name,
        unit: "minutes",
        valueKind: "count",
      },
    }),
  );
  expect(await f.call("daily_read", { mode: "habit", id: habitId }, source)).toMatchObject({
    status: "succeeded",
    result: { habit: { threshold: 10, behavior: { unit: "minutes", valueKind: "count" } } },
  });
  f.advance(1000);
  const progressSource = f.accept("I sketched for two minutes.");
  f.daily.saveSettings({
    expectedVersion: f.daily.getSettings().version,
    allowValerieManageWaking: true,
    allowValerieManageProgress: true,
  });
  const registry = createToolRegistry(
    f.store,
    createDailyTools(f.store, {
      now: f.now,
      permissions: { manageWaking: true, manageProgress: true },
    }),
  );
  const progress = await registry.execute(
    {
      id: "minutes",
      name: "daily_progress",
      arguments: JSON.stringify({
        action: "report",
        behaviorId: subject.id,
        wakingDayId: day.id,
        mode: "occurrence",
        value: 2,
        summary: "The owner reports two minutes of sketching.",
        sourceIds: [progressSource.sourceId],
      }),
    },
    {
      turnId: progressSource.turnId,
      operationKey: "two-minutes",
      signal: new AbortController().signal,
    },
    () => {},
  );
  expect(progress).toMatchObject({
    status: "succeeded",
    result: { event: { payload: { mode: "occurrence", value: 2 } } },
  });
  const opportunities = await f.call(
    "daily_read",
    { mode: "opportunities", dayId: day.id },
    progressSource,
  );
  expect((opportunities.result as { items: unknown[] }).items).toContainEqual(
    expect.objectContaining({
      habitId,
      threshold: 10,
      behavior: expect.objectContaining({ unit: "minutes", valueKind: "count" }),
      progress: expect.objectContaining({ value: 2 }),
      outcome: "partial",
    }),
  );
});
