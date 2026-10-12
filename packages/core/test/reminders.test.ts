import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckinCandidate,
  createConversationService,
  createDailyService,
  createReminderService,
  openStore,
  ReminderConflictError,
  type ReminderFields,
  type ScheduledClaim,
  type Store,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
const owner = { actor: "owner" as const };
const claimOptions = { chatId: "42", leaseOwner: "worker" };
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fictional record.");
  return value;
};
function fixture(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  let clock = new Date("2026-09-15T18:00:00.000Z"),
    update = 0;
  const now = () => new Date(clock),
    conversations = createConversationService(store, { now });
  conversations.acquireTelegramLease("worker", "2026-09-20T00:00:00.000Z");
  const reminders = createReminderService(store, { now });
  const fields = (changes: Partial<ReminderFields> = {}): ReminderFields => ({
    title: "Water the fictional fern",
    purpose: "Use a little water.",
    dueAt: new Date(clock.getTime() + 120000).toISOString(),
    timezone: "America/Chicago",
    originalTimeIntent: "In two minutes",
    expiresAt: null,
    allowFallback: true,
    ...changes,
  });
  const accept = (text = "Please remind me about the fictional fern.", chatId = "42") => {
    update++;
    conversations.acceptTelegramBatch({
      nextOffset: update + 1,
      inputs: [
        {
          updateId: update,
          messageId: String(update),
          chatId,
          senderId: chatId,
          text,
          receivedAt: clock.toISOString(),
          sourceMetadata: {
            version: 1,
            provenance: "original",
            quotedRanges: [],
            replyQuote: null,
            incomplete: false,
          },
        },
      ],
    });
    return required(
      store.db
        .query<{ id: string; turnId: string }, [number]>(
          "SELECT id,turn_id AS turnId FROM core_telegram_inputs WHERE update_id=?",
        )
        .get(update),
    );
  };
  const prepare = (claim: ScheduledClaim, text = "A little nudge to water your fern.") => {
    expect(reminders.setSnapshot(claim, { fictional: true })).toBe(true);
    const result = {
      text,
      finishReason: "stop",
      requestId: "fictional-receipt",
      usage: { inputTokens: 21, outputTokens: 10 },
    };
    expect(reminders.recordGenerationResult(claim, result)).toBe(true);
    expect(reminders.prepare(claim, { text })).toBe(true);
    return result;
  };
  return {
    store,
    conversations,
    reminders,
    fields,
    accept,
    prepare,
    now,
    set: (at: string) => {
      clock = new Date(at);
    },
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

function checkinFixture() {
  const f = fixture(),
    daily = createDailyService(f.store, { now: f.now });
  f.accept();
  f.store.db.query("UPDATE core_conversation_turns SET status='failed'").run();
  const day = required(
    daily.recordWakingReport(
      {
        report: "day_start",
        mode: "current",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        occurred: { at: null, basis: "message_time", timezone: "America/Chicago" },
        summary: "A fictional day starts.",
      },
      owner,
    ).day,
  );
  const settings = f.reminders.getCheckinSettings();
  f.reminders.saveCheckinSettings({
    ...settings,
    enabled: true,
    minIdleMinutes: 0,
    expectedVersion: settings.version,
  });
  const watermark = () =>
    f.store.db
      .query<{ value: number }, []>("SELECT max(rowid) AS value FROM core_telegram_inputs")
      .get()?.value ?? 0;
  const candidate = (changes: Partial<CheckinCandidate> = {}): CheckinCandidate => ({
    dayId: day.id,
    slots: ["morning"],
    questions: [{ key: "habit:fictional", title: "A small practice", detail: "Ask how it went." }],
    dailyRevision: daily.capture().revision,
    agreementRevision: "fictional:1",
    inputWatermark: watermark(),
    dueAt: f.now().toISOString(),
    earliestAt: f.now().toISOString(),
    expiresAt: new Date(f.now().getTime() + 3600000).toISOString(),
    timezone: "America/Chicago",
    ...changes,
  });
  const sync = (candidates: CheckinCandidate[]) =>
    f.reminders.syncCheckins({
      chatId: "42",
      candidates,
      dailyRevision: daily.capture().revision,
      agreementRevision: "fictional:1",
      inputWatermark: watermark(),
    });
  return { ...f, daily, day, candidate, sync };
}

test("explicit reminders prepare ahead, send once when due, and delivery does not complete the task", () => {
  const f = fixture(),
    r = f.reminders.saveReminder(f.fields(), owner);
  expect(f.reminders.claimPreparation(claimOptions)).toBeNull();
  f.advance(60000);
  const prep = required(f.reminders.claimPreparation(claimOptions));
  f.prepare(prep);
  expect(f.reminders.claimDelivery(claimOptions)).toBeNull();
  f.advance(60000);
  const send = required(f.reminders.claimDelivery(claimOptions));
  expect(send.usedFallback).toBe(false);
  expect(f.reminders.recordDelivery(send, { status: "sent", messageId: "901" })).toBe(true);
  expect(f.reminders.claimDelivery(claimOptions)).toBeNull();
  expect(f.reminders.read(r.id)?.state).toBe("active");
  const completed = f.reminders.complete(
    { id: r.id, expectedVersion: r.version, occurrenceId: send.id },
    owner,
  );
  expect(completed.state).toBe("completed");
  expect(f.reminders.readOccurrence(send.id)?.telegramMessageId).toBe("901");
});

test("snooze during generation preserves late evidence and only the new occurrence can send", () => {
  const f = fixture(),
    r = f.reminders.saveReminder(f.fields(), owner);
  f.advance(60000);
  const prep = required(f.reminders.claimPreparation(claimOptions));
  f.reminders.setSnapshot(prep, { fictional: true });
  const later = f.reminders.snooze(
    {
      id: r.id,
      expectedVersion: r.version,
      occurrenceId: prep.id,
      dueAt: "2026-09-15T18:10:00.000Z",
      originalTimeIntent: "Ten past six",
    },
    owner,
  );
  const result = {
    text: "An outdated prepared reminder.",
    finishReason: "stop",
    requestId: "late-receipt",
  };
  expect(f.reminders.recordGenerationResult(prep, result)).toBe(true);
  expect(f.reminders.prepare(prep, { text: result.text })).toBe(false);
  expect(f.reminders.readOccurrence(prep.id)?.status).toBe("cancelled");
  expect(f.reminders.generationReceipts(prep.id)[0]?.result).toMatchObject({
    requestId: "late-receipt",
  });
  expect(later.currentOccurrenceId).not.toBe(prep.id);
  expect(later.sources).toEqual(r.sources);
  f.set(later.dueAt);
  const send = required(f.reminders.claimDelivery(claimOptions));
  expect(send.id).toBe(later.currentOccurrenceId);
});

test("cancellation after a send begins retains the actual receipt without reviving the reminder", () => {
  const f = fixture(),
    r = f.reminders.saveReminder(f.fields({ dueAt: f.now().toISOString() }), owner);
  const send = required(f.reminders.claimDelivery(claimOptions));
  f.reminders.cancel({ id: r.id, expectedVersion: r.version }, owner);
  expect(f.reminders.recordDelivery(send, { status: "sent", messageId: "902" })).toBe(true);
  expect(f.reminders.read(r.id)?.state).toBe("cancelled");
  expect(f.reminders.readOccurrence(send.id)?.status).toBe("sent");
  expect(f.reminders.claimDelivery(claimOptions)).toBeNull();
});

test("due-time fallback is saved policy and a late generation cannot replace its delivered words", () => {
  const f = fixture(),
    r = f.reminders.saveReminder(f.fields(), owner);
  f.advance(60000);
  const prep = required(f.reminders.claimPreparation(claimOptions));
  f.reminders.setSnapshot(prep, { fictional: true });
  f.set(r.dueAt);
  const send = required(f.reminders.claimDelivery(claimOptions));
  expect(send.usedFallback).toBe(true);
  expect(send.text).toContain(r.title);
  f.reminders.recordDelivery(send, { status: "sent", messageId: "903" });
  const result = {
    text: "Different late words.",
    finishReason: "stop",
    requestId: "late-after-fallback",
  };
  expect(f.reminders.recordGenerationResult(prep, result)).toBe(true);
  expect(f.reminders.readOccurrence(send.id)?.text).toBe(send.text);
  expect(f.reminders.generationReceipts(prep.id)[0]?.result.requestId).toBe("late-after-fallback");
  const noFallback = f.reminders.saveReminder(
    f.fields({ dueAt: f.now().toISOString(), allowFallback: false }),
    owner,
  );
  expect(f.reminders.claimDelivery(claimOptions)).toBeNull();
  expect(f.reminders.readOccurrence(noFallback.currentOccurrenceId)?.text).toBeNull();
});

test("definitive throttling retries the same immutable text; ambiguous sends require a new owner schedule", () => {
  const f = fixture(),
    r = f.reminders.saveReminder(f.fields({ dueAt: f.now().toISOString() }), owner);
  const first = required(f.reminders.claimDelivery(claimOptions));
  f.reminders.recordDelivery(first, {
    status: "retry",
    code: "rate_limited",
    retryAt: "2026-09-15T18:01:00.000Z",
  });
  expect(f.reminders.claimDelivery(claimOptions)).toBeNull();
  f.advance(60000);
  const retry = required(f.reminders.claimDelivery(claimOptions));
  expect(retry.id).toBe(first.id);
  expect(retry.text).toBe(first.text);
  expect(retry.attempts).toBe(2);
  f.reminders.recordDelivery(retry, { status: "unknown", code: "network" });
  expect(f.reminders.claimDelivery(claimOptions)).toBeNull();
  expect(() =>
    f.reminders.retryFailed(
      { id: r.id, expectedVersion: r.version, occurrenceId: first.id },
      owner,
    ),
  ).toThrow("Unknown sends");
  const next = f.reminders.snooze(
    {
      id: r.id,
      expectedVersion: r.version,
      occurrenceId: first.id,
      dueAt: "2026-09-15T18:10:00.000Z",
      originalTimeIntent: "Later",
    },
    owner,
  );
  expect(next.currentOccurrenceId).not.toBe(first.id);
  expect(f.reminders.readOccurrence(first.id)?.status).toBe("unknown");
});

test("lease loss and restart never replay an interrupted send", () => {
  const f = fixture(),
    r = f.reminders.saveReminder(f.fields({ dueAt: f.now().toISOString() }), owner);
  expect(f.reminders.claimDelivery({ ...claimOptions, leaseOwner: "stranger" })).toBeNull();
  const send = required(f.reminders.claimDelivery(claimOptions));
  f.conversations.releaseTelegramLease("worker");
  f.conversations.acquireTelegramLease("replacement", "2026-09-20T00:00:00.000Z");
  f.reminders.recoverInterrupted("replacement");
  expect(f.reminders.readOccurrence(r.currentOccurrenceId)?.status).toBe("unknown");
  expect(f.reminders.claimDelivery({ chatId: "42", leaseOwner: "replacement" })).toBeNull();
  expect(f.reminders.recordDelivery(send, { status: "sent", messageId: "904" })).toBe(true);
  expect(f.reminders.readOccurrence(send.id)?.status).toBe("sent");
  expect(f.reminders.claimDelivery({ chatId: "42", leaseOwner: "replacement" })).toBeNull();
  const receipt = f.store.db
    .query<{ outcome_json: string; late_receipt_json: string }, []>(
      "SELECT outcome_json,late_receipt_json FROM core_scheduled_deliveries",
    )
    .get();
  expect(JSON.parse(required(receipt).outcome_json).status).toBe("unknown");
  expect(JSON.parse(required(receipt).late_receipt_json).messageId).toBe("904");
});

test("saved reminders and preparation fallback survive a reopened database", () => {
  const dir = mkdtempSync(join(tmpdir(), "valerie-reminder-test-"));
  directories.push(dir);
  const path = join(dir, "state.sqlite"),
    f = fixture(path);
  const r = f.reminders.saveReminder(f.fields(), owner);
  f.advance(60000);
  required(f.reminders.claimPreparation(claimOptions));
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const next = fixture(path);
  next.set(r.dueAt);
  next.reminders.recoverInterrupted("worker");
  const send = required(next.reminders.claimDelivery(claimOptions));
  expect(send.id).toBe(r.currentOccurrenceId);
  expect(send.usedFallback).toBe(true);
});

test("model writes require current owner evidence, pinned and live permission, and stable operation receipts", () => {
  const f = fixture(),
    input = f.accept();
  f.reminders.savePermissions({ expectedVersion: 1, allowValerieManageReminders: true });
  const context = {
    actor: "valerie" as const,
    turnId: input.turnId,
    operationKey: "fictional-operation",
    permissions: { manageReminders: true },
  };
  const fields = { ...f.fields(), sourceIds: [`conversation:${input.id}`] };
  const r = f.reminders.saveReminder(fields, context);
  expect(f.reminders.saveReminder(fields, context)).toEqual(r);
  expect(f.reminders.list()).toHaveLength(1);
  expect(() =>
    f.reminders.saveReminder(fields, {
      ...context,
      operationKey: "another",
      permissions: { manageReminders: false },
    }),
  ).toThrow();
  const elsewhere = f.accept("Please remind me somewhere else.", "99");
  expect(() =>
    f.reminders.saveReminder(
      { ...fields, sourceIds: [`conversation:${elsewhere.id}`] },
      { ...context, operationKey: "wrong-source" },
    ),
  ).toThrow();
  f.reminders.savePermissions({ expectedVersion: 2, allowValerieManageReminders: false });
  expect(() => f.reminders.saveReminder(fields, context)).toThrow();
});

test("optimistic changes and occurrence-scoped snooze cannot affect a newer schedule", () => {
  const f = fixture(),
    r = f.reminders.saveReminder(f.fields(), owner);
  const next = f.reminders.snooze(
    {
      id: r.id,
      expectedVersion: r.version,
      occurrenceId: r.currentOccurrenceId,
      dueAt: "2026-09-15T18:15:00.000Z",
      originalTimeIntent: "Quarter past",
    },
    owner,
  );
  expect(() =>
    f.reminders.complete(
      { id: r.id, expectedVersion: next.version, occurrenceId: r.currentOccurrenceId },
      owner,
    ),
  ).toThrow(ReminderConflictError);
  expect(() => f.reminders.cancel({ id: r.id, expectedVersion: r.version }, owner)).toThrow(
    ReminderConflictError,
  );
  expect(f.reminders.read(r.id)?.currentOccurrenceId).toBe(next.currentOccurrenceId);
});

test("old active commitments and their occurrences stay visible ahead of recent closed history", () => {
  const f = fixture(),
    old = f.reminders.saveReminder(f.fields(), owner);
  for (let i = 0; i < 8; i++) {
    const r = f.reminders.saveReminder(
      f.fields({ title: `Closed fictional reminder ${i}` }),
      owner,
    );
    f.reminders.cancel({ id: r.id, expectedVersion: r.version }, owner);
  }
  const view = f.reminders.overview({ limit: 3 });
  expect(view.reminders[0]?.id).toBe(old.id);
  expect(view.occurrences.some((o) => o.id === old.currentOccurrenceId)).toBe(true);
  expect(view.occurrences.every((o) => o.snapshot === null)).toBe(true);
});

test("optional slots coalesce, respect independent pauses, and preserve coverage across day merges", () => {
  const f = fixture(),
    daily = createDailyService(f.store, { now: f.now });
  f.accept();
  f.store.db.query("UPDATE core_conversation_turns SET status='failed'").run();
  const day = required(
    daily.recordWakingReport(
      {
        report: "day_start",
        mode: "current",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        occurred: { at: null, basis: "message_time", timezone: "America/Chicago" },
        summary: "A fictional day starts.",
      },
      owner,
    ).day,
  );
  const settings = f.reminders.getCheckinSettings();
  f.reminders.saveCheckinSettings({
    ...settings,
    enabled: true,
    minIdleMinutes: 0,
    expectedVersion: settings.version,
  });
  const candidate = {
    dayId: day.id,
    slots: ["morning", "evening"] as ("morning" | "evening")[],
    questions: [{ key: "habit:fictional", title: "A small practice", detail: "Ask how it went." }],
    dailyRevision: daily.capture().revision,
    agreementRevision: "fictional:1",
    inputWatermark: 1,
    dueAt: f.now().toISOString(),
    earliestAt: f.now().toISOString(),
    expiresAt: "2026-09-15T19:00:00.000Z",
    timezone: "America/Chicago",
  };
  const sync = () =>
    f.reminders.syncCheckins({
      chatId: "42",
      candidates: [candidate],
      dailyRevision: candidate.dailyRevision,
      agreementRevision: candidate.agreementRevision,
      inputWatermark: 1,
    });
  sync();
  sync();
  expect(f.reminders.listOccurrences()).toHaveLength(1);
  const prep = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  f.prepare(prep, "How did your small practice feel?");
  const send = required(f.reminders.claimDelivery({ ...claimOptions, kind: "checkin" }));
  f.reminders.recordDelivery(send, { status: "sent", messageId: "910" });
  sync();
  expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).toBeNull();
  expect(f.store.db.query("SELECT closed FROM core_checkin_slots").all()).toEqual([
    { closed: 1 },
    { closed: 1 },
  ]);
  f.advance(1000);
  const second = required(
    daily.recordWakingReport(
      {
        report: "day_start",
        mode: "current",
        expectedCurrentDayId: day.id,
        expectedDayVersion: day.version,
        occurred: { at: null, basis: "message_time", timezone: "America/Chicago" },
        summary: "A duplicate fictional day.",
      },
      owner,
    ).day,
  );
  daily.mergeDays(
    {
      fromId: day.id,
      expectedFromVersion: 2,
      intoId: second.id,
      expectedIntoVersion: second.version,
    },
    owner,
  );
  candidate.dayId = second.id;
  candidate.dailyRevision = daily.capture().revision;
  sync();
  expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).toBeNull();
});

