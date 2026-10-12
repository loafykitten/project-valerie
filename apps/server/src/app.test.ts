import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createActivityService,
  createCharacterService,
  createPromptService,
  openStore,
  type Store,
} from "@valerie/core";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { mountDashboard } from "./dashboard";
import { MAX_ADMIN_BODY_BYTES } from "./limits";

const stores: Store[] = [];
const tempDirectories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
});
function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  const config = loadConfig({});
  return { store, app: createApp(store, config, {}) };
}

describe("admin API", () => {
  test("order API persists changes, rejects stale or invalid input, and records only confirmed changes", async () => {
    const { app, store } = setup();
    const before = await (await app.request("http://localhost:3100/api/prompts")).json();
    const ids = before.prompts.map((prompt: { id: string }) => prompt.id).reverse();
    const request = (body: unknown, headers = { "Content-Type": "application/json" }) =>
      app.request("http://localhost:3100/api/prompts/order", {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
    const body = { ids, expectedOrderVersion: before.orderVersion };
    const response = await request(body);
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.prompts.map((prompt: { id: string }) => prompt.id)).toEqual(ids);
    expect(saved.orderVersion).toBe(before.orderVersion + 1);
    expect((await request(body)).status).toBe(409);
    expect(
      (await request({ ids: [ids[0], ids[0]], expectedOrderVersion: saved.orderVersion })).status,
    ).toBe(400);
    expect((await request({ ids: [], expectedOrderVersion: saved.orderVersion })).status).toBe(409);
    expect((await request({ ids, expectedOrderVersion: 0 })).status).toBe(400);
    expect((await request(body, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await request({ ids, expectedOrderVersion: saved.orderVersion })).status).toBe(200);
    expect(
      createActivityService(store)
        .list()
        .filter((event) => event.kind === "prompt.reordered"),
    ).toHaveLength(1);
    expect(createPromptService(store).catalog()).toEqual(saved);
    const preview = await (await app.request("http://localhost:3100/api/prompts/preview")).json();
    expect(preview.orderVersion).toBe(saved.orderVersion);
  });
  test("display host label is bounded and independent of listener binding", async () => {
    const store = openStore(":memory:");
    stores.push(store);
    const config = loadConfig({ VALERIE_HOST_LABEL: "homelab" });
    expect(config.host).toBe("127.0.0.1");
    const app = createApp(
      store,
      config,
      {},
      { instanceId: "fictional", startedAt: "2026-01-01T00:00:00Z", generation: 3 },
    );
    const status = await (await app.request("http://localhost:3100/api/status")).json();
    expect(status.runtime).toEqual({
      hostname: "homelab",
      instanceId: "fictional",
      startedAt: "2026-01-01T00:00:00Z",
      generation: 3,
    });
    for (const label of [
      "",
      "  ",
      "x".repeat(81),
      "host\nname",
      "host\u0000name",
      "host\u007fname",
    ]) {
      expect(() => loadConfig({ VALERIE_HOST_LABEL: label })).toThrow("display host label");
    }
  });
  test("private character metadata and status reflect imports without exposing the source", async () => {
    const { app, store } = setup();
    const before = await app.request("http://localhost:3100/api/status");
    expect((await before.json()).characterImported).toBe(false);
    createCharacterService(store).import(
      Buffer.from(
        JSON.stringify({
          name: "Fictional source",
          description: "Private fictional authored content.",
          post_history_instructions: "Fictional after-history rule.",
          extensions: { secret_note: "Private fictional extension contents." },
        }),
      ),
      { sourceFilename: "fictional.json", expectedActiveImportId: null },
    );
    const after = await app.request("http://localhost:3100/api/status");
    expect((await after.json()).characterImported).toBe(true);
    const response = await app.request("http://localhost:3100/api/character");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("Private fictional");
    expect(JSON.parse(text).character.displayName).toBe("Valerie");
    const preview = await app.request("http://localhost:3100/api/prompts/preview");
    expect((await preview.json()).postHistoryContent).toBe(
      "# Post-History Instructions\n\nFictional after-history rule.",
    );
  });
  test("saves content verbatim, previews it immediately, and rejects stale writes", async () => {
    const { app, store } = setup();
    const prompt = createPromptService(store).get("personality");
    if (!prompt) throw new Error("Missing seeded prompt");
    const content = "  Authored text.\n*An action.*\n";
    const request = (version: number) =>
      app.request("http://localhost:3100/api/prompts/personality", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, expectedVersion: version }),
      });
    expect((await request(prompt.version)).status).toBe(200);
    expect((await request(prompt.version)).status).toBe(409);
    const preview = await app.request("http://localhost:3100/api/prompts/preview");
    expect((await preview.json()).content).toContain(content);
    const history = await app.request("http://localhost:3100/api/prompts/personality/history");
    expect((await history.json()).revisions).toHaveLength(2);
  });

  test("personal dashboard needs no login and rejects foreign browser origins and hosts", async () => {
    const { app } = setup();
    const status = await app.request("http://localhost:3100/api/status");
    expect(status.status).toBe(200);
    expect((await status.json()).runtime.hostname).toBeString();
    expect(
      (
        await app.request("http://localhost:3100/api/status", {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
    ).toBe(403);
    expect((await app.request("http://untrusted.example:3100/api/status")).status).toBe(403);
    const hostileWrite = await app.request("http://localhost:3100/api/prompts/personality", {
      method: "PUT",
      headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Unwanted edit", expectedVersion: 1 }),
    });
    expect(hostileWrite.status).toBe(403);
    const crossSite = await app.request("http://localhost:3100/api/status", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const allowed = await app.request("http://localhost:3100/api/status", {
      headers: { Origin: "http://localhost:5173", "Sec-Fetch-Site": "same-origin" },
    });
    expect(allowed.status).toBe(200);
  });

  test("invalid JSON, unsupported channels, and oversized bodies do not mutate prompts", async () => {
    const { app } = setup();
    const bad = await app.request("http://localhost:3100/api/prompts/personality", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(bad.status).toBe(400);
    expect(
      (await app.request("http://localhost:3100/api/prompts/preview?channel=invalid")).status,
    ).toBe(400);
    const huge = await app.request("http://localhost:3100/api/prompts/personality", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "a".repeat(MAX_ADMIN_BODY_BYTES + 1), expectedVersion: 1 }),
    });
    expect(huge.status).toBe(413);
  });

  test("private-only binding cannot be widened, including with obsolete token configuration", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.50", "100.64.1.2", "example.com"]) {
      expect(() => loadConfig({ VALERIE_HOST: host })).toThrow("loopback");
      expect(() =>
        loadConfig({ VALERIE_HOST: host, VALERIE_ADMIN_TOKEN: "old-configured-secret" }),
      ).toThrow("loopback");
    }
    expect(loadConfig({ VALERIE_HOST: "localhost" }).host).toBe("127.0.0.1");
    expect(loadConfig({ VALERIE_HOST: "::1" }).host).toBe("::1");
    expect(() => loadConfig({ VALERIE_ADMIN_TOKEN: "old-configured-secret" })).toThrow(
      "Dashboard tokens have been removed",
    );
  });

  test("private reverse-proxy origin is explicit and not trusted from forwarded headers", async () => {
    const store = openStore(":memory:");
    stores.push(store);
    const app = createApp(
      store,
      loadConfig({ VALERIE_ORIGINS: "https://homelab.example.ts.net" }),
      {},
    );
    const privateRequest = await app.request("https://homelab.example.ts.net/api/status", {
      headers: { Origin: "https://homelab.example.ts.net" },
    });
    expect(privateRequest.status).toBe(200);
    const spoofed = await app.request("http://evil.example/api/status", {
      headers: { "X-Forwarded-Host": "homelab.example.ts.net" },
    });
    expect(spoofed.status).toBe(403);
  });

  test("dashboard shell, static assets and SPA fallback retain security headers", async () => {
    const { app } = setup();
    const root = mkdtempSync(join(tmpdir(), "valerie-dashboard-test-"));
    tempDirectories.push(root);
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Valerie fixture</title>");
    writeFileSync(join(root, "fixture.js"), "console.info('fictional asset');");
    mkdirSync(join(root, "assets"));
    writeFileSync(
      join(root, "assets/fixture-abcdefgh.js"),
      "console.info('fingerprinted fixture');",
    );
    mountDashboard(app, root);
    for (const path of ["/", "/fixture.js", "/future-route"]) {
      const response = await app.request(`http://localhost:3100${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
    }
    const asset = await app.request("http://localhost:3100/assets/fixture-abcdefgh.js");
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const missing = await app.request("http://localhost:3100/assets/missing-abcdefgh.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).not.toContain("text/html");
  });

  test("prompt size failures are actionable even below the HTTP body limit", async () => {
    const { app, store } = setup();
    for (const content of ["x".repeat(270_000), "星".repeat(90_000)]) {
      const response = await app.request("http://localhost:3100/api/prompts/personality", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, expectedVersion: 1 }),
      });
      expect(response.status).toBe(413);
      expect((await response.json()).error).toContain("too large");
    }
    expect(createPromptService(store).get("personality")?.version).toBe(1);
  });

  test("valid authored text survives JSON escaping expansion", async () => {
    const { app } = setup();
    let version = 1;
    for (const content of ["\n".repeat(150_000), "\u0000".repeat(60_000)]) {
      const response = await app.request("http://localhost:3100/api/prompts/personality", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, expectedVersion: version }),
      });
      expect(response.status).toBe(200);
      const { prompt } = await response.json();
      expect(prompt.content).toBe(content);
      version = prompt.version;
    }
  });

  test("activity search reaches records beyond the first page of recent activity", async () => {
    const { app, store } = setup();
    const activity = createActivityService(store);
    const target = activity.append({ kind: "test", summary: "Distinct fictional search target." });
    store.db
      .query("UPDATE core_activity SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), target.id);
    for (let i = 0; i < 110; i++)
      activity.append({ kind: "test", summary: `Recent fictional event ${i}.` });
    const page = await app.request("http://localhost:3100/api/activity");
    expect((await page.json()).events.some((event: { id: string }) => event.id === target.id)).toBe(
      false,
    );
    const search = await app.request("http://localhost:3100/api/activity?q=Distinct%20fictional");
    expect((await search.json()).events[0].id).toBe(target.id);
  });
});
