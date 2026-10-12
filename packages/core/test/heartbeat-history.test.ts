import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createHeartbeatService,
  createMemoryService,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
function required<T>(value: T | null): T {
  if (value === null) throw new Error("Missing fictional fixture value");
  return value;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
test("confirmed heartbeats enter later context and assistant archive with owner and future-turn isolation", () => {
  const store = openStore(":memory:");
  stores.push(store);
  let clock = new Date("2026-09-15T18:00:00.000Z");
  const now = () => clock;
  const conversations = createConversationService(store, { now });
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    model: "fictional-model",
    expectedVersion: settings.version,
  });
  const accept = (id: number, chatId = "42") => {
    conversations.acceptTelegramBatch({
      nextOffset: id + 1,
      inputs: [
        {
          updateId: id,
          messageId: String(id),
          chatId,
          senderId: chatId,
          text: "A fictional note about paper cranes.",
          receivedAt: clock.toISOString(),
        },
      ],
    });
    return required(
      store.db
        .query<{ id: string }, [number]>("SELECT id FROM core_conversation_turns WHERE update_id=?")
        .get(id),
    ).id;
  };
  const finish = () => {
    const turn = required(conversations.startNextTurn());
    conversations.completeGeneration(turn.id, {
      text: "Your fictional paper cranes sound lovely.",
    });
    const delivery = required(conversations.claimDelivery());
    conversations.recordDelivery(delivery.id, { status: "sent", messageId: "100" });
    return turn;
  };
  const previousId = accept(1);
  finish();
  const service = createHeartbeatService(store, { now, random: () => 0 });
  const current = service.getSettings();
  service.saveSettings({
    ...current,
    enabled: true,
    activeStart: "12:00",
    activeEnd: "12:00",
    maxPerDay: 8,
    maxUnanswered: 8,
    expectedVersion: current.version,
  });
  conversations.acquireTelegramLease("worker", "2026-09-16T18:00:00.000Z");
  clock = new Date("2026-09-15T20:00:00.000Z");
  store.db
    .query("UPDATE core_heartbeat_state SET next_opportunity_at=? WHERE singleton=1")
    .run(clock.toISOString());
  const claim = required(service.claimOpportunity({ chatId: "42", leaseOwner: "worker" }));
  expect(claim).not.toBeNull();
  service.setSnapshot(claim, { fictional: true });
  service.prepare(claim, { text: "Those paper cranes brought a smile to my face." });
  const sending = required(service.claimDelivery({ chatId: "42", leaseOwner: "worker" }));
  service.recordDelivery(sending, { status: "delivered", telegramMessageId: "101" });
  const sourceId = `heartbeat:${claim.id}`;
  const memory = createMemoryService(store, { now });
  expect(memory.conversationRead({ id: sourceId, turnId: previousId })).toBeNull();
  clock = new Date("2026-09-15T20:01:00.000Z");
  const nextId = accept(2);
  const next = required(conversations.startNextTurn());
  expect(next.snapshot.history.includedHeartbeats).toBe(1);
  expect(
    next.snapshot.messages.some(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes(
          "Following casual heartbeat (optional contact, not a saved task reminder)",
        ),
    ),
  ).toBe(true);
  expect(
    next.snapshot.messages.filter((x) => x.role === "assistant").map((x) => x.content),
  ).toEqual([
    "Your fictional paper cranes sound lovely.",
    "Those paper cranes brought a smile to my face.",
  ]);
  expect(
    memory
      .conversationSearch({ query: "paper cranes", turnId: nextId, role: "assistant" })
      .items.some((x) => x.id === sourceId),
  ).toBe(true);
  expect(memory.conversationRead({ id: sourceId, turnId: nextId })?.role).toBe("assistant");
  const otherId = accept(3, "99");
  expect(memory.conversationRead({ id: sourceId, turnId: otherId })).toBeNull();
  expect(
    memory
      .conversationSearch({ query: "paper cranes", turnId: otherId })
      .items.some((x) => x.id === sourceId),
  ).toBe(false);
  expect(
    memory
      .conversationSearch({ query: "paper cranes", turnId: nextId, role: "user" })
      .items.some((x) => x.id === sourceId),
  ).toBe(false);
});