test("overlapping check-in candidates are rejected atomically instead of keeping orphan deliveries", () => {
  const f = checkinFixture();
  expect(() =>
    f.sync([f.candidate({ slots: ["morning", "evening"] }), f.candidate({ slots: ["morning"] })]),
  ).toThrow("each canonical day/slot only once");
  expect(f.reminders.listOccurrences()).toEqual([]);
  expect(f.store.db.query("SELECT day_id FROM core_checkin_slots").all()).toEqual([]);
  expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).toBeNull();
});

test("an orphaned prepared check-in and a newly covered generating slot cannot deliver", () => {
  const f = checkinFixture();
  f.sync([f.candidate()]);
  const prep = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  f.prepare(prep, "How did the small practice go?");
  f.store.db
    .query("UPDATE core_checkin_slots SET occurrence_id=NULL WHERE occurrence_id=?")
    .run(prep.id);
  expect(f.reminders.claimDelivery({ ...claimOptions, kind: "checkin" })).toBeNull();
  expect(f.reminders.readOccurrence(prep.id)).toMatchObject({
    status: "suppressed",
    reason: "checkin_slot_changed",
  });
  const g = checkinFixture();
  g.sync([g.candidate()]);
  const pending = required(g.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  g.reminders.setSnapshot(pending, { fictional: true });
  g.store.db.query("UPDATE core_checkin_slots SET closed=1 WHERE occurrence_id=?").run(pending.id);
  const result = {
    text: "A stale question.",
    finishReason: "stop",
    requestId: "late-covered-slot",
  };
  expect(g.reminders.recordGenerationResult(pending, result)).toBe(true);
  expect(g.reminders.prepare(pending, { text: result.text })).toBe(false);
  expect(g.reminders.readOccurrence(pending.id)?.text).toBeNull();
  expect(g.reminders.claimDelivery({ ...claimOptions, kind: "checkin" })).toBeNull();
});

test("splitting a queued coalesced check-in preserves separate slot ownership and coverage", () => {
  const f = checkinFixture();
  f.sync([f.candidate({ slots: ["morning", "evening"] })]);
  const original = required(f.reminders.listOccurrences()[0]);
  f.sync([
    f.candidate({ slots: ["morning"], expiresAt: "2026-09-15T18:20:00.000Z" }),
    f.candidate({
      slots: ["evening"],
      earliestAt: "2026-09-15T18:30:00.000Z",
      dueAt: "2026-09-15T18:30:00.000Z",
      questions: [
        { key: "habit:evening", title: "Evening practice", detail: "Ask about the evening." },
      ],
    }),
  ]);
  const pending = f.reminders.listOccurrences().filter((run) => run.status === "scheduled");
  expect(pending).toHaveLength(2);
  expect(new Set(pending.map((run) => run.id)).size).toBe(2);
  expect(f.reminders.readOccurrence(original.id)?.status).toBe("suppressed");
  const prep = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  expect(prep.checkin?.slots).toEqual(["morning"]);
  f.prepare(prep, "How was the morning practice?");
  const send = required(f.reminders.claimDelivery({ ...claimOptions, kind: "checkin" }));
  f.reminders.recordDelivery(send, { status: "sent", messageId: "991" });
  expect(
    f.store.db.query("SELECT slot,closed FROM core_checkin_slots ORDER BY slot").all(),
  ).toEqual([
    { slot: "evening", closed: 0 },
    { slot: "morning", closed: 1 },
  ]);
  f.advance(30 * 60000);
  const evening = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  expect(evening.checkin?.slots).toEqual(["evening"]);
});

test("a stale silence result cannot close the current day's still-open check-in slot", () => {
  const f = checkinFixture();
  f.sync([f.candidate()]);
  const claim = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  f.reminders.setSnapshot(claim, { fictional: true });
  f.accept("I have new context for you.");
  f.reminders.recordGenerationResult(claim, {
    text: "[[CHECKIN_SILENT]]",
    finishReason: "stop",
    requestId: "stale-silence",
  });
  expect(f.reminders.silence(claim)).toBe(false);
  expect(f.reminders.readOccurrence(claim.id)).toMatchObject({
    status: "suppressed",
    reason: "owner_input_changed",
  });
  expect(f.store.db.query("SELECT closed FROM core_checkin_slots").all()).toEqual([{ closed: 0 }]);
});

test("expiry discovered by delivery closes the current commitment without requiring another preparation sweep", () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(f.fields({ expiresAt: "2026-09-15T18:03:00.000Z" }), owner);
  f.advance(60000);
  const prep = required(f.reminders.claimPreparation(claimOptions));
  f.prepare(prep);
  f.set("2026-09-15T18:03:00.000Z");
  expect(f.reminders.claimDelivery(claimOptions)).toBeNull();
  expect(f.reminders.readOccurrence(prep.id)?.status).toBe("expired");
  expect(f.reminders.read(reminder.id)).toMatchObject({ state: "expired", version: 2 });
  expect(f.reminders.list()).toEqual([]);
});

