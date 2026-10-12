import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConversationService,
  createMemoryService,
  MemoryBudgetError,
  MemoryConflictError,
  MemoryCursorError,
  openStore,
  type Store,
  type VaultIngestNote,
  type VaultIngestScan,
} from "../src";

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture result.");
  return value;
}
function fixture(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  let clock = new Date("2026-09-14T12:00:00Z");
  const memory = createMemoryService(store, { now: () => clock });
  const conversations = createConversationService(store, { now: () => clock, memoryTools: true });
  const settings = conversations.getSettings();
  if (!settings.model)
    conversations.saveSettings({
      ...settings,
      model: "fictional",
      expectedVersion: settings.version,
    });
  return {
    store,
    memory,
    conversations,
    setTime: (value: string) => {
      clock = new Date(value);
    },
  };
}
function note(path: string, body: string): VaultIngestNote {
  return {
    path,
    title: path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
    body,
    sourceHash: createHash("sha256").update(body).digest("hex"),
    modifiedAt: "2025-01-01T00:00:00Z",
    historical: path.startsWith("Archive/"),
  };
}
function scan(notes: VaultIngestNote[], other: Partial<VaultIngestScan> = {}): VaultIngestScan {
  return {
    notes,
    complete: true,
    unavailablePaths: [],
    unavailablePrefixes: [],
    scannedAt: "2026-09-14T12:00:00Z",
    status: "ready",
    ...other,
  };
}
const short = (body: string) => ({
  tier: "short" as const,
  kind: "preference" as const,
  title: "Fictional preference",
  body,
});
test("note browsing preserves folder boundaries and counts descendants without dumping them", () => {
  const f = fixture();
  f.memory.ingestVault(
    scan([
      note("Notes/Music/Plans.md", "piano"),
      note("Notes/Music/Album/Bravo.md", "orchid melody"),
      note("Notes/Music/Album/Alpha.md", "orchid song"),
      note("Notes/Musicology/Book.md", "orchid study"),
      note("Notes/Home/Plan.md", "orchid garden"),
      note("Topics/Music.md", "a guide"),
      note("Archive/Old/Plan.md", "old"),
    ]),
  );
  const root = f.memory.browseNotes();
  expect(root.items).toEqual([]);
  expect(root.folders).toEqual([
    { name: "Home", path: "Notes/Home", noteCount: 1 },
    { name: "Music", path: "Notes/Music", noteCount: 3 },
    { name: "Musicology", path: "Notes/Musicology", noteCount: 1 },
  ]);
  const music = f.memory.browseNotes({ folder: "Notes/Music" });
  expect(music.items.map((item) => item.title)).toEqual(["Plans"]);
  expect(music.folders).toEqual([{ name: "Album", path: "Notes/Music/Album", noteCount: 2 }]);
  const matches = f.memory.browseNotes({ folder: "Notes/Music", query: "orchid" });
  expect(matches.items.map((item) => item.title)).toEqual(["Alpha", "Bravo"]);
  expect(f.memory.browseNotes({ folder: "" }).folders.map((item) => item.name)).toEqual([
    "Notes",
    "Topics",
  ]);
  expect(
    f.memory.browseNotes({ folder: "", includeArchive: true }).folders.map((item) => item.name),
  ).toEqual(["Archive", "Notes", "Topics"]);
  expect(f.memory.browseNotes({ folder: "Archive" }).noteCount).toBe(0);
});

