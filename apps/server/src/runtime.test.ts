import { describe, expect, test } from "bun:test";
import { openStore, type Store } from "@valerie/core";
import { loadConfig } from "./config";
import { activateRuntime, type RuntimeDependencies, type RuntimeSlot } from "./runtime";

function fixture() {
  const slot: RuntimeSlot = {};
  const config = loadConfig({ VALERIE_DATABASE: ":memory:" });
  const counts = { open: 0, listen: 0, started: 0, close: 0, stop: 0 };
  const signals = new Map<string, () => void>();
  let dispatch = (_request: Request): Response | Promise<Response> => new Response("missing");
  let finishDrain = () => {};
  const draining = new Promise<void>((resolve) => {
    finishDrain = resolve;
  });
  const dependencies: RuntimeDependencies = {
    openStore(path) {
      counts.open++;
      const store = openStore(path);
      return {
        db: store.db,
        close: () => {
          counts.close++;
          store.close();
        },
      };
    },
    listen(_config, handler) {
      counts.listen++;
      dispatch = handler;
      return {
        stop: async () => {
          counts.stop++;
          await draining;
        },
      };
    },
    recordStarted(store) {
      counts.started++;
      store.db
        .query("INSERT INTO core_activity VALUES (?, ?, ?, ?, ?, ?)")
        .run("startup", "service.started", "Fictional startup", "succeeded", "2026-01-01", "{}");
    },
    onSignal: (signal, handler) => {
      signals.set(signal, handler);
    },
    offSignal: (signal, handler) => {
      if (signals.get(signal) === handler) signals.delete(signal);
    },
    now: () => "2026-01-01T00:00:00.000Z",
    instanceId: () => "fictional-instance",
  };
  return {
    slot,
    config,
    counts,
    signals,
    dependencies,
    finishDrain,
    request: () => dispatch(new Request("http://localhost/")),
  };
}

