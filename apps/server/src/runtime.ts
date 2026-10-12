import { resolve } from "node:path";
import type { Store } from "@valerie/core";
import type { ServerConfig } from "./config";

export interface RuntimeDiagnostics {
  instanceId: string;
  startedAt: string;
  generation: number;
}

export type RequestHandler = (request: Request) => Response | Promise<Response>;
export interface BackgroundLifecycle {
  stop(): Promise<void>;
  status(): unknown;
}
type Signal = "SIGINT" | "SIGTERM";
interface Listener {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export interface RuntimeDependencies {
  openStore(path: string): Store;
  listen(config: ServerConfig, fetch: RequestHandler): Listener;
  onSignal(signal: Signal, handler: () => void): void;
  offSignal(signal: Signal, handler: () => void): void;
  recordStarted(store: Store): void;
  now(): string;
  instanceId(): string;
  shutdownGraceMs?: number;
  onShutdownComplete?(): void;
  startBackground?(store: Store): BackgroundLifecycle;
}

export interface Runtime {
  readonly store: Store;
  readonly contract: string;
  readonly binding: string;
  diagnostics: RuntimeDiagnostics;
  handler: RequestHandler;
  stopping: boolean;
  background?: BackgroundLifecycle;
  shutdown(): Promise<void>;
}

export interface RuntimeSlot {
  current?: Runtime;
}

/**
 * Bootstrap owns persistent resources; reloadable modules only construct request handlers.
 * Bump the contract when schema, lifecycle or listener options change. Such edits require
 * a controlled process restart, just like a database path, bind address or port change.
 * Future pollers/timers must live behind a separate explicitly managed lifecycle; never
 * start them in a handler factory. Bun --hot re-evaluates every imported module.
 */
export function activateRuntime(
  slot: RuntimeSlot,
  config: ServerConfig,
  contract: string,
  buildHandler: (store: Store, diagnostics: RuntimeDiagnostics) => RequestHandler,
  dependencies: RuntimeDependencies,
): Runtime {
  const binding = JSON.stringify([
    config.host,
    config.port,
    config.database === ":memory:" ? config.database : resolve(config.database),
  ]);
  const previous = slot.current;
  if (previous) {
    if (previous.stopping) throw new Error("Valerie is shutting down; restart before reloading.");
    if (previous.contract !== contract || previous.binding !== binding) {
      throw new Error("Valerie's runtime configuration or contract changed. Restart required.");
    }
    const diagnostics = {
      ...previous.diagnostics,
      generation: previous.diagnostics.generation + 1,
    };
    // Constructors currently seed missing prompt rows. Roll back those writes if any
    // part of reconstruction fails, and retain the previously published handler.
    const handler = previous.store.db
      .transaction(() => buildHandler(previous.store, diagnostics))
      .immediate();
    previous.handler = handler;
    previous.diagnostics = diagnostics;
    return previous;
  }

  const store = dependencies.openStore(config.database);
  const diagnostics = {
    startedAt: dependencies.now(),
    instanceId: dependencies.instanceId(),
    generation: 1,
  };
  let listener: Listener | undefined;
  let stopPromise: Promise<void> | undefined;
  let signalsAttached = false;
  const runtime: Runtime = {
    store,
    contract,
    binding,
    diagnostics,
    handler: () => new Response("Valerie is starting.", { status: 503 }),
    stopping: false,
    shutdown() {
      if (stopPromise) return stopPromise;
      runtime.stopping = true;
      if (signalsAttached) {
        dependencies.offSignal("SIGINT", signalShutdown);
        dependencies.offSignal("SIGTERM", signalShutdown);
        signalsAttached = false;
      }
      stopPromise = (async () => {
        // Abort and join background work before closing its shared database.
        const backgroundStopped = runtime.background?.stop();
        // Bound the drain: idle proxy keep-alive sockets must not defer SQLite
        // closure until the container supervisor sends SIGKILL.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let drained = false;
        try {
          drained = await Promise.race([
            Promise.resolve(listener?.stop(false)).then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), dependencies.shutdownGraceMs ?? 5000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!drained) await listener?.stop(true);
        await backgroundStopped;
        store.close();
        dependencies.onShutdownComplete?.();
      })();
      return stopPromise;
    },
  };
  const signalShutdown = () => {
    void runtime.shutdown();
  };
  try {
    store.db
      .transaction(() => {
        runtime.handler = buildHandler(store, diagnostics);
        listener = dependencies.listen(config, (request) => {
          // Capture before invoking: an in-flight request finishes on its old closure.
          const handler = runtime.handler;
          return handler(request);
        });
        dependencies.recordStarted(store);
      })
      .immediate();
    runtime.background = dependencies.startBackground?.(store);
    dependencies.onSignal("SIGINT", signalShutdown);
    dependencies.onSignal("SIGTERM", signalShutdown);
    signalsAttached = true;
    slot.current = runtime;
    return runtime;
  } catch (error) {
    // Startup is synchronous, so the listener cannot have accepted work yet.
    void listener?.stop(true);
    store.close();
    throw error;
  }
}
