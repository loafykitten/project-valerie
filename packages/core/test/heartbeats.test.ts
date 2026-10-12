import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgreementService,
  createConversationService,
  createDailyService,
  createDynamicService,
  createHeartbeatService,
  type HeartbeatRun,
  type HeartbeatSettings,
  HeartbeatSettingsConflictError,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const worker = { chatId: "123", leaseOwner: "test-worker" };
const receipt = { status: "delivered" as const, telegramMessageId: "987" };

test("rule expiry invalidates prepared warmth even without a new edit or owner message", () => {
  const f = ready();
  let clock = new Date("2026-09-15T15:00:00.000Z");
  const agreements = createAgreementService(f.store, { now: () => clock });
  agreements.saveRule(
    {
      name: "A temporary fictional break",
      meaning: "Take a short agreed break from the fictional feed.",
      reason: "Make room for a project.",
      scope: "This temporary agreement.",
      effectiveAt: clock.toISOString(),
      expiresAt: "2026-09-15T16:00:00.000Z",
      timezone: "America/Chicago",
      window: null,
      exceptions: [],
      condition: null,
    },
    { actor: "owner" },
  );
  const run = f.due();
  if (!run) throw new Error("Expected heartbeat opportunity.");
  clock = new Date(run.createdAt);
  expect(agreements.capture().rules).toHaveLength(1);
  f.heartbeats.setSnapshot(run, { agreementRevision: agreements.capture().revision });
  expect(
    f.heartbeats.prepare(run, { text: "A little encouragement with your agreed break." }),
  ).toBe(true);
  clock = new Date("2026-09-15T16:00:00.000Z");
  f.setTime(clock.toISOString());
  expect(agreements.capture().rules).toHaveLength(0);
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  expect(f.heartbeats.getRun(run.id)?.reason).toBe("agreements_changed");
});

test("a dashboard waking update invalidates prepared warmth without needing a new Telegram input", () => {
  const f = ready();
  let clock = new Date("2026-09-15T13:00:00.000Z");
  const daily = createDailyService(f.store, { now: () => clock });
  const initial = daily.recordWakingReport(
    {
      report: "main_wake",
      mode: "current",
      expectedCurrentDayId: null,
      expectedDayVersion: null,
      occurred: { at: null, timezone: "America/Chicago", basis: "message_time" },
      summary: "A fictional waking update.",
    },
    { actor: "owner" },
  );
  if (!initial.day) throw new Error("Expected waking day.");
  const run = f.due();
  if (!run) throw new Error("Expected heartbeat opportunity.");
  clock = new Date(run.createdAt);
  f.heartbeats.setSnapshot(run, { daily: { revision: daily.capture().revision } });
  expect(f.heartbeats.prepare(run, { text: "Sending you a little warmth." })).toBe(true);
  daily.recordWakingReport(
    {
      report: "main_sleep_intent",
      mode: "current",
      expectedCurrentDayId: initial.day.id,
      expectedDayVersion: initial.day.version,
      occurred: { at: null, timezone: "America/Chicago", basis: "message_time" },
      summary: "A fictional plan to sleep.",
    },
    { actor: "owner" },
  );
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  expect(f.heartbeats.getRun(run.id)?.reason).toBe("daily_records_changed");
});

test("a changed growth focus suppresses an already prepared heartbeat", () => {
  const f = ready();
  const dynamic = createDynamicService(f.store, {
    now: () => new Date("2026-09-15T13:00:00.000Z"),
  });
  const focus = dynamic.saveFocus(
    {
      title: "Enjoying creativity",
      reason: "Make space for ordinary enjoyment.",
      startDate: "2026-09-15",
      reviewDate: "2026-10-27",
      practices: ["Try a small sketch."],
      indicators: [],
    },
    { actor: "owner" },
  );
  const run = f.due();
  if (!run) throw new Error("Expected heartbeat opportunity.");
  f.heartbeats.setSnapshot(run, { dynamic: dynamic.capture() });
  expect(f.heartbeats.prepare(run, { text: "A little creative spark for your day." })).toBe(true);
  dynamic.setFocusState(
    { id: focus.id, expectedVersion: focus.version, state: "paused" },
    { actor: "owner" },
  );
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  expect(f.heartbeats.getRun(run.id)?.reason).toBe("growth_focus_changed");
});

