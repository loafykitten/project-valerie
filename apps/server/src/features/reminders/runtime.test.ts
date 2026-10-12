import { afterEach, expect, test } from "bun:test";
import {
  createAgreementService,
  createConversationService,
  createDailyService,
  createPromptService,
  openStore,
  type ScheduledClaim,
  type Store,
} from "@valerie/core";
import { createScheduledRuntime } from "./runtime";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const owner = { actor: "owner" as const },
  worker = { chatId: "42", leaseOwner: "worker", kind: "checkin" as const };
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fictional runtime record.");
  return value;
};
function fixture(slots: ("morning" | "evening")[] = ["morning", "evening"]) {
  const store = openStore(":memory:");
  stores.push(store);
  let clock = new Date("2026-09-15T17:00:00.000Z");
  const now = () => new Date(clock);
  const conversations = createConversationService(store, { now }),
    daily = createDailyService(store, { now }),
    agreements = createAgreementService(store, { now }),
    prompts = createPromptService(store);
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "42",
        senderId: "42",
        text: "Good morning.",
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
  store.db.query("UPDATE core_conversation_turns SET status='failed'").run();
  conversations.acquireTelegramLease("worker", "2026-09-17T00:00:00.000Z");
  const day = required(
    daily.recordWakingReport(
      {
        report: "day_start",
        mode: "current",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        occurred: { at: clock.toISOString(), basis: "message_time", timezone: "America/Chicago" },
        summary: "A fictional reported day starts.",
      },
      owner,
    ).day,
  );
  const behavior = daily.saveBehavior(
    { name: "Fictional creative practice", unit: "report", valueKind: "status" },
    owner,
  );
  const habit = agreements.saveHabit(
    {
      name: "Fictional creative practice",
      reason: "A manageable agreed practice.",
      behaviorId: behavior.id,
      fullPractice: "Work on the fictional painting for a little while.",
      smallerPractice: "Try the agreed two-minute version.",
      cadence: { kind: "every_waking_day" },
      slots,
      effectiveAt: clock.toISOString(),
      threshold: null,
    },
    owner,
  );
  const runtime = createScheduledRuntime(store, "", { now });
  const settings = runtime.service.getCheckinSettings();
  runtime.service.saveCheckinSettings({
    ...settings,
    enabled: true,
    minIdleMinutes: 0,
    expectedVersion: settings.version,
  });
  const plan = (expectedSleepAt: string) => {
    const current = required(daily.currentDay());
    return daily.recordWakingReport(
      {
        report: "sleep_plan",
        mode: "current",
        expectedCurrentDayId: current.id,
        expectedDayVersion: current.version,
        occurred: { at: clock.toISOString(), basis: "message_time", timezone: "America/Chicago" },
        expectedSleepAt,
        sleepEstimateBasis: "owner_plan",
        summary: "An explicit fictional owner sleep plan.",
      },
      owner,
    );
  };
  const prepare = (claim: ScheduledClaim) => {
    const text = "How did your little creative practice go?";
    expect(runtime.service.setSnapshot(claim, { fictional: true })).toBe(true);
    expect(
      runtime.service.recordGenerationResult(claim, {
        text,
        finishReason: "stop",
        requestId: "fictional-runtime-receipt",
      }),
    ).toBe(true);
    expect(runtime.service.prepare(claim, { text })).toBe(true);
  };
  return {
    store,
    daily,
    agreements,
    prompts,
    runtime,
    day,
    behavior,
    habit,
    plan,
    prepare,
    set: (at: string) => {
      clock = new Date(at);
    },
    now,
  };
}

test("matching optional deadlines coalesce and unchanged synchronization keeps the same prepared occurrence", () => {
  const f = fixture();
  f.plan("2026-09-15T21:00:00.000Z");
  f.set("2026-09-15T19:00:00.000Z");
  f.runtime.synchronize("42");
  f.runtime.synchronize("42");
  expect(f.runtime.service.listOccurrences()).toHaveLength(1);
  const claim = required(f.runtime.service.claimPreparation(worker));
  expect(claim.checkin?.slots).toEqual(["morning", "evening"]);
  expect(claim.checkin?.questions).toHaveLength(1);
  expect(claim.checkin?.questions[0]?.habitVersion).toBe(f.habit.version);
  f.prepare(claim);
  f.runtime.synchronize("42");
  expect(f.runtime.service.readOccurrence(claim.id)?.status).toBe("prepared");
  expect(f.runtime.service.listOccurrences()).toHaveLength(1);
  expect(f.runtime.stillCurrent?.(claim)).toBe(true);
});