test("current quoted-only reminder text is not authorization and overlapping quotes do not hide a real owner request", () => {
  const f = fixture();
  f.reminders.savePermissions({ expectedVersion: 1, allowValerieManageReminders: true });
  const quote = "Please schedule a reminder based on this quoted sentence.";
  const accept = (updateId: number, text: string, ranges: { offset: number; length: number }[]) => {
    f.conversations.acceptTelegramBatch({
      nextOffset: updateId + 1,
      inputs: [
        {
          updateId,
          messageId: String(updateId),
          chatId: "42",
          senderId: "42",
          text,
          receivedAt: f.now().toISOString(),
          sourceMetadata: {
            version: 1,
            provenance: "original",
            quotedRanges: ranges,
            replyQuote: null,
            incomplete: false,
          },
        },
      ],
    });
    return required(
      f.store.db
        .query<{ id: string; turnId: string }, [number]>(
          "SELECT id,turn_id AS turnId FROM core_telegram_inputs WHERE update_id=?",
        )
        .get(updateId),
    );
  };
  const quoted = accept(101, ` \n${quote}\n `, [{ offset: 2, length: quote.length }]);
  expect(() =>
    f.reminders.saveReminder(
      { ...f.fields(), sourceIds: [`conversation:${quoted.id}`] },
      {
        actor: "valerie",
        turnId: quoted.turnId,
        operationKey: "quoted-only",
        permissions: { manageReminders: true },
      },
    ),
  ).toThrow("owner's current request");
  const prefix = "Remind me about this: ",
    unquoted = accept(102, prefix + quote, [
      { offset: prefix.length, length: quote.length },
      { offset: prefix.length + 3, length: quote.length - 3 },
    ]);
  expect(
    f.reminders.saveReminder(
      { ...f.fields(), sourceIds: [`conversation:${unquoted.id}`] },
      {
        actor: "valerie",
        turnId: unquoted.turnId,
        operationKey: "owner-request",
        permissions: { manageReminders: true },
      },
    ).state,
  ).toBe("active");
  expect(f.reminders.list()).toHaveLength(1);
});