function fixture(path = ":memory:", random = 0) {
  const store = openStore(path);
  stores.push(store);
  let clock = new Date("2026-09-15T13:00:00.000Z");
  const conversations = createConversationService(store, { now: () => clock });
  const settings = conversations.getSettings();
  if (!settings.model)
    conversations.saveSettings({
      ...settings,
      model: "fictional-model",
      expectedVersion: settings.version,
    });
  const heartbeats = createHeartbeatService(store, { now: () => clock, random: () => random });
  const setTime = (time: string) => {
    clock = new Date(time);
  };
  let inputId = 0;
  function accept(receivedAt = clock.toISOString()) {
    inputId += 1;
    conversations.acceptTelegramBatch({
      nextOffset: inputId + 1,
      inputs: [
        {
          updateId: inputId,
          messageId: String(inputId),
          chatId: "123",
          senderId: "123",
          text: "I enjoyed my fictional game today.",
          receivedAt,
        },
      ],
    });
  }
  function reply() {
    const turn = conversations.startNextTurn();
    if (!turn) throw new Error("Missing ordinary test turn.");
    conversations.completeGeneration(turn.id, {
      text: "A lengthy and warm fictional ordinary reply.",
    });
    const delivery = conversations.claimDelivery();
    if (!delivery) throw new Error("Missing ordinary test delivery.");
    conversations.recordDelivery(delivery.id, { status: "sent", messageId: "1234" });
  }
  function save(fields: Partial<HeartbeatSettings> = {}) {
    const current = heartbeats.getSettings();
    return heartbeats.saveSettings({ ...current, ...fields, expectedVersion: current.version });
  }
  function enable(fields: Partial<HeartbeatSettings> = {}) {
    return save({
      enabled: true,
      activeStart: "12:00",
      activeEnd: "12:00",
      minIntervalMinutes: 30,
      maxIntervalMinutes: 30,
      minIdleMinutes: 15,
      ...fields,
    });
  }
  function due() {
    const next = heartbeats.getStatus("123").nextOpportunityAt;
    if (!next) throw new Error("No scheduled heartbeat test opportunity.");
    setTime(next);
    return heartbeats.claimOpportunity(worker);
  }
  function prepare(
    run: HeartbeatRun | null,
    text = "Thinking of your latest adventure. I'd love to hear how it went.",
  ) {
    if (!run) throw new Error("Missing heartbeat test run.");
    expect(
      heartbeats.setSnapshot(run, { capturedAt: clock.toISOString(), fictionalContext: true }),
    ).toBe(true);
    expect(
      heartbeats.prepare(run, {
        text,
        requestId: "fictional-provider-receipt",
        usage: { inputTokens: 17, outputTokens: 14 },
        costUsd: null,
      }),
    ).toBe(true);
    return run;
  }
  function send(run: HeartbeatRun | null) {
    prepare(run);
    const delivery = heartbeats.claimDelivery(worker);
    if (!delivery) throw new Error("Missing heartbeat delivery.");
    expect(heartbeats.recordDelivery(delivery, receipt)).toBe(true);
    return delivery;
  }
  conversations.acquireTelegramLease(worker.leaseOwner, "2027-12-01T00:00:00.000Z");
  return {
    store,
    heartbeats,
    conversations,
    setTime,
    accept,
    reply,
    save,
    enable,
    due,
    prepare,
    send,
  };
}

function ready(path = ":memory:", random = 0) {
  const f = fixture(path, random);
  f.accept();
  f.reply();
  f.setTime("2026-09-15T15:00:00.000Z");
  f.enable();
  return f;
}

