import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryService,
  createMessageEditService,
  MessageEditConflictError,
  MessageEditNotFoundError,
  openStore,
  type Store,
} from "../src";
import { messageEditFixture } from "./message-edit-fixture";

const stores: Store[] = [],
  directories: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const f = messageEditFixture();
  stores.push(f.store);
  return f;
}
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Fixture missing");
  return value;
}

test("confirmed edits replace context and archive search, retaining original generations and pinned turns", () => {
  const f = fixture(),
    { turn, ids } = f.deliver(),
    id = required(ids[0]),
    owner = f.lease();
  const memory = createMemoryService(f.store);
  f.accept("Follow-up before the edit");
  const inFlight = required(f.conversation.startNextTurn());
  const before = JSON.stringify(inFlight.snapshot);
  const edit = f.queue(id);
  expect(f.edits.messages(turn.id, "42")[0]?.text).toBe("Original lavender reply.");
  expect(memory.conversationSearch({ query: "lavender", role: "assistant" }).items).toHaveLength(1);
  const claim = required(f.edits.claim("42", owner));
  expect(claim.id).toBe(edit.id);
  expect(
    f.edits.finish(claim, {
      status: "applied",
      messageId: claim.telegramMessageId,
      unchanged: false,
    }),
  ).toBe(true);
  expect(f.edits.messages(turn.id, "42")[0]?.version).toBe(2);
  expect(memory.conversationSearch({ query: "lavender", role: "assistant" }).items).toHaveLength(0);
  expect(memory.conversationSearch({ query: "marigold", role: "assistant" }).items).toHaveLength(1);
  expect(
    f.store.db
      .query<{ output_text: string }, []>(
        "SELECT output_text FROM core_conversation_results ORDER BY rowid LIMIT 1",
      )
      .get()?.output_text,
  ).toBe("Original lavender reply.");
  expect(
    f.store.db
      .query<{ snapshot_json: string }, [string]>(
        "SELECT snapshot_json FROM core_conversation_turns WHERE id=?",
      )
      .get(inFlight.id)?.snapshot_json,
  ).toBe(before);
  f.conversation.completeGeneration(inFlight.id, { text: "Another reply" });
  const d = required(f.conversation.claimDelivery());
  f.conversation.recordDelivery(d.id, { status: "sent", messageId: "700" });
  f.accept("After edit");
  const next = required(f.conversation.startNextTurn());
  expect(
    next.snapshot.messages.some(
      (m) => m.role === "assistant" && m.content === "Revised marigold reply.",
    ),
  ).toBe(true);
  expect(f.edits.history(id, "42").map((r) => r.text)).toEqual([
    "Revised marigold reply.",
    "Original lavender reply.",
  ]);
  expect(() => f.store.db.query("UPDATE core_message_revisions SET text='tamper'").run()).toThrow(
    "immutable",
  );
  expect(() => f.store.db.query("DELETE FROM core_message_revisions").run()).toThrow("retained");
});

test("each split message edits independently and restoring creates a new revision", () => {
  const f = fixture(),
    { turn, ids } = f.deliver(["First part.\n\n", "Second part."]),
    owner = f.lease();
  f.queue(required(ids[1]), "New ending.");
  const claim = required(f.edits.claim("42", owner));
  f.edits.finish(claim, {
    status: "applied",
    messageId: claim.telegramMessageId,
    unchanged: false,
  });
  expect(f.conversation.recentTurns()[0]?.outputText).toBe("First part.\n\nNew ending.");
  expect(f.edits.messages(turn.id, "42")[0]?.version).toBe(1);
  f.queue(required(ids[1]), "Second part.", 2);
  const restore = required(f.edits.claim("42", owner));
  f.edits.finish(restore, {
    status: "applied",
    messageId: restore.telegramMessageId,
    unchanged: false,
  });
  expect(f.edits.history(required(ids[1]), "42").map((r) => r.version)).toEqual([3, 2, 1]);
  expect(f.conversation.recentTurns()[0]?.outputText).toBe("First part.\n\nSecond part.");
});

test("conflicts, owner boundary, invalid drafts, and duplicate requests cannot overwrite a pending or newer revision", () => {
  const f = fixture(),
    { ids } = f.deliver(),
    id = required(ids[0]);
  for (const text of [" ", "a".repeat(4097), "broken\ud800"])
    expect(() => f.queue(id, text)).toThrow(TypeError);
  expect(() =>
    f.edits.queue(
      { id: crypto.randomUUID(), deliveryId: id, text: "No", expectedVersion: 1 },
      "99",
    ),
  ).toThrow(MessageEditNotFoundError);
  const edit = f.queue(id);
  expect(
    f.edits.queue({ id: edit.id, deliveryId: id, text: edit.text, expectedVersion: 1 }, "42").id,
  ).toBe(edit.id);
  expect(() => f.queue(id, "Concurrent")).toThrow(MessageEditConflictError);
  const owner = f.lease(),
    claim = required(f.edits.claim("42", owner));
  f.edits.finish(claim, {
    status: "applied",
    messageId: claim.telegramMessageId,
    unchanged: false,
  });
  expect(() => f.queue(id, "Stale", 1)).toThrow(MessageEditConflictError);
  expect(
    f.edits.queue({ id: edit.id, deliveryId: id, text: edit.text, expectedVersion: 1 }, "42")
      .status,
  ).toBe("applied");
});