test("folder paging is scoped, alphabetical, literal and invalidated when indexed notes change", () => {
  const f = fixture();
  const notes = [
    note("Notes/100%_done/B.md", "test"),
    note("Notes/100%_done/A.md", "test"),
    note("Notes/100other/C.md", "test"),
  ];
  f.memory.ingestVault(scan(notes));
  const first = f.memory.browseNotes({ folder: "Notes/100%_done", limit: 1 });
  expect(first.noteCount).toBe(2);
  expect(first.items[0]?.title).toBe("A");
  expect(
    f.memory.browseNotes({ folder: "Notes/100%_done", limit: 1, cursor: first.nextCursor ?? "" })
      .items[0]?.title,
  ).toBe("B");
  expect(() =>
    f.memory.browseNotes({ folder: "Notes/100other", limit: 1, cursor: first.nextCursor ?? "" }),
  ).toThrow();
  for (const folder of [
    "../Notes",
    "Notes/../Private",
    "/Notes",
    "Notes//Home",
    "Private",
    "Valerie/Suggestions",
    "Notes\\Home",
  ])
    expect(() => f.memory.browseNotes({ folder })).toThrow();
  f.memory.ingestVault(scan([notes[0] as VaultIngestNote, notes[2] as VaultIngestNote]));
  expect(f.memory.browseNotes({ folder: "Notes/100%_done" }).noteCount).toBe(1);
  expect(() =>
    f.memory.browseNotes({ folder: "Notes/100%_done", limit: 1, cursor: first.nextCursor ?? "" }),
  ).toThrow();
  expect(f.memory.browseNotes({ folder: "Notes/100%_done", query: "?!" }).items).toEqual([]);
});
function accept(f: ReturnType<typeof fixture>, id: number, text: string) {
  f.conversations.acceptTelegramBatch({
    nextOffset: id + 1,
    inputs: [{ updateId: id, messageId: String(id), chatId: "123", senderId: "123", text }],
  });
  return f.conversations.startNextTurn();
}

test("records survive restart, preserve revisions, and reject lost updates and duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "valerie-memory-"));
  dirs.push(dir);
  const f = fixture(join(dir, "store.sqlite"));
  const saved = f.memory.save(short("I prefer cool blue lighting."));
  const edited = f.memory.save({
    ...short("I prefer warm amber lighting."),
    id: saved.id,
    expectedVersion: 1,
  });
  expect(edited.version).toBe(2);
  expect(() => f.memory.save({ ...short("Lost edit"), id: saved.id, expectedVersion: 1 })).toThrow(
    MemoryConflictError,
  );
  expect(() => f.memory.save(short("I prefer warm amber lighting."))).toThrow(MemoryConflictError);
  const reopened = fixture(join(dir, "store.sqlite"));
  expect(reopened.memory.search({ query: "amber" }).items[0]?.id).toBe(saved.id);
  expect(reopened.memory.search({ query: "cool" }).items).toHaveLength(0);
  expect(reopened.memory.read({ id: saved.id, revision: 1 })?.body).toBe(
    "I prefer cool blue lighting.",
  );
});

test("expiry and supersession preserve evidence but leave ordinary retrieval", () => {
  const f = fixture();
  const saved = f.memory.save({
    ...short("This week's trail is Pine Ridge."),
    expiresAt: "2026-09-15T00:00:00Z",
  });
  f.setTime("2026-09-16T00:00:00Z");
  expect(f.memory.search({ query: "Pine" }).items).toHaveLength(0);
  expect(f.memory.search({ query: "Pine", includeArchive: true }).items[0]?.state).toBe("archived");
  expect(f.memory.read({ id: saved.id, revision: 1 })?.state).toBe("active");
  const old = f.memory.save(short("I like red lamps."));
  const replacement = f.memory.save({
    ...short("I now like green lamps."),
    supersedesId: old.id,
    supersedesVersion: old.version,
  });
  expect(replacement.supersedesId).toBe(old.id);
  expect(f.memory.read({ id: old.id, includeArchive: true })?.state).toBe("superseded");
  expect(f.memory.search({ query: "red" }).items).toHaveLength(0);
});