test("heartbeat settings start disabled, validate scheduling, and retain optimistic revisions", () => {
  const f = fixture();
  expect(f.heartbeats.getSettings()).toMatchObject({
    enabled: false,
    maxPerDay: 2,
    maxUnanswered: 2,
    maxMessageChars: 480,
  });
  expect(f.heartbeats.claimOpportunity(worker)).toBeNull();
  expect(f.heartbeats.getStatus(null)).toMatchObject({
    blockingReason: "disabled",
    nextOpportunityAt: null,
  });
  const old = f.heartbeats.getSettings();
  f.enable();
  expect(f.heartbeats.getStatus(null).blockingReason).toBe("no_owner_chat");
  expect(() => f.heartbeats.saveSettings({ ...old, expectedVersion: old.version })).toThrow(
    HeartbeatSettingsConflictError,
  );
  expect(() => f.save({ timezone: "Imaginary/Nowhere" })).toThrow(TypeError);
  expect(() => f.save({ activeStart: "24:00" })).toThrow(TypeError);
  expect(() => f.save({ minIntervalMinutes: 31, maxIntervalMinutes: 30 })).toThrow(TypeError);
  expect(() => f.save({ maxPerDay: 9 })).toThrow(TypeError);
  expect(() =>
    f.store.db.exec(
      "UPDATE core_heartbeat_settings_revisions SET settings_json='{}' WHERE version=1",
    ),
  ).toThrow("immutable");
  expect(f.heartbeats.recentRuns()).toEqual([]);
});

test("randomized future opportunities persist across connections and do not start on enable", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-heartbeats-"));
  directories.push(directory);
  const path = join(directory, "store.sqlite");
  const f = ready(path, 0.5);
  f.save({ minIntervalMinutes: 180, maxIntervalMinutes: 360 });
  const expected = "2026-09-15T19:30:00.000Z";
  expect(f.heartbeats.getStatus("123").nextOpportunityAt).toBe(expected);
  expect(f.heartbeats.claimOpportunity(worker)).toBeNull();
  const reopened = openStore(path);
  stores.push(reopened);
  const other = createHeartbeatService(reopened, {
    now: () => new Date("2026-09-15T16:00:00.000Z"),
    random: () => 0,
  });
  expect(other.getStatus("123").nextOpportunityAt).toBe(expected);
  expect(other.recoverInterrupted(worker.leaseOwner)).toEqual({
    generations: 0,
    deliveries: 0,
    rescheduled: false,
  });
  const run = f.due();
  expect(run?.status).toBe("generating");
  expect(other.claimOpportunity(worker)).toBeNull();
  expect(f.heartbeats.recentRuns()).toHaveLength(1);
});

test("an ordinary unread reply does not consume the independent two-heartbeat allowance", () => {
  const f = ready();
  expect(f.heartbeats.getStatus("123")).toMatchObject({ unansweredCount: 0, blockingReason: null });
  f.send(f.due());
  expect(f.heartbeats.getStatus("123")).toMatchObject({ deliveredToday: 1, unansweredCount: 1 });
  f.send(f.due());
  expect(f.heartbeats.getStatus("123")).toMatchObject({
    deliveredToday: 2,
    unansweredCount: 2,
    blockingReason: "daily_limit",
  });
  expect(f.due()).toBeNull();
  expect(f.heartbeats.recentRuns()[0]).toMatchObject({
    status: "suppressed",
    reason: "daily_limit",
  });
});

test("unanswered heartbeats persist over restart and waking-day boundaries until actual owner input", () => {
  const f = ready();
  f.send(f.due());
  f.send(f.due());
  f.setTime("2026-09-16T18:00:00.000Z");
  expect(f.heartbeats.getStatus("123")).toMatchObject({
    deliveredToday: 0,
    unansweredCount: 2,
    blockingReason: "unanswered_limit",
  });
  const resumed = createHeartbeatService(f.store, {
    now: () => new Date("2026-09-16T18:00:00.000Z"),
    random: () => 0,
  });
  expect(resumed.recoverInterrupted(worker.leaseOwner).rescheduled).toBe(true);
  expect(resumed.getStatus("123").unansweredCount).toBe(2);
  f.accept();
  f.reply();
  expect(f.heartbeats.getStatus("123")).toMatchObject({
    unansweredCount: 0,
    blockingReason: "recent_conversation",
  });
  f.send(f.due());
  expect(f.heartbeats.getStatus("123").unansweredCount).toBe(1);
});

