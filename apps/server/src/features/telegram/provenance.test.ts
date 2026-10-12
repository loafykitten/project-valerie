import { afterEach, expect, test } from "bun:test";
import { createConversationService, openStore, type Store } from "@valerie/core";
import { telegramSourceMetadata } from "./provenance";
import { ownerMessageInputs } from "./worker";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function incoming(text: string, extra: Record<string, unknown> = {}) {
  return ownerMessageInputs(
    [
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1789488000,
          text,
          from: { id: 42, is_bot: false },
          chat: { id: 42, type: "private" },
          ...extra,
        },
      },
    ],
    "42",
  )[0];
}

test("forward markers preserve attribution without retaining external identities", () => {
  const source = incoming("Good morning", {
    forward_origin: {
      type: "user",
      date: 100,
      sender_user: { id: 555, first_name: "Fictional private identity" },
    },
  });
  expect(source?.text).toBe("Good morning");
  expect(source?.sourceMetadata).toEqual({
    version: 1,
    provenance: "forwarded",
    quotedRanges: [],
    replyQuote: null,
    incomplete: false,
  });
  expect(JSON.stringify(source?.sourceMetadata)).not.toContain("Fictional private identity");
  expect(JSON.stringify(source?.sourceMetadata)).not.toContain("555");
  expect(
    incoming("Earlier forwarded greeting", { forward_date: 100 })?.sourceMetadata?.provenance,
  ).toBe("forwarded");
});

test("replying does not quote fresh owner text; explicit reply quotes remain separate", () => {
  const reply = incoming("I'm still awake", { reply_to_message: { text: "Good morning" } });
  expect(reply?.sourceMetadata?.provenance).toBe("original");
  expect(reply?.sourceMetadata?.quotedRanges).toEqual([]);
  expect(reply?.sourceMetadata?.replyQuote).toBeNull();
  const quoted = incoming("I'm still awake", {
    quote: { text: "Good morning", position: 0 },
    reply_to_message: { text: "Good morning" },
  });
  expect(quoted?.text).toBe("I'm still awake");
  expect(quoted?.sourceMetadata?.replyQuote).toEqual({ text: "Good morning" });
  expect(quoted?.sourceMetadata?.quotedRanges).toEqual([]);
});

test("same-chat reply targets remain bounded identifiers without making the new body quoted", () => {
  const source = incoming("Done, the fern has water.", {
    reply_to_message: { message_id: 902, chat: { id: 42 }, text: "An earlier reminder." },
  });
  expect(source?.sourceMetadata).toEqual({
    version: 1,
    provenance: "original",
    quotedRanges: [],
    replyQuote: null,
    replyToMessageId: "902",
    incomplete: false,
  });
  expect(JSON.stringify(source?.sourceMetadata)).not.toContain("An earlier reminder");
  for (const reply of [
    { message_id: 902, chat: { id: 999 } },
    { message_id: -1 },
    { message_id: 1.5 },
    { message_id: "902" },
  ])
    expect(
      incoming("Done", { reply_to_message: reply })?.sourceMetadata?.replyToMessageId,
    ).toBeUndefined();
});

test("quoted body entities use original UTF-16 ranges, including captions", () => {
  const text = "🐺 Good morning\nThat was yesterday's greeting.";
  const ranges = [{ type: "blockquote", offset: 3, length: 12 }];
  expect(incoming(text, { entities: ranges })?.sourceMetadata?.quotedRanges).toEqual([
    { offset: 3, length: 12 },
  ]);
  expect(telegramSourceMetadata({ caption_entities: ranges }, text, true).quotedRanges).toEqual([
    { offset: 3, length: 12 },
  ]);
  expect(telegramSourceMetadata({ entities: ranges }, text, true).quotedRanges).toEqual([]);
});

test("malformed or excessive quote metadata stays incomplete without dropping the owner's message", () => {
  expect(
    incoming("Hello", { entities: [{ type: "blockquote", offset: 0, length: 100 }] })
      ?.sourceMetadata?.incomplete,
  ).toBe(true);
  const repeated = Array.from({ length: 20 }, () => ({ type: "blockquote", offset: 0, length: 1 }));
  const parsed = incoming("Hello", { entities: repeated, quote: { text: "x".repeat(2000) } });
  expect(parsed?.text).toBe("Hello");
  expect(parsed?.sourceMetadata?.quotedRanges).toHaveLength(16);
  expect(parsed?.sourceMetadata?.replyQuote?.text).toHaveLength(1024);
  expect(parsed?.sourceMetadata?.incomplete).toBe(true);
});

test("attribution is durable and immutable; older records remain unknown and snapshots keep raw text", () => {
  const store = openStore(":memory:");
  stores.push(store);
  const conversations = createConversationService(store);
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    model: "fictional",
  });
  const source = incoming("Good morning", { forward_origin: { type: "hidden_user" } });
  if (!source) throw new Error("Missing fictional source.");
  conversations.acceptTelegramBatch({ nextOffset: 2, inputs: [source] });
  const saved = store.db
    .query<{ id: string; metadata: string }, []>(
      "SELECT id,source_metadata_json AS metadata FROM core_telegram_inputs",
    )
    .get();
  expect(saved && JSON.parse(saved.metadata)).toEqual(source.sourceMetadata);
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing turn.");
  expect(turn.snapshot.messages).toContainEqual({ role: "user", content: "Good morning" });
  expect(
    turn.snapshot.messages.some(
      (message) =>
        typeof message.content === "string" && message.content.includes('"provenance":"forwarded"'),
    ),
  ).toBe(true);
  expect(turn.snapshot.inputSources?.[0]?.sourceMetadata?.provenance).toBe("forwarded");
  expect(() =>
    store.db
      .query("UPDATE core_telegram_inputs SET source_metadata_json=NULL WHERE id=?")
      .run(saved?.id ?? ""),
  ).toThrow("immutable");
  conversations.failGeneration(turn.id, { code: "fixture_complete" });
  conversations.acceptTelegramBatch({
    nextOffset: 3,
    inputs: [
      {
        updateId: 2,
        messageId: "2",
        chatId: "42",
        senderId: "42",
        text: "An older import without provenance",
      },
    ],
  });
  expect(conversations.startNextTurn()?.snapshot.inputSources?.[0]?.sourceMetadata).toBeNull();
});
