import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationService, createMemoryService, openStore, type Store } from "../src";

const stores: Store[] = [],
  directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  const now = () => new Date("2026-09-14T12:00:00.000Z");
  const conversations = createConversationService(store, { now, memoryTools: true });
  const memory = createMemoryService(store, { now });
  const add = (
    id: number,
    text: string,
    chatId = "123",
    senderId = "123",
    receivedAt = now().toISOString(),
  ) => {
    conversations.acceptTelegramBatch({
      nextOffset: id + 1,
      inputs: [{ updateId: id, messageId: String(id), chatId, senderId, text, receivedAt }],
    });
    const row = store.db
      .query<{ id: string; turnId: string }, [number]>(
        "SELECT id,turn_id AS turnId FROM core_telegram_inputs WHERE update_id=?",
      )
      .get(id);
    if (!row) throw new Error("Missing fictional source.");
    return { ...row, sourceId: `conversation:${row.id}` };
  };
  return { store, conversations, memory, add };
}

test("a synthesized memory can cite older owner evidence with separate searchable thoughts", () => {
  const f = fixture();
  const original =
    "I collect ceramic frogs because they remind me of the pond near my childhood home.";
  const old = f.add(1, original, "123", "123", "2026-08-31T12:00:00.000Z");
  const current = f.add(2, "Please remember that frog topic from the other day.");
  const found = f.memory.conversationSearch({
    query: "ceramic",
    role: "user",
    turnId: current.turnId,
  });
  expect(found.items.map((item) => item.id)).toEqual([old.sourceId]);
  expect(f.memory.conversationRead({ id: old.sourceId, turnId: current.turnId })?.text).toBe(
    original,
  );
  const input = {
    title: "Frogs and childhood memories",
    body: "Ember collects ceramic frogs that evoke a childhood pond.",
    thoughts:
      "A watercolor of a frog might be a thoughtful idea; this is my suggestion, not a stated preference.",
    kind: "preference" as const,
    sourceIds: [old.sourceId],
    turnId: current.turnId,
    operationKey: "historical-save",
  };
  const saved = f.memory.saveShort(input);
  expect(saved.body).not.toBe(original);
  expect(saved.authoredBy).toBe("valerie");
  expect(saved.provenance).toEqual([
    {
      sourceType: "conversation",
      sourceId: old.sourceId,
      observedAt: "2026-08-31T12:00:00.000Z",
      quote: original,
    },
  ]);
  expect(f.memory.saveShort(input).id).toBe(saved.id);
  const result = f.memory.search({ query: "watercolor", tier: "short" }).items[0];
  expect(result?.id).toBe(saved.id);
  expect(result?.thoughtsSnippet).toContain("watercolor");
  const snapshot = f.memory.capture("watercolor");
  expect(snapshot.content).toContain('"interpretation"');
  expect(snapshot.content).toContain("not an owner fact");
  expect(snapshot.retrievedTokens).toBeLessThanOrEqual(snapshot.settings.retrievedTokens);
  expect(snapshot.core).toHaveLength(0);
});

test("history reads and saves cannot cross conversation, owner, or future-turn boundaries", () => {
  const f = fixture();
  const old = f.add(1, "I like ceramic frogs.");
  const otherChat = f.add(2, "Other conversation frogs.", "999", "123");
  const otherSender = f.add(3, "Another sender's frogs.", "123", "999");
  const current = f.add(4, "Remember the earlier topic.");
  const future = f.add(5, "A future statement about frogs.");
  expect(
    f.memory
      .conversationSearch({ query: "frogs", turnId: current.turnId, role: "user" })
      .items.map((item) => item.id),
  ).toEqual([old.sourceId]);
  for (const source of [otherChat, otherSender, future]) {
    expect(f.memory.conversationRead({ id: source.sourceId, turnId: current.turnId })).toBeNull();
    expect(() =>
      f.memory.saveShort({
        title: "Frogs",
        body: "A sourced summary.",
        kind: "fact",
        sourceIds: [source.sourceId],
        turnId: current.turnId,
        operationKey: source.id,
      }),
    ).toThrow("available owner message IDs");
  }
  expect(() =>
    f.memory.saveShort({
      body: "An assistant claim.",
      kind: "fact",
      sourceIds: ["delivery:fictional"],
      turnId: current.turnId,
      operationKey: "assistant-source",
    }),
  ).toThrow("available owner message IDs");
  expect(f.memory.status().activeRecords).toBe(0);
});

