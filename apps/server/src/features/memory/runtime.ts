import { createMemoryService, type Store, type VaultIngestScan } from "@valerie/core";
import type { BackgroundLifecycle } from "../../runtime";
import { scanVault } from "./vault";

/** Startup and serialized reconciliation belong to the persistent process lifecycle. */
export function startMemoryRuntime(options: {
  store: Store;
  vaultRoot?: string;
  startConversation: () => BackgroundLifecycle;
  scan?: (root: string) => Promise<VaultIngestScan>;
  intervalMs?: number;
}): BackgroundLifecycle {
  const memory = createMemoryService(options.store);
  let stopping = false;
  let failed = false;
  let conversation: BackgroundLifecycle | undefined;
  let conversationStopped: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;

  async function reconcile() {
    let scan: VaultIngestScan;
    try {
      scan = options.vaultRoot
        ? await (options.scan ?? scanVault)(options.vaultRoot)
        : {
            notes: [],
            scannedAt: new Date().toISOString(),
            complete: false,
            unavailablePaths: [],
            unavailablePrefixes: [""],
            status: "unavailable",
            reason: "missing",
          };
    } catch {
      scan = {
        notes: [],
        scannedAt: new Date().toISOString(),
        complete: false,
        unavailablePaths: [],
        unavailablePrefixes: [""],
        status: "unavailable",
        reason: "io",
      };
    }
    if (!stopping) memory.ingestVault(scan);
  }

  function stopConversation() {
    conversationStopped ??= Promise.resolve().then(() => conversation?.stop());
    return conversationStopped;
  }

  function schedule() {
    if (stopping || failed || !options.vaultRoot) return;
    timer = setTimeout(() => {
      pending = reconcile()
        .catch(async () => {
          failed = true;
          // An ingestion failure must not leave inference recalling an index that
          // reconciliation could not withdraw. Ordinary read errors ingest safely.
          await stopConversation();
        })
        .finally(schedule);
      // Retain a failed join for shutdown, but do not leave a background promise
      // rejection unobserved if stopping the conversation itself fails.
      void pending.catch(() => {
        failed = true;
      });
    }, options.intervalMs ?? 30_000);
  }

  pending = (async () => {
    await reconcile();
    if (!stopping) {
      conversation = options.startConversation();
      schedule();
    }
  })().catch(() => {
    failed = true;
  });

  return {
    status: () =>
      failed
        ? { state: "failed", lastError: "memory_reconciliation_failed", lastUpdateAt: null }
        : (conversation?.status() ?? {
            state: stopping ? "stopped" : "starting",
            lastError: null,
            lastUpdateAt: null,
          }),
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (timer) clearTimeout(timer);
      stopPromise = Promise.allSettled([pending, stopConversation()]).then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new Error("Memory runtime shutdown failed.");
      });
      return stopPromise;
    },
  };
}
