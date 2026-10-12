import { afterEach, expect, test } from "bun:test";
import {
  createContextNoticeService,
  createConversationService,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = openStore(":memory:");
  stores.push(store);
  let clock = new Date("2026-09-16T12:00:00.000Z");
  store.db
    .query("UPDATE core_migrations SET applied_at=? WHERE id='015-context-notices'")
    .run("2026-09-16T00:00:00.000Z");
  const conversation = createConversationService(store, { now: () => clock });
  const current = conversation.getSettings();
  conversation.saveSettings({ ...current, expectedVersion: current.version, model: "fictional" });
  conversation.acquireTelegramLease("worker", "2026-09-16T12:01:00.000Z");
  const notices = createContextNoticeService(store, { now: () => clock });
  let sequence = 0;
  const turn = (
    failureCode: string | null,
    finishReason = "stop",
    receivedAt = clock.toISOString(),
  ) => {
    sequence++;
    conversation.acceptTelegramBatch({
      nextOffset: sequence + 1,
      inputs: [
        {
          updateId: sequence,
          messageId: String(sequence),
          chatId: "42",
          senderId: "42",
          text: "A fictional report.",
          receivedAt,
        },
      ],
    });
    const next = conversation.startNextTurn();
    if (!next) throw new Error("Expected test turn.");
    if (failureCode) conversation.failGeneration(next.id, { code: failureCode });
    else {
      conversation.completeGeneration(next.id, {
        text: "A fictional reply.",
        finishReason,
        usage: { inputTokens: 100, outputTokens: 20 },
      });
      const delivery = conversation.claimDelivery();
      if (!delivery) throw new Error("Expected reply.");
      conversation.recordDelivery(delivery.id, {
        status: "sent",
        messageId: String(100 + sequence),
      });
    }
    clock = new Date(clock.getTime() + 1000);
    return next.id;
  };
  return {
    store,
    conversation,
    notices,
    turn,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

test("context warning episodes deduplicate and recover independently of heartbeat caps", () => {
  const f = fixture();
  f.turn("context_budget_exceeded");
  f.notices.reconcile("42");
  const first = f.notices.claim("42", "worker");
  expect(first?.text).toContain("could not fit");
  if (!first) throw new Error("Missing notice.");
  expect(f.notices.recordDelivery(first, { status: "sent", messageId: "900" })).toBe(true);
  f.turn("context_budget_exceeded");
  f.notices.reconcile("42");
  expect(f.notices.claim("42", "worker")).toBeNull();
  expect(f.notices.list()).toHaveLength(1);
  f.turn(null);
  f.notices.reconcile("42");
  f.turn("context_budget_exceeded");
  f.notices.reconcile("42");
  expect(f.notices.claim("42", "worker")?.id).not.toBe(first.id);
  expect(f.store.db.query("SELECT id FROM core_heartbeat_runs").all()).toHaveLength(0);
});

test("ambiguous sends are never replayed and stale leases cannot commit receipts", () => {
  const f = fixture();
  f.turn("context_budget_exceeded");
  f.notices.reconcile("42");
  expect(f.notices.claim("42", "outsider")).toBeNull();
  const notice = f.notices.claim("42", "worker");
  if (!notice) throw new Error("Missing notice.");
  f.advance(61000);
  expect(f.conversation.acquireTelegramLease("next-worker", "2026-09-16T12:03:00.000Z")).toBe(true);
  expect(f.notices.recordDelivery(notice, { status: "sent", messageId: "901" })).toBe(false);
  f.notices.recover("next-worker");
  expect(f.notices.list()[0]?.status).toBe("unknown");
  expect(f.notices.claim("42", "next-worker")).toBeNull();
});

test("definitive retry waits, while a healthy response cancels an unsent old notice", () => {
  const f = fixture();
  f.turn("context_budget_exceeded");
  f.notices.reconcile("42");
  const notice = f.notices.claim("42", "worker");
  if (!notice) throw new Error("Missing notice.");
  f.notices.recordDelivery(notice, {
    status: "retry",
    code: "rate_limited",
    retryAt: "2026-09-16T12:00:10.000Z",
  });
  expect(f.notices.claim("42", "worker")).toBeNull();
  f.turn(null);
  f.notices.reconcile("42");
  f.advance(15000);
  expect(f.notices.claim("42", "worker")).toBeNull();
  expect(f.notices.list()[0]?.status).toBe("cancelled");
});

test("old records do not notify and output exhaustion has its own explanation", () => {
  const f = fixture();
  f.turn("context_budget_exceeded", "stop", "2026-09-15T12:00:00.000Z");
  f.notices.reconcile("42");
  expect(f.notices.list()).toHaveLength(0);
  f.turn(null, "length");
  f.notices.reconcile("42");
  const notice = f.notices.claim("42", "worker");
  expect(notice?.category).toBe("output");
  expect(notice?.text).toContain("separate from input context size");
});

test("owner retry recovers a definitive failed warning without replaying uncertain or resolved sends", () => {
  const f = fixture();
  f.turn("context_budget_exceeded");
  f.notices.reconcile("42");
  const notice = f.notices.claim("42", "worker");
  if (!notice) throw new Error("Missing notice.");
  f.notices.recordDelivery(notice, { status: "failed", code: "rejected" });
  expect(f.notices.retryFailed(notice.id, notice.attempts + 1)).toBe(false);
  expect(f.notices.retryFailed(notice.id, notice.attempts)).toBe(true);
  expect(f.notices.retryFailed(notice.id, notice.attempts)).toBe(false);
  const next = f.notices.claim("42", "worker");
  if (!next) throw new Error("Missing retried notice.");
  expect(next.text).toBe(notice.text);
  expect(next.attempts).toBe(notice.attempts + 1);
  f.notices.recordDelivery(next, { status: "unknown", code: "network" });
  expect(f.notices.retryFailed(next.id, next.attempts)).toBe(false);
  f.turn(null);
  f.notices.reconcile("42");
  expect(f.notices.retryFailed(next.id, next.attempts)).toBe(false);
  expect(
    f.store.db.query("SELECT id FROM core_activity WHERE kind='context.notice_retry'").all(),
  ).toHaveLength(1);
});