test("core is owner pinned, never silently truncated, and budgets reject conflicting edits", () => {
  const f = fixture();
  const saved = f.memory.save({ ...short("I prefer a quiet greeting."), tier: "core" });
  expect(f.memory.capture("unrelated").core[0]?.body).toBe(saved.body);
  expect(() => f.memory.save({ ...short("x".repeat(2000)), tier: "core" })).toThrow(
    MemoryBudgetError,
  );
  const settings = f.memory.getSettings();
  expect(() =>
    f.memory.saveSettings({ ...settings, expectedVersion: settings.version, coreTokens: 10 }),
  ).toThrow(MemoryBudgetError);
  const shortRecord = f.memory.save(short("I prefer mint tea."));
  f.memory.save({
    ...short("I prefer mint tea."),
    id: shortRecord.id,
    expectedVersion: shortRecord.version,
    tier: "core",
  });
  expect(f.memory.capture("unrelated").core).toHaveLength(2);
});

test("vault indexing is revisioned, idempotent and respects explicit Archive retrieval", () => {
  const f = fixture();
  const notes = [
    note("Notes/Lantern.md", "Old amber lantern"),
    note("Topics/Hiking.md", "Pine Ridge hiking"),
    note("Archive/Past.md", "An old lantern trip"),
  ];
  expect(f.memory.ingestVault(scan(notes)).changed).toBe(3);
  expect(f.memory.ingestVault(scan(notes)).changed).toBe(0);
  const initial = f.memory.search({ query: "lantern" });
  expect(initial.items).toHaveLength(1);
  const id = initial.items[0]?.id ?? "";
  expect(f.memory.search({ query: "lantern", includeArchive: true }).items).toHaveLength(2);
  f.memory.ingestVault(scan([note("Notes/Lantern.md", "New silver lantern"), ...notes.slice(1)]));
  expect(f.memory.read({ id, revision: 1 })?.body).toBe("Old amber lantern");
  expect(f.memory.read({ id })?.body).toBe("New silver lantern");
  expect(f.memory.topicsList().items[0]?.sourcePath).toBe("Topics/Hiking.md");
  expect(f.memory.read({ id })?.provenance[0]?.observedAt).toBe("2026-09-14T12:00:00.000Z");
});

test("missing and newly forbidden vault paths deactivate reads while partial skipped scans retain indexed notes", () => {
  const f = fixture();
  f.memory.ingestVault(
    scan([note("Notes/Allowed.md", "Silver lantern"), note("Notes/Removed.md", "Amber lamp")]),
  );
  const id = f.memory.search({ query: "Silver" }).items[0]?.id ?? "";
  f.memory.ingestVault(scan([], { complete: false, status: "partial", reason: "limit" }));
  expect(f.memory.read({ id })).not.toBeNull();
  f.memory.ingestVault(
    scan([], { complete: false, status: "partial", unavailablePrefixes: ["Notes/Allowed.md"] }),
  );
  expect(f.memory.read({ id })).toBeNull();
  expect(f.memory.read({ id, revision: 1 })).toBeNull();
  expect(f.memory.search({ query: "Silver", includeArchive: true }).items).toHaveLength(0);
  expect(f.memory.search({ query: "Amber" }).items).toHaveLength(1);
  f.memory.ingestVault(scan([]));
  expect(f.memory.status().vaultNotes).toBe(0);
});

test("FTS searches quote operators as data and provides bounded nonrepeating pages", () => {
  const f = fixture();
  for (let i = 0; i < 7; i++)
    f.memory.save({ ...short(`Lantern preference ${i}`), title: `Lantern ${i}` });
  const one = f.memory.search({ query: 'lantern OR "', limit: 3 });
  expect(one.items).toHaveLength(3);
  expect(one.nextCursor).not.toBeNull();
  const two = f.memory.search({
    query: 'lantern OR "',
    limit: 3,
    cursor: one.nextCursor ?? undefined,
  });
  expect(two.items).toHaveLength(3);
  expect(new Set([...one.items, ...two.items].map((item) => item.id)).size).toBe(6);
  expect(() =>
    f.memory.search({ query: "different", cursor: one.nextCursor ?? undefined }),
  ).toThrow("cursor");
  f.memory.save(short("Fresh lantern entry"));
  expect(() =>
    f.memory.search({ query: 'lantern OR "', limit: 3, cursor: one.nextCursor ?? undefined }),
  ).toThrow(MemoryCursorError);
});