test("new owner input invalidates prepared text even after the ordinary reply has completed", () => {
  const f = ready();
  const run = f.prepare(f.due());
  f.accept("2026-09-15T13:00:00.000Z");
  f.reply();
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  expect(f.heartbeats.getRun(run.id)).toMatchObject({
    status: "suppressed",
    reason: "owner_input_changed",
  });
  expect(f.heartbeats.getStatus("123").unansweredCount).toBe(0);
});

test("a future timestamp on a new input cannot evade the row watermark or pending-turn gate", () => {
  const f = ready();
  const run = f.prepare(f.due());
  f.accept("2026-09-17T23:00:00.000Z");
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  expect(f.heartbeats.getRun(run.id)?.reason).toBe("owner_input_changed");
  expect(f.heartbeats.getStatus("123").blockingReason).toBe("conversation_pending");
});

test("a changed owner watermark rejects generation completion and keeps its provider receipt", () => {
  const f = ready();
  const run = f.due();
  if (!run) throw new Error("Missing test run.");
  expect(f.heartbeats.setSnapshot(run, { fictionalContext: true })).toBe(true);
  f.accept();
  expect(
    f.heartbeats.prepare(run, {
      text: "A now outdated greeting.",
      requestId: "fictional-late-completion",
    }),
  ).toBe(false);
  expect(f.heartbeats.getRun(run.id)).toMatchObject({
    status: "suppressed",
    reason: "owner_input_changed",
    result: { requestId: "fictional-late-completion" },
  });
});

test("save and pause invalidate work before send; indefinite and timed pauses retain revisions", () => {
  const f = ready();
  const first = f.prepare(f.due());
  const current = f.heartbeats.getSettings();
  const paused = f.heartbeats.pause({ expectedVersion: current.version, pausedUntil: null });
  expect(f.heartbeats.getRun(first.id)?.reason).toBe("settings_changed");
  expect(f.heartbeats.getStatus("123")).toMatchObject({
    paused: true,
    blockingReason: "paused",
    nextOpportunityAt: null,
  });
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  f.heartbeats.resume({ expectedVersion: paused.version });
  const second = f.due();
  if (!second) throw new Error("Missing test run.");
  f.save({ maxMessageChars: 320 });
  expect(f.heartbeats.getRun(second.id)).toMatchObject({
    status: "suppressed",
    reason: "settings_changed",
  });
  const settings = f.heartbeats.getSettings();
  f.heartbeats.pause({
    expectedVersion: settings.version,
    pausedUntil: "2026-09-15T18:00:00.000Z",
  });
  expect(f.heartbeats.getStatus("123").nextOpportunityAt).toBe("2026-09-15T18:30:00.000Z");
  f.setTime("2026-09-15T18:00:00.000Z");
  expect(f.heartbeats.getStatus("123").paused).toBe(false);
  expect(f.heartbeats.claimOpportunity(worker)).toBeNull();
  expect(f.due()?.status).toBe("generating");
});

test("quiet hours are checked at send time, and missed active hours schedule the next real window", () => {
  const f = ready();
  f.setTime("2026-09-15T16:20:00.000Z");
  f.save({ activeStart: "09:00", activeEnd: "12:00" });
  const run = f.prepare(f.due()); // 11:50 Chicago.
  f.setTime("2026-09-15T17:01:00.000Z");
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  expect(f.heartbeats.getRun(run.id)).toMatchObject({
    status: "suppressed",
    reason: "quiet_hours",
  });
  expect(f.heartbeats.getStatus("123").nextOpportunityAt).toBe("2026-09-16T14:00:00.000Z");
});

