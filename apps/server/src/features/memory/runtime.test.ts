import { afterEach, expect, test } from "bun:test";
import { createMemoryService, openStore, type Store, type VaultIngestScan } from "@valerie/core";
import type { BackgroundLifecycle } from "../../runtime";
import { startMemoryRuntime } from "./runtime";

const stores: Store[] = [];
const runtimes: BackgroundLifecycle[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const store of stores.splice(0)) store.close();
});

function database() {
  const store = openStore(":memory:");
  stores.push(store);
  return store;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function scan(): VaultIngestScan {
  return {
    notes: [
      {
        path: "Notes/Fictional.md",
        title: "Fictional",
        body: "A fictional lavender preference",
        sourceHash: "a".repeat(64),
        modifiedAt: "2026-01-01T00:00:00.000Z",
        historical: false,
      },
    ],
    complete: true,
    unavailablePaths: [],
    unavailablePrefixes: [],
    scannedAt: "2026-09-14T00:00:00.000Z",
    status: "ready",
  };
}

test("conversation startup waits for the initial vault reconciliation", async () => {
  const store = database();
  const initial = deferred<VaultIngestScan>();
  const started = deferred<void>();
  let calls = 0;
  const runtime = startMemoryRuntime({
    store,
    vaultRoot: "/fictional/vault",
    scan: () => initial.promise,
    startConversation() {
      calls++;
      expect(createMemoryService(store).search({ query: "lavender" }).items).toHaveLength(1);
      started.resolve();
      return { stop: async () => {}, status: () => ({ state: "running" }) };
    },
  });
  runtimes.push(runtime);
  expect(calls).toBe(0);
  expect(runtime.status()).toMatchObject({ state: "starting" });
  initial.resolve(scan());
  await started.promise;
  expect(calls).toBe(1);
  expect(runtime.status()).toMatchObject({ state: "running" });
});

test("removing vault configuration deactivates its old index before starting conversation", async () => {
  const store = database();
  const memory = createMemoryService(store);
  memory.ingestVault(scan());
  const previous = memory.search({ query: "lavender" }).items[0];
  const started = deferred<void>();
  let scans = 0;
  const runtime = startMemoryRuntime({
    store,
    scan: async () => {
      scans++;
      return scan();
    },
    startConversation() {
      expect(memory.search({ query: "lavender" }).items).toHaveLength(0);
      started.resolve();
      return { stop: async () => {}, status: () => ({ state: "running" }) };
    },
  });
  runtimes.push(runtime);
  await started.promise;
  expect(scans).toBe(0);
  expect(memory.status().vault).toMatchObject({ status: "unavailable", reason: "missing" });
  expect(previous).toBeDefined();
  expect(
    store.db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM core_memory_revisions WHERE id=?",
      )
      .get(previous?.id ?? "")?.count,
  ).toBeGreaterThan(0);
});

test("a failed scan withdraws stale sources and exposes only a bounded safe reason", async () => {
  const store = database();
  const memory = createMemoryService(store);
  memory.ingestVault(scan());
  const started = deferred<void>();
  const runtime = startMemoryRuntime({
    store,
    vaultRoot: "/fictional/private/vault",
    scan: async () => {
      throw new Error("secret-path-and-content");
    },
    startConversation() {
      started.resolve();
      return { stop: async () => {}, status: () => ({ state: "running" }) };
    },
  });
  runtimes.push(runtime);
  await started.promise;
  expect(memory.search({ query: "lavender" }).items).toHaveLength(0);
  expect(memory.status().vault).toMatchObject({ status: "unavailable", reason: "io" });
  expect(JSON.stringify([memory.status(), runtime.status()])).not.toContain("secret");
});

test("periodic scans serialize, and stop joins both the active scan and conversation", async () => {
  const store = database();
  const secondStarted = deferred<void>();
  const second = deferred<VaultIngestScan>();
  const workerStopping = deferred<void>();
  const workerStopped = deferred<void>();
  let scans = 0;
  let stops = 0;
  const runtime = startMemoryRuntime({
    store,
    vaultRoot: "/fictional/vault",
    intervalMs: 1,
    scan: async () => {
      scans++;
      if (scans === 1) return scan();
      secondStarted.resolve();
      return second.promise;
    },
    startConversation: () => ({
      stop: async () => {
        stops++;
        workerStopping.resolve();
        await workerStopped.promise;
      },
      status: () => ({ state: "running" }),
    }),
  });
  runtimes.push(runtime);
  await secondStarted.promise;
  // Advance another event-loop turn while the scan remains blocked. Scheduling is
  // chained to completion, so another timer cannot open a competing scan.
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(scans).toBe(2);
  const stopped = runtime.stop();
  expect(runtime.stop()).toBe(stopped);
  await workerStopping.promise;
  let completed = false;
  void stopped.then(() => {
    completed = true;
  });
  workerStopped.resolve();
  await Promise.resolve();
  expect(completed).toBe(false);
  second.resolve({ ...scan(), notes: [] });
  await stopped;
  expect(stops).toBe(1);
  expect(scans).toBe(2);
  // A shutdown scan is joined but cannot mutate the shared store after stop.
  expect(createMemoryService(store).search({ query: "lavender" }).items).toHaveLength(1);
});

test("stopping during initial scanning never starts the conversation worker", async () => {
  const store = database();
  const initial = deferred<VaultIngestScan>();
  let calls = 0;
  const runtime = startMemoryRuntime({
    store,
    vaultRoot: "/fictional/vault",
    scan: () => initial.promise,
    startConversation: () => {
      calls++;
      return { stop: async () => {}, status: () => ({ state: "running" }) };
    },
  });
  runtimes.push(runtime);
  const stopped = runtime.stop();
  initial.resolve(scan());
  await stopped;
  expect(calls).toBe(0);
  expect(createMemoryService(store).status().vaultNotes).toBe(0);
  expect(runtime.status()).toMatchObject({ state: "stopped" });
});

test("failed reconciliation commits stop the worker and report a safe failure", async () => {
  const store = database();
  const workerStopped = deferred<void>();
  let scans = 0;
  const runtime = startMemoryRuntime({
    store,
    vaultRoot: "/fictional/vault",
    intervalMs: 1,
    scan: async () => {
      scans++;
      const result = scan();
      if (scans > 1) result.notes.push(...result.notes);
      return result;
    },
    startConversation: () => ({
      stop: async () => {
        workerStopped.resolve();
      },
      status: () => ({ state: "running" }),
    }),
  });
  runtimes.push(runtime);
  await workerStopped.promise;
  expect(runtime.status()).toMatchObject({
    state: "failed",
    lastError: "memory_reconciliation_failed",
  });
  await runtime.stop();
  expect(scans).toBe(2);
});
