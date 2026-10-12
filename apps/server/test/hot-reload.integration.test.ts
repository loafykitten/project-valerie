import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Opt in explicitly: this starts an isolated real Bun --hot listener. All source,
// SQLite and HTTP traffic are fictional and kept in a fresh temporary directory.
const enabled = process.env.VALERIE_TEST_NETWORK === "1";

test.skipIf(!enabled)(
  "Bun --hot retains listener/store and recovers from invalid edits",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "valerie-hot-test-"));
    const entry = join(directory, "entry.ts");
    const handler = join(directory, "handler.ts");
    const runtimeImport = JSON.stringify(resolve(import.meta.dir, "../src/runtime.ts"));
    const coreImport = JSON.stringify(
      resolve(import.meta.dir, "../../../packages/core/src/index.ts"),
    );
    const source = (label: string, fail = false) => `
    import { existsSync, writeFileSync } from "node:fs";
    export function buildHandler(store, diagnostics) {
      ${fail ? 'throw new Error("Fictional reconstruction error");' : ""}
      const label = ${JSON.stringify(label)};
      return async request => {
        const path = new URL(request.url).pathname;
        if (path === "/slow") {
          writeFileSync("slow-started", "ready");
          while (!existsSync("release")) await Bun.sleep(10);
        }
        if (request.method === "PUT") store.db.query("UPDATE fixture SET value = ?").run(await request.text());
        return Response.json({ label, ...diagnostics,
          value: store.db.query("SELECT value FROM fixture").get().value,
          startups: store.db.query("SELECT count(*) AS count FROM core_activity WHERE kind = 'service.started'").get().count,
          signals: [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
        });
      };
    }
  `;
    await writeFile(handler, source("first"));
    await writeFile(
      entry,
      `
    import { writeFileSync } from "node:fs";
    import { openStore, createActivityService } from ${coreImport};
    import { activateRuntime } from ${runtimeImport};
    import { buildHandler } from "./handler.ts";
    globalThis.fixtureSlot ??= {};
    try {
      const runtime = activateRuntime(globalThis.fixtureSlot, {
        host: "127.0.0.1", port: 0, database: "fictional.sqlite", origins: [], timezone: "UTC"
      }, "test-v1", buildHandler, {
        openStore(path) {
          const store = openStore(path);
          store.db.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('initial')");
          return store;
        },
        listen(config, fetch) {
          const server = Bun.serve({ hostname: config.host, port: config.port, fetch });
          globalThis.fixturePort = server.port;
          return server;
        },
        onSignal: (signal, callback) => process.on(signal, callback),
        offSignal: (signal, callback) => process.off(signal, callback),
        recordStarted: store => createActivityService(store).append({ kind: "service.started", summary: "Fictional startup", status: "succeeded" }),
        now: () => new Date().toISOString(), instanceId: () => crypto.randomUUID(),
        onShutdownComplete: () => process.exit(0),
      });
      writeFileSync("ready.json", JSON.stringify({port: globalThis.fixturePort, ...runtime.diagnostics}));
    } catch (error) {
      console.error("Fictional bootstrap failed", error);
      writeFileSync("rejected", "Fictional reconstruction rejected");
    }
  `,
    );
    const child = Bun.spawn([process.execPath, "--hot", entry], {
      cwd: directory,
      // Do not pass provider credentials or the real database configuration to the child.
      env: { PATH: process.env.PATH },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const value = await read();
          if (accepts(value)) return value;
        } catch {
          // Initial listener/file creation and soft evaluation can still be pending.
        }
        await Bun.sleep(30);
      }
      throw new Error("Timed out waiting for the fictional hot-reload fixture.");
    }
    let failed = false;
    try {
      const ready = await waitFor(
        async () =>
          JSON.parse(await readFile(join(directory, "ready.json"), "utf8")) as { port: number },
        (value) => value.port > 0,
      );
      const url = `http://127.0.0.1:${ready.port}`;
      const get = async () => (await fetch(url, { signal: AbortSignal.timeout(1000) })).json();
      const first = await get();
      expect(first.label).toBe("first");
      expect(first.generation).toBe(1);
      expect(first.startups).toBe(1);
      expect(first.signals).toEqual([1, 1]);
      await fetch(url, { method: "PUT", body: "persisted fictional value" });
      const slow = fetch(`${url}/slow`, { signal: AbortSignal.timeout(20_000) });
      await waitFor(
        () => readFile(join(directory, "slow-started"), "utf8"),
        (value) => value === "ready",
      );
      await writeFile(handler, source("second"));
      const second = await waitFor(get, (value) => value.label === "second");
      expect(second.instanceId).toBe(first.instanceId);
      expect(second.startedAt).toBe(first.startedAt);
      expect(second.generation).toBeGreaterThan(first.generation);
      expect(second.startups).toBe(1);
      expect(second.signals).toEqual([1, 1]);
      expect(second.value).toBe("persisted fictional value");
      await writeFile(join(directory, "release"), "done");
      const old = await (await slow).json();
      expect(old.label).toBe("first");
      expect(old.generation).toBe(1);
      await writeFile(handler, source("broken", true));
      await waitFor(() => readFile(join(directory, "rejected"), "utf8"), Boolean);
      expect((await get()).label).toBe("second");
      await writeFile(handler, "export const syntaxFailure = ;\n");
      // Syntax failure is reported by Bun before our bootstrap can run. Confirm the
      // previous listener answers throughout a bounded window, then correct the edit.
      for (let n = 0; n < 10; n++) {
        await Bun.sleep(50);
        expect((await get()).label).toBe("second");
      }
      await writeFile(handler, source("recovered"));
      const recovered = await waitFor(get, (value) => value.label === "recovered");
      expect(recovered.instanceId).toBe(first.instanceId);
      expect(recovered.startups).toBe(1);
      expect(recovered.signals).toEqual([1, 1]);
      expect(recovered.value).toBe("persisted fictional value");
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(7000).then(() => false),
      ]);
      if (!exited) child.kill("SIGKILL");
      const exitCode = await child.exited;
      const logs = await Promise.all([stdout, stderr]);
      if (failed) console.error(logs.join("\n").slice(-3000));
      await rm(directory, { recursive: true, force: true });
      if (!failed) {
        expect(exited).toBe(true);
        expect(exitCode).toBe(0);
      }
    }
  },
  30_000,
);