test("equal active times permit overnight warmth while preserving a noon waking-day boundary", () => {
  const f = ready();
  f.setTime("2026-09-16T08:00:00.000Z"); // 03:00 Chicago.
  expect(f.heartbeats.getStatus("123")).toMatchObject({ activeNow: true, wakingDay: "2026-09-15" });
  f.heartbeats.recoverInterrupted(worker.leaseOwner);
  f.send(f.due());
  f.setTime("2026-09-16T16:59:00.000Z");
  expect(f.heartbeats.getStatus("123").deliveredToday).toBe(1);
  f.setTime("2026-09-16T17:00:00.000Z");
  expect(f.heartbeats.getStatus("123")).toMatchObject({
    wakingDay: "2026-09-16",
    deliveredToday: 0,
    unansweredCount: 1,
    activeNow: true,
  });
});

test("overnight windows and DST skipped/repeated local hours use real instants and one waking day", () => {
  const f = ready();
  f.setTime("2026-11-01T06:15:00.000Z"); // First 01:15 Chicago.
  f.save({ activeStart: "22:00", activeEnd: "02:00" });
  const first = f.heartbeats.getStatus("123");
  f.setTime("2026-11-01T07:15:00.000Z"); // Repeated 01:15 Chicago.
  expect(f.heartbeats.getStatus("123")).toMatchObject({
    wakingDay: first.wakingDay,
    activeNow: true,
  });
  expect(first.wakingDay).toBe("2026-10-31");
  f.setTime("2026-11-01T08:00:00.000Z");
  expect(f.heartbeats.getStatus("123").activeNow).toBe(false);
  f.setTime("2026-03-08T07:45:00.000Z");
  f.save({ activeStart: "02:00", activeEnd: "04:00" });
  // 02:00 never occurs on the spring transition; 03:15 is a real active instant.
  expect(f.heartbeats.getStatus("123").nextOpportunityAt).toBe("2026-03-08T08:15:00.000Z");
});

test("claims require a live owner lease and fence token, including final delivery recording", () => {
  const f = ready();
  expect(f.heartbeats.claimOpportunity({ ...worker, leaseOwner: "intruder" })).toBeNull();
  const run = f.due();
  if (!run) throw new Error("Missing test run.");
  expect(f.heartbeats.setSnapshot({ ...run, fence: "wrong" }, { fictionalContext: true })).toBe(
    false,
  );
  f.prepare(run);
  expect(f.heartbeats.claimDelivery({ ...worker, leaseOwner: "intruder" })).toBeNull();
  const delivery = f.heartbeats.claimDelivery(worker);
  if (!delivery) throw new Error("Missing test delivery.");
  f.conversations.releaseTelegramLease(worker.leaseOwner);
  expect(f.heartbeats.recordDelivery(delivery, receipt)).toBe(false);
  f.conversations.acquireTelegramLease("replacement", "2027-12-01T00:00:00.000Z");
  expect(f.heartbeats.recoverInterrupted("replacement").deliveries).toBe(1);
  expect(f.heartbeats.getRun(run.id)?.status).toBe("unknown");
  expect(f.heartbeats.recordDelivery(delivery, receipt)).toBe(false);
  expect(f.heartbeats.claimDelivery({ ...worker, leaseOwner: "replacement" })).toBeNull();
});

test("restart suppresses unfinished casual work and reschedules overdue opportunities without a burst", () => {
  const f = ready();
  const run = f.prepare(f.due());
  f.setTime("2026-09-15T19:30:00.000Z");
  expect(f.heartbeats.recoverInterrupted(worker.leaseOwner)).toEqual({
    generations: 1,
    deliveries: 0,
    rescheduled: true,
  });
  expect(f.heartbeats.getRun(run.id)).toMatchObject({
    status: "suppressed",
    reason: "interrupted_generation",
  });
  expect(f.heartbeats.getStatus("123").nextOpportunityAt).toBe("2026-09-15T20:00:00.000Z");
  expect(f.heartbeats.claimOpportunity(worker)).toBeNull();
  expect(f.heartbeats.recoverInterrupted(worker.leaseOwner)).toEqual({
    generations: 0,
    deliveries: 0,
    rescheduled: false,
  });
});