test("unknown edits block new drafts, require manual retry, and accept already-matching Telegram receipts", () => {
  const f = fixture(),
    { turn, ids } = f.deliver(),
    id = required(ids[0]),
    owner = f.lease();
  const edit = f.queue(id),
    first = required(f.edits.claim("42", owner));
  f.edits.finish(first, { status: "unknown", code: "network" });
  expect(f.edits.claim("42", owner)).toBeNull();
  expect(f.edits.messages(turn.id, "42")[0]?.version).toBe(1);
  expect(() => f.queue(id, "Something else")).toThrow(MessageEditConflictError);
  f.edits.retry(edit.id, "42");
  const retried = required(f.edits.claim("42", owner));
  expect(
    f.edits.finish(first, {
      status: "applied",
      messageId: first.telegramMessageId,
      unchanged: false,
    }),
  ).toBe(false);
  f.edits.finish(retried, {
    status: "applied",
    messageId: retried.telegramMessageId,
    unchanged: true,
  });
  expect(f.edits.messages(turn.id, "42")[0]?.version).toBe(2);
  expect(
    f.store.db
      .query("SELECT * FROM core_message_edit_attempts WHERE outcome_json IS NOT NULL")
      .all(),
  ).toHaveLength(2);
});

test("definitive failures retain history and rate limits are respected on explicit retry", () => {
  const f = fixture(),
    { ids } = f.deliver(),
    id = required(ids[0]),
    owner = f.lease();
  const edit = f.queue(id),
    claim = required(f.edits.claim("42", owner));
  f.edits.finish(claim, {
    status: "failed",
    code: "rate_limited",
    retryAfter: new Date(Date.now() + 60000).toISOString(),
  });
  expect(() => f.edits.retry(edit.id, "42")).toThrow("pause");
  expect(f.conversation.recentTurns()[0]?.outputText).toBe("Original lavender reply.");
});

test("restart preserves queued work and marks interrupted edits unknown; old leases cannot apply receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-edit-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite"),
    f = messageEditFixture(path),
    { ids, turn } = f.deliver();
  const owner = f.lease(),
    edit = f.queue(required(ids[0])),
    claim = required(f.edits.claim("42", owner));
  f.conversation.releaseTelegramLease(owner);
  f.store.close();
  const store = openStore(path);
  stores.push(store);
  store.db
    .query("UPDATE core_telegram_state SET lease_owner='successor',lease_expires_at=?")
    .run(new Date(Date.now() + 60000).toISOString());
  const edits = createMessageEditService(store);
  edits.recover("successor");
  expect(edits.messages(turn.id, "42")[0]?.edit?.status).toBe("unknown");
  expect(() =>
    edits.finish(claim, {
      status: "applied",
      messageId: claim.telegramMessageId,
      unchanged: false,
    }),
  ).toThrow("lease");
  edits.retry(edit.id, "42");
  expect(edits.claim("42", "successor")?.text).toBe(edit.text);
});

test("older-turn cursor stays stable as new turns arrive", () => {
  const f = fixture();
  const first = f.deliver();
  const second = f.deliver();
  expect(f.conversation.recentTurns(1)[0]?.id).toBe(second.turn.id);
  f.deliver();
  expect(f.conversation.recentTurns(20, second.turn.id).map((t) => t.id)).toEqual([first.turn.id]);
});

test("an invalid queued target fails closed without poisoning later work", () => {
  const f = fixture(),
    first = f.deliver(),
    second = f.deliver(),
    owner = f.lease();
  const bad = f.queue(required(first.ids[0])),
    good = f.queue(required(second.ids[0]));
  f.store.db
    .query("UPDATE core_conversation_outbox SET text_version=2 WHERE id=?")
    .run(bad.deliveryId);
  expect(f.edits.claim("42", owner)).toBeNull();
  expect(f.edits.messages(first.turn.id, "42")[0]?.edit?.failureCode).toBe("edit_target_changed");
  expect(f.edits.claim("42", owner)?.id).toBe(good.id);
});

test("an edit invalidates archive pagination instead of reusing stale search offsets", () => {
  const f = fixture(),
    first = f.deliver();
  f.deliver();
  const owner = f.lease();
  const memory = createMemoryService(f.store),
    page = memory.conversationSearch({ query: "reply", role: "assistant", limit: 1 });
  expect(page.nextCursor).toBeTruthy();
  f.queue(required(first.ids[0]));
  const claim = required(f.edits.claim("42", owner));
  f.edits.finish(claim, {
    status: "applied",
    messageId: claim.telegramMessageId,
    unchanged: false,
  });
  expect(() =>
    memory.conversationSearch({
      query: "reply",
      role: "assistant",
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    }),
  ).toThrow();
});