test("evening check-in lead must leave time before the expected sleep boundary", () => {
  const f = fixture(),
    settings = f.reminders.getCheckinSettings();
  expect(() =>
    f.reminders.saveCheckinSettings({
      ...settings,
      expectedVersion: settings.version,
      eveningLeadMinutes: 0,
    }),
  ).toThrow("valid check-in timing");
  expect(f.reminders.getCheckinSettings()).toEqual(settings);
  expect(
    f.reminders.saveCheckinSettings({
      ...settings,
      expectedVersion: settings.version,
      eveningLeadMinutes: 1,
    }).eveningLeadMinutes,
  ).toBe(1);
});

test("a new future owner sleep plan may reopen an expired unsent evening while retaining its attempt history", () => {
  const f = checkinFixture();
  const plan = (
    expectedSleepAt: string | null,
    basis: "owner_plan" | "usual_routine" | "none" = "owner_plan",
  ) => {
    const day = required(f.daily.currentDay());
    return f.daily.recordWakingReport(
      {
        report: "sleep_plan",
        mode: "current",
        expectedCurrentDayId: day.id,
        expectedDayVersion: day.version,
        occurred: { at: null, basis: "message_time", timezone: "America/Chicago" },
        summary: "A fictional sleep plan update.",
        expectedSleepAt,
        sleepEstimateBasis: basis,
      },
      owner,
    );
  };
  const firstPlan = plan("2026-09-15T18:05:00.000Z");
  f.sync([f.candidate({ slots: ["evening"], expiresAt: "2026-09-15T18:05:00.000Z" })]);
  const original = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  expect(original.checkin?.sleepPlanEventId).toBe(firstPlan.event?.id);
  f.set("2026-09-15T18:06:00.000Z");
  f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" });
  expect(f.reminders.readOccurrence(original.id)?.status).toBe("expired");
  const behavior = f.daily.saveBehavior(
    { name: "Unrelated fictional report", unit: "report", valueKind: "status" },
    owner,
  );
  f.daily.recordProgressReport(
    {
      behaviorId: behavior.id,
      wakingDayId: f.day.id,
      occurred: { at: f.now().toISOString(), basis: "message_time", timezone: "America/Chicago" },
      summary: "Unrelated progress.",
      mode: "status",
      status: "partial",
    },
    owner,
  );
  f.sync([f.candidate({ slots: ["evening"], expiresAt: "2026-09-15T19:00:00.000Z" })]);
  expect(f.store.db.query("SELECT closed FROM core_checkin_slots").all()).toEqual([{ closed: 1 }]);
  plan(null, "none");
  plan("2026-09-15T19:00:00.000Z", "usual_routine");
  f.sync([f.candidate({ slots: ["evening"], expiresAt: "2026-09-15T19:00:00.000Z" })]);
  expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).toBeNull();
  expect(f.store.db.query("SELECT closed FROM core_checkin_slots").all()).toEqual([{ closed: 1 }]);
  f.set("2026-09-15T18:20:00.000Z");
  const newPlan = plan("2026-09-15T19:00:00.000Z");
  f.sync([f.candidate({ slots: ["evening"], expiresAt: "2026-09-15T19:00:00.000Z" })]);
  expect(f.store.db.query("SELECT closed,attempts FROM core_checkin_slots").all()).toEqual([
    { closed: 0, attempts: 1 },
  ]);
  const replacement = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  expect(replacement.id).not.toBe(original.id);
  expect(replacement.checkin?.sleepPlanEventId).toBe(newPlan.event?.id);
  expect(f.reminders.readOccurrence(original.id)?.status).toBe("expired");
  expect(f.store.db.query("SELECT attempts FROM core_checkin_slots").all()).toEqual([
    { attempts: 2 },
  ]);
});