test("unknown sends consume conservative budgets and never replay; definite failures and silence do not", () => {
  const f = ready();
  const silent = f.due();
  if (!silent) throw new Error("Missing silent test run.");
  const result = {
    text: "",
    requestId: "fictional-silent-receipt",
    usage: { inputTokens: 10, outputTokens: 2 },
    costUsd: null,
  };
  expect(f.heartbeats.silence(silent, "model_silent", result)).toBe(true);
  expect(f.heartbeats.getRun(silent.id)?.result).toEqual(result);
  const rejected = f.prepare(f.due());
  const failedSend = f.heartbeats.claimDelivery(worker);
  if (!failedSend) throw new Error("Missing failed test delivery.");
  f.heartbeats.recordDelivery(failedSend, { status: "failed", code: "telegram_rejected" });
  expect(f.heartbeats.getRun(rejected.id)?.status).toBe("failed");
  expect(f.heartbeats.getStatus("123")).toMatchObject({
    deliveredToday: 0,
    unknownToday: 0,
    unansweredCount: 0,
  });
  const uncertain = f.prepare(f.due());
  const unknownSend = f.heartbeats.claimDelivery(worker);
  if (!unknownSend) throw new Error("Missing unknown test delivery.");
  f.heartbeats.recordDelivery(unknownSend, { status: "unknown", code: "network_timeout" });
  expect(f.heartbeats.getRun(uncertain.id)?.status).toBe("unknown");
  expect(f.heartbeats.getStatus("123")).toMatchObject({
    deliveredToday: 0,
    unknownToday: 1,
    unansweredCount: 1,
  });
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  expect(
    f.heartbeats.confirmedHistory({ chatId: "123", since: "2026-01-01T00:00:00.000Z" }),
  ).toEqual([]);
});

test("actual receipts remain factual after settings or owner input changes during transport", () => {
  const f = ready();
  const run = f.prepare(f.due());
  const delivery = f.heartbeats.claimDelivery(worker);
  if (!delivery) throw new Error("Missing test delivery.");
  f.save({ enabled: false });
  f.accept();
  expect(f.heartbeats.recordDelivery(delivery, receipt)).toBe(true);
  expect(f.heartbeats.recordDelivery(delivery, receipt)).toBe(false);
  expect(f.heartbeats.getRun(run.id)).toMatchObject({
    status: "delivered",
    telegramMessageId: "987",
  });
  expect(
    f.heartbeats.confirmedHistory({ chatId: "123", since: "2026-01-01T00:00:00.000Z" }),
  ).toMatchObject([
    { id: run.id, text: "Thinking of your latest adventure. I'd love to hear how it went." },
  ]);
  expect(
    f.heartbeats.confirmedHistory({ chatId: "999", since: "2026-01-01T00:00:00.000Z" }),
  ).toEqual([]);
});

test("snapshots and prepared text are immutable, overlong messages fail without truncation", () => {
  const f = ready();
  const run = f.due();
  if (!run) throw new Error("Missing test run.");
  expect(f.heartbeats.prepare(run, { text: "Not yet snapshotted." })).toBe(false);
  expect(f.heartbeats.setSnapshot(run, { fictionalContext: true })).toBe(true);
  expect(f.heartbeats.setSnapshot(run, { fictionalContext: false })).toBe(false);
  expect(() =>
    f.store.db.query("UPDATE core_heartbeat_runs SET snapshot_json='{}' WHERE id=?").run(run.id),
  ).toThrow("immutable");
  expect(
    f.heartbeats.prepare(run, { text: "x".repeat(481), requestId: "fictional-overlong" }),
  ).toBe(false);
  expect(f.heartbeats.getRun(run.id)).toMatchObject({
    status: "failed",
    reason: "invalid_message_length",
    text: null,
    result: { requestId: "fictional-overlong" },
  });
  const next = f.prepare(f.due());
  expect(() =>
    f.store.db.query("UPDATE core_heartbeat_runs SET text='Changed' WHERE id=?").run(next.id),
  ).toThrow("immutable");
  expect(() => f.heartbeats.recordDelivery(next, { status: "delivered" })).toThrow("receipt");
});