test("long vault reads page exact Unicode text and can pin an old revision", () => {
  const f = fixture();
  const body = "🍃 woodland path ".repeat(1500);
  f.memory.ingestVault(scan([note("Notes/Walk.md", body)]));
  const id = f.memory.search({ query: "woodland" }).items[0]?.id ?? "";
  let offset: number | undefined = 0,
    joined = "";
  while (offset !== undefined) {
    const page = f.memory.read({ id, revision: 1, offset, maxBytes: 800 });
    if (!page) throw new Error();
    joined += page.body;
    offset = page.nextOffset ?? undefined;
  }
  expect(joined).toBe(body);
  f.memory.ingestVault(scan([note("Notes/Walk.md", "A changed note")]));
  expect(f.memory.read({ id, revision: 1, maxBytes: 800 })?.body).toBe(
    body.slice(0, f.memory.read({ id, revision: 1, maxBytes: 800 })?.body.length),
  );
});

test("conversation archive finds old uncurated owner phrases and only receipt-confirmed assistant chunks", () => {
  const f = fixture();
  const turn = must(accept(f, 1, "The unique violet badger story"));
  f.conversations.completeGeneration(turn.id, {
    text: "Sent silver fox. Unsure gold moth.",
    chunks: ["Sent silver fox. ", "Unsure gold moth."],
  });
  const sent = must(f.conversations.claimDelivery());
  f.conversations.recordDelivery(sent.id, { status: "sent", messageId: "9" });
  const uncertain = must(f.conversations.claimDelivery());
  f.conversations.recordDelivery(uncertain.id, { status: "unknown", code: "timeout" });
  f.setTime("2026-12-01T00:00:00Z");
  expect(f.memory.conversationSearch({ query: "violet badger" }).items[0]?.role).toBe("user");
  expect(f.memory.conversationSearch({ query: "silver fox" }).items[0]?.role).toBe("assistant");
  expect(f.memory.conversationSearch({ query: "gold moth" }).items).toHaveLength(0);
});

test("model saves keep owner evidence and replay idempotently", () => {
  const f = fixture();
  const turn = must(accept(f, 1, "I prefer mint tea. Please remember it."));
  const source = f.memory.conversationSearch({ query: "mint" }).items[0]?.id ?? "";
  const input = {
    title: "mint tea",
    body: "Ember prefers mint tea.",
    kind: "preference" as const,
    sourceIds: [source],
    operationKey: `${turn.id}:call1`,
    turnId: turn.id,
  };
  const saved = f.memory.saveShort(input);
  expect(f.memory.saveShort(input).id).toBe(saved.id);
  expect(saved.provenance[0]?.sourceId).toBe(source);
  expect(saved.tier).toBe("short");
  expect(saved.body).toBe("Ember prefers mint tea.");
  expect(saved.provenance[0]?.quote).toContain("I prefer mint tea.");
  expect(() =>
    f.memory.saveShort({ ...input, turnId: "wrong-turn", operationKey: "new3" }),
  ).toThrow("available owner message IDs");
});

test.each([undefined, "", "🦉".repeat(100)])(
  "empty or oversized tool titles are derived from the summary: %s",
  (title) => {
    const f = fixture();
    const body = "I prefer chamomile tea before painting.";
    const turn = must(accept(f, 1, body));
    const source = must(f.memory.conversationSearch({ query: "chamomile" }).items[0]);
    const saved = f.memory.saveShort({
      title,
      body,
      kind: "preference",
      sourceIds: [source.id],
      turnId: turn.id,
      operationKey: "derived-title",
    });
    expect(saved.title).toBe(body);
    expect(saved.body).toBe(body);
    expect(saved.tier).toBe("short");
    expect(saved.provenance[0]?.sourceId).toBe(source.id);
  },
);