describe("reloadable HTTP runtime", () => {
  test("background worker starts once across reloads and stops before database closure", async () => {
    const f = fixture();
    let starts = 0;
    let stops = 0;
    let release = () => {};
    const joined = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.dependencies.startBackground = () => {
      starts++;
      return {
        status: () => "running",
        stop: async () => {
          stops++;
          await joined;
        },
      };
    };
    const runtime = activateRuntime(
      f.slot,
      f.config,
      "v1",
      () => () => new Response(),
      f.dependencies,
    );
    activateRuntime(f.slot, f.config, "v1", () => () => new Response(), f.dependencies);
    expect(starts).toBe(1);
    f.finishDrain();
    const stopping = runtime.shutdown();
    await Promise.resolve();
    expect(stops).toBe(1);
    expect(f.counts.close).toBe(0);
    release();
    await stopping;
    expect(f.counts.close).toBe(1);
  });

  test("reload retains one store/listener/startup and captures each request's handler", async () => {
    const f = fixture();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = activateRuntime(
      f.slot,
      f.config,
      "v1",
      (_store, diagnostics) => async () => {
        await pending;
        return Response.json(diagnostics);
      },
      f.dependencies,
    );
    const oldRequest = f.request();
    const second = activateRuntime(
      f.slot,
      f.config,
      "v1",
      (_store, diagnostics) => () => Response.json(diagnostics),
      f.dependencies,
    );
    expect(second).toBe(first);
    expect(await (await f.request()).json()).toEqual({
      instanceId: "fictional-instance",
      startedAt: "2026-01-01T00:00:00.000Z",
      generation: 2,
    });
    release();
    expect((await (await oldRequest).json()).generation).toBe(1);
    expect(f.counts).toEqual({ open: 1, listen: 1, started: 1, close: 0, stop: 0 });
    expect([...f.signals.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    expect(first.store.db.query("SELECT count(*) AS count FROM core_activity").get()).toEqual({
      count: 1,
    });
    f.finishDrain();
    await first.shutdown();
  });

  test("failed reconstruction rolls back writes and keeps the active handler/generation", async () => {
    const f = fixture();
    const runtime = activateRuntime(
      f.slot,
      f.config,
      "v1",
      () => () => new Response("working"),
      f.dependencies,
    );
    expect(() =>
      activateRuntime(
        f.slot,
        f.config,
        "v1",
        (store) => {
          store.db.query("UPDATE core_activity SET summary = ?").run("Uncommitted change");
          throw new Error("Fictional construction failure");
        },
        f.dependencies,
      ),
    ).toThrow("Fictional construction failure");
    expect(await (await f.request()).text()).toBe("working");
    expect(runtime.diagnostics.generation).toBe(1);
    expect(runtime.store.db.query("SELECT summary FROM core_activity").get()).toEqual({
      summary: "Fictional startup",
    });
    f.finishDrain();
    await runtime.shutdown();
  });

  test("port, bind, database and contract changes require restart before reconstruction", async () => {
    const f = fixture();
    const runtime = activateRuntime(
      f.slot,
      f.config,
      "v1",
      () => () => new Response("working"),
      f.dependencies,
    );
    let constructed = 0;
    const build = (_store: Store) => {
      constructed++;
      return () => new Response("changed");
    };
    for (const config of [
      { ...f.config, port: 4000 },
      { ...f.config, host: "::1" },
      { ...f.config, database: "other.sqlite" },
    ]) {
      expect(() => activateRuntime(f.slot, config, "v1", build, f.dependencies)).toThrow(
        "Restart required",
      );
    }
    expect(() => activateRuntime(f.slot, f.config, "v2", build, f.dependencies)).toThrow(
      "Restart required",
    );
    expect(constructed).toBe(0);
    expect(await (await f.request()).text()).toBe("working");
    f.finishDrain();
    await runtime.shutdown();
  });

  test("shutdown removes both signals, drains before closing, and runs once", async () => {
    const f = fixture();
    const runtime = activateRuntime(
      f.slot,
      f.config,
      "v1",
      () => () => new Response("working"),
      f.dependencies,
    );
    const stopping = runtime.shutdown();
    expect(runtime.shutdown()).toBe(stopping);
    expect(f.signals.size).toBe(0);
    expect(f.counts.close).toBe(0);
    expect(f.counts.stop).toBe(1);
    expect(() =>
      activateRuntime(f.slot, f.config, "v1", () => () => new Response(), f.dependencies),
    ).toThrow("shutting down");
    f.finishDrain();
    await stopping;
    expect(f.counts.close).toBe(1);
  });

  test("failed initial handler construction closes the store without starting a listener", () => {
    const f = fixture();
    expect(() =>
      activateRuntime(
        f.slot,
        f.config,
        "v1",
        () => {
          throw new Error("Fictional failure");
        },
        f.dependencies,
      ),
    ).toThrow("Fictional failure");
    expect(f.slot.current).toBeUndefined();
    expect(f.counts).toEqual({ open: 1, listen: 0, started: 0, close: 1, stop: 0 });
    expect(f.signals.size).toBe(0);
  });

  test("stalled keep-alive drain is force-closed before SQLite and completion", async () => {
    const f = fixture();
    const order: string[] = [];
    const open = f.dependencies.openStore;
    f.dependencies.openStore = (path) => {
      const store = open(path);
      return {
        db: store.db,
        close: () => {
          order.push("database closed");
          store.close();
        },
      };
    };
    f.dependencies.shutdownGraceMs = 10;
    f.dependencies.listen = () => ({
      stop: async (force) => {
        order.push(force ? "forced" : "draining");
        if (!force) await new Promise<void>(() => {});
      },
    });
    f.dependencies.onShutdownComplete = () => {
      order.push("complete");
    };
    const runtime = activateRuntime(
      f.slot,
      f.config,
      "v2",
      () => () => new Response("ready"),
      f.dependencies,
    );
    await runtime.shutdown();
    expect(order).toEqual(["draining", "forced", "database closed", "complete"]);
    expect(f.counts.close).toBe(1);
    await runtime.shutdown();
    expect(order).toHaveLength(4);
  });
});