test("a combined memory retains each original source and a source-only repair preserves authored text", () => {
  const f = fixture();
  const first = f.add(1, "The ceramics class was tiring, and the wheel jammed.");
  const second = f.add(2, "I repaired the wheel, and the vase is finished now.");
  const saved = f.memory.saveShort({
    title: "Ceramics class",
    body: "Ember had a tiring ceramics class, repaired a jammed wheel, and finished a vase.",
    thoughts: "A quiet evening might be welcome.",
    kind: "experience",
    sourceIds: [second.sourceId],
    turnId: second.turnId,
    operationKey: "initial",
  });
  const repaired = f.memory.saveShort({
    id: saved.id,
    expectedVersion: saved.version,
    title: saved.title,
    body: saved.body,
    thoughts: saved.thoughts,
    kind: saved.kind,
    expiresAt: saved.expiresAt,
    sourceIds: [first.sourceId, second.sourceId],
    turnId: second.turnId,
    operationKey: "source-repair",
  });
  expect(repaired.provenance.map((source) => source.sourceId)).toEqual([
    first.sourceId,
    second.sourceId,
  ]);
  expect(repaired.body).toBe(saved.body);
  expect(repaired.thoughts).toBe(saved.thoughts);
  expect(repaired.expiresAt).toBe(saved.expiresAt);
  expect(repaired.authoredBy).toBe("valerie");
  expect(f.memory.read({ id: saved.id, revision: 1 })?.provenance).toHaveLength(1);
});

test("short-memory corrections retain revisions, clear obsolete thoughts, and reject stale/core/vault edits", () => {
  const f = fixture();
  const old = f.add(1, "I collect ceramic frogs.");
  const first = f.memory.saveShort({
    title: "Frog collection",
    body: "Ember collects ceramic frogs.",
    thoughts: "Watercolor might be a gift idea.",
    kind: "preference",
    sourceIds: [old.sourceId],
    turnId: old.turnId,
    operationKey: "first",
  });
  const corrected = f.add(2, "I prefer frog plushies now, not ceramics.");
  const input = {
    id: first.id,
    expectedVersion: first.version,
    title: "Frog collection",
    body: "Ember now prefers frog plushies over ceramics.",
    thoughts: "",
    kind: "preference" as const,
    sourceIds: [corrected.sourceId],
    turnId: corrected.turnId,
    operationKey: "correction",
  };
  const updated = f.memory.saveShort(input);
  expect(updated.version).toBe(2);
  expect(updated.thoughts).toBeUndefined();
  expect(updated.provenance.map((source) => source.sourceId)).toEqual([
    corrected.sourceId,
    old.sourceId,
  ]);
  expect(f.memory.read({ id: first.id, revision: 1 })?.thoughts).toContain("Watercolor");
  expect(f.memory.search({ query: "watercolor" }).items).toHaveLength(0);
  expect(f.memory.saveShort(input)).toEqual(updated);
  expect(() => f.memory.saveShort({ ...input, operationKey: "stale" })).toThrow("changed since");
  const pinned = f.memory.save({
    tier: "core",
    kind: "fact",
    title: "Owner-pinned context",
    body: "A fictional stable fact.",
  });
  expect(() =>
    f.memory.saveShort({
      ...input,
      id: pinned.id,
      expectedVersion: pinned.version,
      operationKey: "core",
    }),
  ).toThrow("Only active short-term");
  f.memory.ingestVault({
    notes: [
      {
        path: "Notes/Fictional.md",
        title: "Fictional note",
        body: "Authored vault prose.",
        sourceHash: "a".repeat(64),
        modifiedAt: "2026-09-14T12:00:00.000Z",
        historical: false,
      },
    ],
    complete: true,
    unavailablePaths: [],
    unavailablePrefixes: [],
    scannedAt: "2026-09-14T12:00:00.000Z",
    status: "ready",
  });
  const vault = f.memory.search({ query: "", tier: "long" }).items[0];
  if (!vault) throw new Error("Missing fictional note.");
  expect(() =>
    f.memory.saveShort({
      ...input,
      id: vault.id,
      expectedVersion: vault.version,
      operationKey: "vault",
    }),
  ).toThrow("Only active short-term");
  expect(f.memory.status()).toMatchObject({ coreRecords: 1, shortRecords: 1, vaultNotes: 1 });
  expect(
    f.memory.search({ query: "", source: "records", tier: "core" }).items.map((item) => item.id),
  ).toEqual([pinned.id]);
});