test("derived titles are bounded valid Unicode", () => {
  const f = fixture();
  const body = "🦉".repeat(100);
  const turn = must(accept(f, 1, body));
  const input = f.store.db.query<{ id: string }, []>("SELECT id FROM core_telegram_inputs").get();
  const saved = f.memory.saveShort({
    body,
    kind: "experience",
    sourceIds: [`conversation:${must(input).id}`],
    turnId: turn.id,
    operationKey: "unicode-title",
  });
  expect(Buffer.byteLength(saved.title)).toBeLessThanOrEqual(120);
  expect(saved.title).toBe("🦉".repeat(30));
});

test("turn snapshots reserve and pin memory across correction and generation retry", () => {
  const f = fixture();
  const saved = f.memory.save({ ...short("I prefer mint tea."), tier: "core" });
  f.memory.ingestVault(scan([note("Notes/Tea.md", "Mint tea is the fictional topic.")]));
  const first = must(accept(f, 1, "Tell me about mint tea"));
  expect(first.snapshot.memory?.core[0]?.body).toBe(saved.body);
  f.memory.save({
    ...short("I prefer black tea."),
    id: saved.id,
    expectedVersion: saved.version,
    tier: "core",
  });
  f.conversations.failGeneration(first.id, { code: "timeout", retryAt: "2026-09-14T12:00:01Z" });
  f.setTime("2026-09-14T12:00:02Z");
  const retry = must(f.conversations.startNextTurn());
  expect(retry.snapshot.memory).toEqual(first.snapshot.memory);
  f.conversations.failGeneration(first.id, { code: "failed" });
  const next = must(accept(f, 2, "Another tea topic"));
  expect(next.snapshot.memory?.core[0]?.body).toBe("I prefer black tea.");
  const memory = must(next.snapshot.memory);
  expect(memory.retrievedTokens).toBeLessThanOrEqual(memory.settings.retrievedTokens);
  expect(memory.topicTokens).toBeLessThanOrEqual(memory.settings.topicTokens);
});

test("topics stay useful inside their separate budget and corrupted over-budget core fails explicitly", () => {
  const f = fixture();
  f.memory.ingestVault(scan([note("Topics/Hiking.md", "Hiking paths ".repeat(1000))]));
  const captured = f.memory.capture("Hiking");
  expect(captured.topics).toHaveLength(1);
  expect(captured.topicTokens).toBeLessThanOrEqual(750);
  f.memory.save({ ...short("I prefer a kind greeting."), tier: "core" });
  f.store.db.query("UPDATE core_memory_settings SET core_tokens=1 WHERE singleton=1").run();
  expect(accept(f, 1, "Hello")).toBeNull();
  expect(f.conversations.recentTurns()[0]?.failureCode).toBe("core_memory_budget_exceeded");
});

test("a reminder preference is remembered as owner evidence without scheduling any action", () => {
  const f = fixture();
  const turn = must(accept(f, 1, "Gentle reminders help me begin."));
  const source = must(f.memory.conversationSearch({ query: "reminders" }).items[0]);
  const record = f.memory.saveShort({
    title: "Gentle reminders",
    body: "Gentle reminders help me begin.",
    kind: "preference",
    sourceIds: [source.id],
    turnId: turn.id,
    operationKey: "reminder-preference",
  });
  expect(record.provenance[0]?.sourceId).toBe(source.id);
  expect(f.memory.capture("reminders").content).toContain(
    "Do not infer reminder status or completed actions from memory",
  );
  expect(f.conversations.claimDelivery()).toBeNull();
  expect(f.memory.capture("reminders").core).toHaveLength(0);
});

