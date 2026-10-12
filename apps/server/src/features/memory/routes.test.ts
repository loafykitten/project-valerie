import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createMemoryService,
  openStore,
  type Store,
} from "@valerie/core";
import { createApp } from "../../app";
import { loadConfig } from "../../config";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  const app = createApp(store, loadConfig({}), {});
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers?: Record<string, string>,
  ) =>
    app.request(`http://localhost:3100/api/memory${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, request };
}

test("owner memory edits persist revisions, pin explicitly, and reject stale or over-budget saves", async () => {
  const { request, store } = setup();
  const original = { title: "Tea", body: "I prefer mint tea.", tier: "short", kind: "preference" };
  const savedResponse = await request("/records", "POST", original);
  expect(savedResponse.status).toBe(200);
  expect(savedResponse.headers.get("Cache-Control")).toBe("no-store");
  const saved = await savedResponse.json();
  const pinnedResponse = await request(`/records/${saved.id}`, "PUT", {
    ...original,
    tier: "core",
    expectedVersion: saved.version,
  });
  expect(pinnedResponse.status).toBe(200);
  const pinned = await pinnedResponse.json();
  expect(pinned.tier).toBe("core");
  expect(pinned.provenance[0].sourceType).toBe("owner");
  expect(
    (await request(`/records/${saved.id}`, "PUT", { ...original, expectedVersion: saved.version }))
      .status,
  ).toBe(409);
  expect((await (await request(`/records/${saved.id}?version=1`)).json()).tier).toBe("short");
  expect((await request(`/records/${saved.id}?version=invalid`)).status).toBe(400);
  expect((await request(`/records/${saved.id}?offset=-1`)).status).toBe(400);
  const status = await (await request("/status")).json();
  expect(
    (
      await request("/settings", "PUT", {
        ...status.settings,
        coreTokens: 0,
        expectedVersion: status.settings.version,
      })
    ).status,
  ).toBe(409);
  expect(
    (await request(`/records/${saved.id}/archive`, "POST", { expectedVersion: pinned.version }))
      .status,
  ).toBe(200);
  expect(createMemoryService(store).capture("tea").core).toHaveLength(0);
  expect((await (await request("/search?q=tea&includeArchive=true")).json()).items).toHaveLength(1);
  expect((await request(`/records/${saved.id}`)).status).toBe(404);
  expect((await (await request(`/records/${saved.id}?includeArchive=true`)).json()).state).toBe(
    "archived",
  );
});

test("memory API distinguishes tiers and exposes thoughts and original conversation evidence privately", async () => {
  const { request, store } = setup();
  const conversations = createConversationService(store);
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "123",
        senderId: "123",
        text: "I collect ceramic frogs.",
      },
    ],
  });
  const input = store.db
    .query<{ id: string; turnId: string }, []>(
      "SELECT id,turn_id AS turnId FROM core_telegram_inputs",
    )
    .get();
  if (!input) throw new Error("Missing fictional source.");
  const memory = createMemoryService(store);
  const record = memory.saveShort({
    title: "Frog collection",
    body: "Ember collects ceramic frogs.",
    thoughts: "A watercolor might be a thoughtful idea.",
    kind: "preference",
    sourceIds: [`conversation:${input.id}`],
    turnId: input.turnId,
    operationKey: "fixture",
  });
  await request("/records", "POST", {
    title: "Core context",
    body: "A fictional stable preference.",
    tier: "core",
    kind: "preference",
  });
  const core = await (await request("/search?q=&source=records&tier=core")).json();
  const short = await (await request("/search?q=&source=records&tier=short")).json();
  expect(core.items.map((item: { tier: string }) => item.tier)).toEqual(["core"]);
  expect(short.items.map((item: { id: string }) => item.id)).toEqual([record.id]);
  expect(short.items[0].thoughtsSnippet).toContain("watercolor");
  expect((await request("/search?tier=invalid")).status).toBe(400);
  const sourcePath = `/conversations/${encodeURIComponent(`conversation:${input.id}`)}`;
  const source = await request(sourcePath);
  expect(source.headers.get("Cache-Control")).toBe("no-store");
  expect((await source.json()).text).toBe("I collect ceramic frogs.");
  expect(
    (await request(sourcePath, "GET", undefined, { Origin: "https://untrusted.example" })).status,
  ).toBe(403);
  expect((await request(`${sourcePath}?offset=-1`)).status).toBe(400);
  const edited = await (
    await request(`/records/${record.id}`, "PUT", {
      title: record.title,
      body: record.body,
      thoughts: "Updated owner interpretation.",
      tier: "short",
      kind: record.kind,
      expectedVersion: record.version,
      authoredBy: "valerie",
    })
  ).json();
  expect(edited.authoredBy).toBe("owner");
  expect(
    edited.provenance.some(
      (item: { sourceId: string }) => item.sourceId === `conversation:${input.id}`,
    ),
  ).toBe(true);
  expect(edited.thoughts).toBe("Updated owner interpretation.");
});

test("memory API retains private access checks and rejects malformed writes without side effects", async () => {
  const { request, store } = setup();
  expect(
    (await request("/status", "GET", undefined, { Origin: "https://untrusted.example" })).status,
  ).toBe(403);
  expect(
    (await request("/records", "POST", { title: "bad", body: "bad", tier: "long", kind: "fact" }))
      .status,
  ).toBe(400);
  expect((await request("/records", "POST", null)).status).toBe(400);
  expect((await request("/settings", "PUT", { coreTokens: "invalid" })).status).toBe(400);
  expect((await request("/search?source=private")).status).toBe(400);
  expect((await request("/search?q=&limit=31")).status).toBe(400);
  expect((await request("/topics?q=&limit=not-a-number")).status).toBe(400);
  expect((await request("/conversations?q=hello&limit=0")).status).toBe(400);
  expect((await request("/notes?folder=Notes&limit=31")).status).toBe(400);
  expect((await request("/notes?folder=Notes%2F..%2FPrivate")).status).toBe(400);
  const library = await request("/notes?folder=Notes");
  expect(library.status).toBe(200);
  expect(library.headers.get("Cache-Control")).toBe("no-store");
  expect((await library.json()).folders).toEqual([]);
  expect(createMemoryService(store).status().activeRecords).toBe(0);
});

test("vault reading pages the requested revision after a synced edit and cannot save over source prose", async () => {
  const { store, request } = setup();
  const memory = createMemoryService(store);
  const original = "A fictional source paragraph. ".repeat(600);
  const scan = (body: string, sourceHash: string) =>
    memory.ingestVault({
      notes: [
        {
          path: "Notes/Fictional.md",
          title: "Fictional",
          body,
          sourceHash,
          modifiedAt: "2026-09-14T00:00:00.000Z",
          historical: false,
        },
      ],
      scannedAt: "2026-09-14T00:00:00.000Z",
      status: "ready",
      complete: true,
      unavailablePaths: [],
      unavailablePrefixes: [],
    });
  scan(original, "a".repeat(64));
  const id = memory.search({ query: "Fictional" }).items[0]?.id;
  expect(id).toBeDefined();
  const first = await (await request(`/records/${id}`)).json();
  expect(first.nextOffset).toBeGreaterThan(0);
  scan("Newer authored prose.", "b".repeat(64));
  const second = await (
    await request(`/records/${id}?version=${first.version}&offset=${first.nextOffset}`)
  ).json();
  expect(first.body + second.body).toBe(original);
  expect(second.nextOffset).toBeNull();
  expect(
    (
      await request(`/records/${id}`, "PUT", {
        title: "Changed",
        body: "Unauthorized replacement",
        tier: "short",
        kind: "fact",
        expectedVersion: 2,
      })
    ).status,
  ).toBe(409);
  expect((await (await request(`/records/${id}`)).json()).body).toBe("Newer authored prose.");
});

test("a rejected budget edit reports its actual reason and keeps the current settings", async () => {
  const { request } = setup();
  await request("/records", "POST", {
    title: "Core preference",
    body: "I prefer a quiet room.",
    tier: "core",
    kind: "preference",
  });
  const before = await (await request("/status")).json();
  const rejected = await request("/settings", "PUT", {
    ...before.settings,
    coreTokens: 0,
    expectedVersion: before.settings.version,
  });
  expect(rejected.status).toBe(409);
  expect((await rejected.json()).error).toContain("budget");
  expect((await (await request("/status")).json()).settings).toEqual(before.settings);
});