test("a later sleep plan never reopens sent, uncertain-delivery or deliberately silent evening slots", () => {
  for (const status of ["sent", "unknown", "silent"] as const) {
    const f = checkinFixture();
    const plan = (expectedSleepAt: string) => {
      const day = required(f.daily.currentDay());
      f.daily.recordWakingReport(
        {
          report: "sleep_plan",
          mode: "current",
          expectedCurrentDayId: day.id,
          expectedDayVersion: day.version,
          occurred: { at: null, basis: "message_time", timezone: "America/Chicago" },
          summary: "An owner sleep plan.",
          expectedSleepAt,
          sleepEstimateBasis: "owner_plan",
        },
        owner,
      );
    };
    plan("2026-09-15T18:05:00.000Z");
    f.sync([f.candidate({ slots: ["evening"], expiresAt: "2026-09-15T18:05:00.000Z" })]);
    const prep = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
    if (status === "silent") {
      f.reminders.setSnapshot(prep, { fictional: true });
      f.reminders.recordGenerationResult(prep, {
        text: "[[CHECKIN_SILENT]]",
        finishReason: "stop",
        requestId: "quiet-fixture",
      });
      expect(f.reminders.silence(prep)).toBe(true);
    } else {
      f.prepare(prep, "A brief evening question.");
      const send = required(f.reminders.claimDelivery({ ...claimOptions, kind: "checkin" }));
      f.reminders.recordDelivery(
        send,
        status === "sent"
          ? { status: "sent", messageId: "998" }
          : { status: "unknown", code: "fictional_network" },
      );
    }
    f.set("2026-09-15T18:20:00.000Z");
    plan("2026-09-15T19:00:00.000Z");
    f.sync([f.candidate({ slots: ["evening"], expiresAt: "2026-09-15T19:00:00.000Z" })]);
    expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).toBeNull();
    expect(f.store.db.query("SELECT closed FROM core_checkin_slots").all()).toEqual([
      { closed: 1 },
    ]);
    expect(f.reminders.listOccurrences()).toHaveLength(1);
  }
});