test("archive and memory snippets include a unique match beyond the opening text", () => {
  const f = fixture();
  const body = `${"Ordinary opening prose. ".repeat(150)}The unique jasper hummingbird clue. ${"Trailing prose. ".repeat(150)}`;
  f.memory.ingestVault(scan([note("Notes/Story.md", body)]));
  expect(f.memory.search({ query: "jasper hummingbird" }).items[0]?.snippet).toContain(
    "jasper hummingbird",
  );
  expect(f.memory.capture("jasper hummingbird").retrieved[0]?.body).toContain("jasper hummingbird");
  accept(f, 1, body);
  const result = must(f.memory.conversationSearch({ query: "jasper hummingbird" }).items[0]);
  expect(result.snippet).toContain("jasper hummingbird");
  expect(result.truncated).toBe(true);
});

test("related follows authored wiki and Markdown links one hop without exposing historical or unavailable notes", () => {
  const f = fixture();
  f.memory.ingestVault(
    scan([
      note(
        "Topics/Walking.md",
        "See [[Notes/Pine|pine trail]], [river](../Notes/River.md), [[Archive/Old]], and [[Secret]].",
      ),
      note("Notes/Pine.md", "A pine route. [[Topics/Walking]]"),
      note("Notes/River.md", "A river route."),
      note("Archive/Old.md", "An old route."),
      note("Notes/Secret.md", "An excluded route."),
    ]),
  );
  const topic = must(f.memory.topicsList().items[0]);
  f.memory.ingestVault(
    scan([], { complete: false, status: "partial", unavailablePaths: ["Notes/Secret.md"] }),
  );
  const page = f.memory.related({ id: topic.id, limit: 1 });
  expect(page.items[0]?.sourcePath).toBe("Notes/Pine.md");
  expect(page.items[0]?.reasons).toEqual(["authored note link"]);
  const next = f.memory.related({ id: topic.id, limit: 1, cursor: page.nextCursor ?? undefined });
  expect(next.items[0]?.sourcePath).toBe("Notes/River.md");
  expect(next.nextCursor).toBeNull();
  expect(f.memory.related({ id: must(page.items[0]).id }).items[0]?.id).toBe(topic.id);
});

test("recent recall exposes pinned references and factual tool outcomes without prompt or source bodies", () => {
  const f = fixture();
  const record = f.memory.save({ ...short("Fictional sensitive body"), tier: "core" });
  const turn = must(accept(f, 1, "Hello"));
  f.store.db
    .query("INSERT INTO core_tool_rounds VALUES(?,0,'{}','2026-09-14T12:00:00Z')")
    .run(turn.id);
  f.store.db
    .query(
      "INSERT INTO core_tool_outcomes VALUES(?,0,0,'memory_search','read',?,'2026-09-14T12:00:00Z')",
    )
    .run(turn.id, JSON.stringify({ status: "succeeded", result: { privateBody: "hidden" } }));
  const recall = must(f.memory.recentRecall()[0]);
  expect(recall.core).toEqual([{ id: record.id, title: record.title, version: record.version }]);
  expect(recall.outcomes).toEqual([
    { id: "0:0", name: "memory_search", status: "succeeded", code: null },
  ]);
  expect(JSON.stringify(recall)).not.toContain("Fictional sensitive body");
  expect(JSON.stringify(recall)).not.toContain("hidden");
});

