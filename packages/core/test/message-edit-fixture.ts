import { createConversationService, createMessageEditService, openStore } from "../src";

export function messageEditFixture(path = ":memory:") {
  const store = openStore(path);
  const conversation = createConversationService(store);
  const settings = conversation.getSettings();
  if (!settings.model)
    conversation.saveSettings({
      ...settings,
      expectedVersion: settings.version,
      model: "fictional",
    });
  let input = 100;
  function accept(text = "A fictional owner message") {
    const id = input++;
    conversation.acceptTelegramBatch({
      nextOffset: id + 1,
      inputs: [{ updateId: id, messageId: String(id), chatId: "42", senderId: "42", text }],
    });
  }
  function deliver(chunks = ["Original lavender reply."]) {
    accept();
    const turn = conversation.startNextTurn();
    if (!turn) throw new Error("No fixture turn");
    conversation.completeGeneration(turn.id, { text: chunks.join(""), chunks });
    const ids: string[] = [];
    for (const _chunk of chunks) {
      const delivery = conversation.claimDelivery();
      if (!delivery) throw new Error("No fixture delivery");
      ids.push(delivery.id);
      conversation.recordDelivery(delivery.id, {
        status: "sent",
        messageId: String(500 + input + ids.length),
      });
    }
    return { turn, ids };
  }
  const edits = createMessageEditService(store);
  function queue(deliveryId: string, text = "Revised marigold reply.", expectedVersion = 1) {
    return edits.queue({ id: crypto.randomUUID(), deliveryId, text, expectedVersion }, "42");
  }
  function lease(owner = "fixture-worker") {
    if (!conversation.acquireTelegramLease(owner, new Date(Date.now() + 120000).toISOString()))
      throw new Error("Fixture lease unavailable");
    return owner;
  }
  return { store, conversation, edits, accept, deliver, queue, lease };
}