test("the third allowed check-in preparation can finish through unchanged synchronization", () => {
  const f = checkinFixture(),
    candidate = f.candidate();
  for (let attempt = 0; attempt < 2; attempt++) {
    f.sync([candidate]);
    const prep = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
    f.reminders.failPreparation(prep, "fictional_provider_failure");
    f.advance(15 * 60000);
  }
  f.sync([candidate]);
  const third = required(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" }));
  expect(f.store.db.query("SELECT attempts FROM core_checkin_slots").get()).toEqual({
    attempts: 3,
  });
  f.sync([candidate]);
  expect(f.reminders.readOccurrence(third.id)?.status).toBe("generating");
  f.prepare(third, "How did the small practice go?");
  f.sync([candidate]);
  expect(f.reminders.readOccurrence(third.id)?.status).toBe("prepared");
  const send = required(f.reminders.claimDelivery({ ...claimOptions, kind: "checkin" }));
  expect(send.id).toBe(third.id);
  f.reminders.recordDelivery(send, { status: "sent", messageId: "999" });
  expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).toBeNull();
});

test("confirmed scheduled delivery spaces optional check-ins without delaying another explicit reminder", () => {
  const f = checkinFixture(),
    settings = f.reminders.getCheckinSettings();
  f.reminders.saveCheckinSettings({
    ...settings,
    expectedVersion: settings.version,
    minIdleMinutes: 15,
  });
  f.advance(20 * 60000);
  f.sync([f.candidate()]);
  f.reminders.saveReminder(f.fields({ dueAt: f.now().toISOString() }), owner);
  const first = required(f.reminders.claimDelivery({ ...claimOptions, kind: "explicit_reminder" }));
  f.reminders.recordDelivery(first, { status: "sent", messageId: "1001" });
  expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).toBeNull();
  f.reminders.saveReminder(
    f.fields({ title: "Another explicit commitment", dueAt: f.now().toISOString() }),
    owner,
  );
  const second = required(
    f.reminders.claimDelivery({ ...claimOptions, kind: "explicit_reminder" }),
  );
  f.reminders.recordDelivery(second, { status: "sent", messageId: "1002" });
  f.advance(15 * 60000 - 1);
  expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).toBeNull();
  f.advance(1);
  expect(f.reminders.claimPreparation({ ...claimOptions, kind: "checkin" })).not.toBeNull();
});