test("many short exchanges reserve the tool loop's full message overhead before history selection", () => {
  const f = fixture();
  const settings = f.conversations.getSettings();
  f.conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    contextTokens: 65536,
    historyTokens: 60000,
    modelCapabilities: {
      id: settings.model,
      displayName: "Fictional tools",
      maxContextTokens: settings.modelContextTokens,
      maxOutputTokens: settings.modelMaxOutputTokens,
      systemRole: true,
      reasoningEffort: false,
      deprecated: false,
      tools: true,
      reasoning: null,
      pricing: {
        currency: null,
        inputPerMillion: null,
        outputPerMillion: null,
        cachedInputPerMillion: null,
        pricingTbd: true,
      },
    },
  });
  const insert = f.store.db.query(
    "INSERT INTO core_conversation_turns(id,update_id,message_id,chat_id,sender_id,input_text,received_at,status,output_text) VALUES(?,?,?,'123','123',?,'2026-09-14T12:00:00Z','delivered',?)",
  );
  const input = f.store.db.query(
    "INSERT INTO core_telegram_inputs(id,turn_id,update_id,message_id,chat_id,sender_id,input_text,received_at) VALUES(?,?,?,?,'123','123',?,'2026-09-14T12:00:00Z')",
  );
  f.store.db
    .transaction(() => {
      for (let i = 1; i <= 1000; i++) {
        insert.run(`fixture-${i}`, i, String(i), "A tiny greeting", "A tiny reply");
        input.run(`fixture-${i}`, `fixture-${i}`, i, String(i), "A tiny greeting");
      }
    })
    .immediate();
  const turn = must(accept(f, 1001, "Hello"));
  expect(turn.snapshot.memoryToolsEnabled).toBe(true);
  const messageBytes = turn.snapshot.messages.reduce(
    (sum, message) =>
      sum +
      32 +
      Buffer.byteLength(
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        "utf8",
      ),
    0,
  );
  expect(
    128 + messageBytes + turn.snapshot.settings.maxOutputTokens + 2048 + 12000,
  ).toBeLessThanOrEqual(65536);
  expect(turn.snapshot.history.includedTurns).toBeLessThan(1000);
});

test("default reads and traversal exclude archived, superseded, expired and historical heads while explicit evidence stays labeled", () => {
  const f = fixture();
  const archived = f.memory.save(short("An archived lantern preference."));
  f.memory.archive({ id: archived.id, expectedVersion: archived.version });
  expect(f.memory.read({ id: archived.id })).toBeNull();
  expect(f.memory.related({ id: archived.id }).items).toHaveLength(0);
  expect(f.memory.read({ id: archived.id, includeArchive: true })?.state).toBe("archived");
  const original = must(f.memory.read({ id: archived.id, revision: 1 }));
  expect(original.state).toBe("active");
  expect(original.currentState).toBe("archived");
  expect(original.currentVersion).toBe(2);
  const superseded = f.memory.save(short("The previous lantern preference."));
  f.memory.save({
    ...short("The corrected lantern preference."),
    supersedesId: superseded.id,
    supersedesVersion: superseded.version,
  });
  expect(f.memory.read({ id: superseded.id })).toBeNull();
  expect(f.memory.related({ id: superseded.id }).items).toHaveLength(0);
  expect(f.memory.read({ id: superseded.id, revision: 1 })?.currentState).toBe("superseded");
  const expired = f.memory.save({
    ...short("A temporary lantern preference."),
    expiresAt: "2026-09-15T00:00:00Z",
  });
  f.setTime("2026-09-16T00:00:00Z");
  expect(f.memory.related({ id: expired.id }).items).toHaveLength(0);
  expect(f.memory.read({ id: expired.id })).toBeNull();
  expect(f.memory.read({ id: expired.id, includeArchive: true })?.state).toBe("archived");
  f.memory.ingestVault(
    scan([
      note("Notes/Current.md", "See [[Archive/Past]]."),
      note("Archive/Past.md", "See [[Notes/Current]]. A historical lantern note."),
    ]),
  );
  const historical = must(f.memory.search({ query: "historical", includeArchive: true }).items[0]);
  expect(f.memory.read({ id: historical.id })).toBeNull();
  expect(f.memory.related({ id: historical.id }).items).toHaveLength(0);
  expect(f.memory.read({ id: historical.id, includeArchive: true })?.currentHistorical).toBe(true);
  expect(f.memory.read({ id: historical.id, revision: 1 })?.currentHistorical).toBe(true);
  expect(f.memory.related({ id: historical.id, includeArchive: true }).items[0]?.sourcePath).toBe(
    "Notes/Current.md",
  );
});