test("different optional expiries remain separate so a missed morning does not consume a valid evening", () => {
  const f = fixture();
  f.plan("2026-09-15T21:15:00.000Z");
  f.set("2026-09-15T20:59:00.000Z");
  f.runtime.synchronize("42");
  const pending = f.runtime.service.listOccurrences();
  expect(pending).toHaveLength(2);
  expect(pending.find((run) => run.checkin?.slots.includes("morning"))?.expiresAt).toBe(
    "2026-09-15T21:00:00.000Z",
  );
  expect(pending.find((run) => run.checkin?.slots.includes("evening"))?.expiresAt).toBe(
    "2026-09-15T21:15:00.000Z",
  );
  const morning = required(f.runtime.service.claimPreparation(worker));
  expect(morning.checkin?.slots).toEqual(["morning"]);
  f.set("2026-09-15T21:00:01.000Z");
  const evening = required(f.runtime.service.claimPreparation(worker));
  expect(evening.checkin?.slots).toEqual(["evening"]);
  f.runtime.synchronize("42");
  expect(f.runtime.service.readOccurrence(morning.id)?.status).toBe("expired");
  expect(f.runtime.service.readOccurrence(evening.id)?.status).toBe("generating");
  expect(f.runtime.stillCurrent?.(evening)).toBe(true);
  expect(
    f.store.db.query("SELECT slot,closed FROM core_checkin_slots ORDER BY slot").all(),
  ).toEqual([
    { slot: "evening", closed: 0 },
    { slot: "morning", closed: 1 },
  ]);
});

test("a genuine changed owner sleep plan reopens its expired unsent evening through the actual coordinator", () => {
  const f = fixture(["evening"]),
    firstPlan = f.plan("2026-09-15T17:40:00.000Z");
  f.runtime.synchronize("42");
  const old = required(f.runtime.service.claimPreparation(worker));
  expect(old.checkin?.sleepPlanEventId).toBe(firstPlan.event?.id);
  f.set("2026-09-15T17:40:01.000Z");
  f.runtime.service.claimPreparation(worker);
  f.runtime.synchronize("42");
  expect(f.runtime.service.readOccurrence(old.id)?.status).toBe("expired");
  f.set("2026-09-15T17:41:00.000Z");
  const later = f.plan("2026-09-15T18:10:00.000Z");
  f.runtime.synchronize("42");
  const next = required(f.runtime.service.claimPreparation(worker));
  expect(next.id).not.toBe(old.id);
  expect(next.checkin?.sleepPlanEventId).toBe(later.event?.id);
  expect(next.expiresAt).toBe("2026-09-15T18:10:00.000Z");
  expect(f.store.db.query("SELECT attempts FROM core_checkin_slots").get()).toEqual({
    attempts: 2,
  });
});

test("rule expiry suppresses prepared optional text before delivery even without a separate sync tick", () => {
  const f = fixture(["morning"]);
  f.agreements.saveRule(
    {
      name: "A temporary fictional agreement",
      meaning: "Keep this temporary agreement in mind.",
      reason: "A fictional expiry check.",
      scope: "This short fixture interval.",
      effectiveAt: f.now().toISOString(),
      expiresAt: "2026-09-15T17:31:00.000Z",
      timezone: "America/Chicago",
      window: null,
      exceptions: [],
      condition: null,
    },
    owner,
  );
  f.set("2026-09-15T17:30:00.000Z");
  f.runtime.synchronize("42");
  const claim = required(f.runtime.service.claimPreparation(worker));
  f.prepare(claim);
  f.set("2026-09-15T17:31:00.000Z");
  expect(f.runtime.stillCurrent?.(claim)).toBe(false);
  expect(f.runtime.service.claimDelivery(worker)).toBeNull();
  expect(f.runtime.service.readOccurrence(claim.id)).toMatchObject({
    status: "suppressed",
    reason: "checkin_context_changed",
  });
});

test("a relevant prompt edit invalidates prepared optional wording without mutating its captured text", () => {
  const f = fixture(["morning"]);
  f.set("2026-09-15T17:30:00.000Z");
  f.runtime.synchronize("42");
  const claim = required(f.runtime.service.claimPreparation(worker));
  f.prepare(claim);
  const original = required(f.runtime.service.readOccurrence(claim.id)).text,
    prompt = required(f.prompts.get("habits"));
  f.prompts.update("habits", {
    expectedVersion: prompt.version,
    content: "Use this revised fictional check-in direction.",
  });
  expect(f.runtime.stillCurrent?.(claim)).toBe(false);
  expect(f.runtime.service.claimDelivery(worker)).toBeNull();
  expect(f.runtime.service.readOccurrence(claim.id)).toMatchObject({
    status: "suppressed",
    text: original,
  });
});