test("missing owner context and long-missed opportunities produce no generation", () => {
  const f = fixture();
  f.enable();
  expect(f.due()).toBeNull();
  expect(f.heartbeats.recentRuns()[0]).toMatchObject({
    status: "suppressed",
    reason: "no_owner_input",
  });
  f.accept();
  f.reply();
  f.setTime("2026-09-15T18:00:00.000Z");
  expect(f.heartbeats.claimOpportunity(worker)).toBeNull();
  expect(f.heartbeats.recentRuns()[0]).toMatchObject({
    status: "suppressed",
    reason: "missed_opportunity",
  });
  expect(f.heartbeats.getStatus("123").nextOpportunityAt).toBe("2026-09-15T18:30:00.000Z");
});

test("a paused opportunity retains a late provider receipt without restoring text or delivery", () => {
  const f = ready();
  const run = f.due();
  if (!run) throw new Error("Missing test run.");
  f.heartbeats.setSnapshot(run, { fictionalContext: true });
  f.heartbeats.pause({ expectedVersion: f.heartbeats.getSettings().version, pausedUntil: null });
  const finishedAt = f.heartbeats.getRun(run.id)?.finishedAt;
  f.setTime("2026-09-15T15:31:00.000Z");
  const result = {
    text: "A fictional message that became stale while generation was running.",
    requestId: "fictional-late-provider-receipt",
    usage: { inputTokens: 142, outputTokens: 20 },
    costUsd: null,
  };
  expect(f.heartbeats.recordGenerationResult({ ...run, fence: "wrong" }, result)).toBe(false);
  expect(f.heartbeats.recordGenerationResult(run, result)).toBe(true);
  expect(f.heartbeats.getRun(run.id)).toMatchObject({
    status: "suppressed",
    reason: "settings_changed",
    finishedAt,
    text: null,
    telegramMessageId: null,
    result,
  });
  expect(f.heartbeats.prepare(run, result)).toBe(false);
  expect(f.heartbeats.claimDelivery(worker)).toBeNull();
  expect(f.heartbeats.getStatus("123").unansweredCount).toBe(0);
  expect(
    f.heartbeats.recordGenerationResult(run, {
      costUsd: null,
      usage: { outputTokens: 20, inputTokens: 142 },
      requestId: result.requestId,
      text: result.text,
    }),
  ).toBe(true);
  expect(() =>
    f.heartbeats.recordGenerationResult(run, { ...result, requestId: "different-receipt" }),
  ).toThrow("different heartbeat generation result");
  expect(() =>
    f.store.db.query("UPDATE core_heartbeat_runs SET result_json='{}' WHERE id=?").run(run.id),
  ).toThrow("immutable");
  f.conversations.releaseTelegramLease(worker.leaseOwner);
  expect(f.heartbeats.recordGenerationResult(run, result)).toBe(false);
});

test("recording a result before preparation is idempotent and cannot replace confirmed evidence", () => {
  const f = ready();
  const run = f.due();
  if (!run) throw new Error("Missing test run.");
  f.heartbeats.setSnapshot(run, { fictionalContext: true });
  const result = {
    text: "I hope your fictional adventure brought you a little joy today.",
    requestId: "fictional-confirmed-receipt",
    costUsd: null,
  };
  expect(f.heartbeats.recordGenerationResult(run, result)).toBe(true);
  expect(f.heartbeats.prepare(run, result)).toBe(true);
  const delivery = f.heartbeats.claimDelivery(worker);
  if (!delivery) throw new Error("Missing test delivery.");
  f.heartbeats.recordDelivery(delivery, receipt);
  expect(f.heartbeats.recordGenerationResult(run, result)).toBe(true);
  expect(() =>
    f.heartbeats.recordGenerationResult(run, { ...result, text: "Replacement text." }),
  ).toThrow("different heartbeat generation result");
  expect(f.heartbeats.getRun(run.id)).toMatchObject({
    status: "delivered",
    text: result.text,
    result,
    telegramMessageId: "987",
  });
});