test("punctuation-only searches are empty and automatic retrieval never falls back to browsing", () => {
  const f = fixture();
  f.memory.save(short("A personal lantern memory."));
  f.memory.save({ ...short("A pinned greeting preference."), tier: "core" });
  f.memory.ingestVault(scan([note("Topics/Lanterns.md", "A fictional lantern topic.")]));
  for (const query of ["?!", "—", "   ", "🪴"]) {
    expect(f.memory.search({ query }).items).toHaveLength(0);
    expect(f.memory.topicsList({ query }).items).toHaveLength(0);
    const capture = f.memory.capture(query);
    expect(capture.retrieved).toHaveLength(0);
    expect(capture.topics).toHaveLength(0);
    expect(capture.core).toHaveLength(1);
  }
  expect(f.memory.search({ query: "" }).items.length).toBeGreaterThan(0);
  expect(f.memory.topicsList().items).toHaveLength(1);
  expect(f.memory.topicsList({ query: "" }).items).toHaveLength(1);
  expect(f.memory.capture("").retrieved).toHaveLength(0);
  expect(accept(f, 1, "?!")?.snapshot.memory?.retrieved).toHaveLength(0);
});

test("automatic recall ignores filler while explicit lyric search and broad browsing remain available", () => {
  const f = fixture();
  f.memory.ingestVault(
    scan([
      note("Notes/Good Morning.md", "Good morning there, you and I, softly here with me."),
      note("Topics/Greetings.md", "Hello, good morning, how are you?"),
    ]),
  );
  const message = "Good morning Val! Thank you, really. How are you?";
  expect(f.memory.capture(message).retrieved).toHaveLength(0);
  expect(f.memory.capture(message).topics).toHaveLength(0);
  expect(f.memory.search({ query: "good morning", source: "vault" }).items).toHaveLength(2);
  expect(f.memory.search({ query: "", source: "vault" }).items).toHaveLength(2);
  expect(f.memory.topicsList().items).toHaveLength(1);
});

test("conversation recall reaches a later topic past the old prefix and word limits", () => {
  const f = fixture();
  const saved = f.memory.save(short("Ember prefers ceramic frogs on her desk."));
  f.memory.ingestVault(
    scan([
      note("Notes/Softly.md", "Thank you, here with me, softly good morning there."),
      note("Notes/Pond Song.md", "Ceramic frogs beside the pond, a fictional song."),
      note("Topics/Frogs.md", "Ceramic frogs are a collection topic."),
      note("Archive/Frogs.md", "Ceramic frogs in historical writing."),
    ]),
  );
  const message = `${"Thank you for being here with me. ".repeat(12)}\n\n${Array.from({ length: 100 }, (_, i) => `unrelated${i}`).join(" ")}\n\nCan you recall my ceramic frogs?`;
  const captured = must(accept(f, 1, message)?.snapshot.memory);
  expect(captured.retrieved.some((record) => record.id === saved.id)).toBe(true);
  expect(captured.retrieved.some((record) => record.title === "Softly")).toBe(false);
  expect(captured.retrieved.some((record) => record.historical)).toBe(false);
  expect(captured.topics.map((item) => item.title)).toContain("Frogs");
  expect(captured.retrievedTokens).toBeLessThanOrEqual(captured.settings.retrievedTokens);
  expect(captured.topicTokens).toBeLessThanOrEqual(captured.settings.topicTokens);
  // Relevant creative writing remains eligible; it is not excluded by source type.
  expect(
    f.memory
      .capture("Pond Song ceramic frogs")
      .retrieved.some((record) => record.title === "Pond Song"),
  ).toBe(true);
});

test("automatic recall keeps Unicode cues safe, and excludes expired and unavailable evidence", () => {
  const f = fixture();
  const noteRecord = f.memory.save(short("Ember likes café pottery."));
  f.memory.ingestVault(scan([note("Notes/Pottery.md", "Café pottery notes.")]));
  expect(
    f.memory.capture('?! café " OR *').retrieved.some((record) => record.id === noteRecord.id),
  ).toBe(true);
  f.memory.ingestVault(scan([]));
  f.setTime("2026-10-15T12:00:00Z");
  expect(f.memory.capture("café pottery").retrieved).toHaveLength(0);
});