test("repeated updates bound current source links while preserving earlier evidence in revisions", () => {
  const f = fixture();
  const first = f.add(1, "First fictional frog preference.");
  let record = f.memory.saveShort({
    body: "First frog preference.",
    kind: "preference",
    sourceIds: [first.sourceId],
    turnId: first.turnId,
    operationKey: "source-1",
  });
  for (let n = 2; n <= 12; n++) {
    const source = f.add(n, `Updated fictional frog preference ${n}.`);
    record = f.memory.saveShort({
      id: record.id,
      expectedVersion: record.version,
      body: `Updated frog preference ${n}.`,
      kind: "preference",
      sourceIds: [source.sourceId],
      turnId: source.turnId,
      operationKey: `source-${n}`,
    });
    expect(record.provenance[0]?.sourceId).toBe(source.sourceId);
  }
  expect(record.provenance).toHaveLength(10);
  expect(record.provenanceTruncated).toBe(true);
  const ownerEdit = f.memory.save({
    id: record.id,
    expectedVersion: record.version,
    title: record.title,
    body: "Owner-corrected frog preference.",
    thoughts: "Owner interpretation.",
    kind: record.kind,
    tier: "short",
  });
  expect(ownerEdit.provenance).toHaveLength(10);
  expect(ownerEdit.provenance[0]?.sourceType).toBe("owner");
  expect(ownerEdit.provenanceTruncated).toBe(true);
  expect(f.memory.read({ id: record.id, revision: 1 })?.provenance[0]?.sourceId).toBe(
    first.sourceId,
  );
});

test("conversation evidence pages preserve exact text and reject invalid ranges", () => {
  const f = fixture();
  const text = "A fictional pond story. 🐸 ".repeat(100);
  const source = f.add(1, text),
    current = f.add(2, "Recall the pond story.");
  let offset = 0,
    combined = "";
  do {
    const part = f.memory.conversationRead({
      id: source.sourceId,
      turnId: current.turnId,
      offset,
      maxBytes: 100,
    });
    if (!part) throw new Error("Missing source page.");
    combined += part.text;
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  } while (offset < text.length);
  expect(combined).toBe(text);
  expect(() => f.memory.conversationRead({ id: source.sourceId, offset: -1 })).toThrow("range");
});

test("thought-search migration rebuilds only the index and preserves exact memory revisions", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-memory-synthesis-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite"),
    f = fixture(path);
  const saved = f.memory.save({
    tier: "short",
    kind: "fact",
    title: "Fictional frog note",
    body: "Frogs are a favorite topic.",
    thoughts: "A watercolor is only a tentative idea.",
  });
  const original = f.store.db
    .query<{ record_json: string }, [string]>(
      "SELECT record_json FROM core_memory_revisions WHERE id=?",
    )
    .get(saved.id)?.record_json;
  f.store.db.exec(
    "DELETE FROM core_memory_fts; INSERT INTO core_memory_fts(id,title,body) SELECT id,title,body FROM core_memory_documents; DELETE FROM core_migrations WHERE id='010-memory-synthesis';",
  );
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const reopened = fixture(path);
  expect(reopened.memory.search({ query: "watercolor" }).items[0]?.id).toBe(saved.id);
  expect(
    reopened.store.db
      .query<{ record_json: string }, [string]>(
        "SELECT record_json FROM core_memory_revisions WHERE id=?",
      )
      .get(saved.id)?.record_json,
  ).toBe(original);
  expect(reopened.store.db.query("PRAGMA integrity_check").get()).toEqual({
    integrity_check: "ok",
  });
});
