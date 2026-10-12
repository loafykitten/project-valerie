import { afterEach, describe, expect, test } from "bun:test";
import { createHeartbeatService, openStore, type Store } from "@valerie/core";
import { Hono } from "hono";
import { createApp } from "../../app";
import { loadConfig } from "../../config";
import { type HeartbeatRuntimeStatus, mountHeartbeatRoutes } from "./routes";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(runtime?: () => HeartbeatRuntimeStatus) {
  const store = openStore(":memory:");
  stores.push(store);
  const service = createHeartbeatService(store);
  const app = new Hono();
  mountHeartbeatRoutes(app, store, { TELEGRAM_ALLOWED_USER_ID: "4242424242" }, runtime);
  const request = (path: string, input: unknown, method = "POST") =>
    app.request(`/api/heartbeat/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  const initial = service.getSettings();
  const save = (patch: Record<string, unknown> = {}) =>
    request(
      "settings",
      {
        ...initial,
        expectedVersion: initial.version,
        ...patch,
      },
      "PUT",
    );
  return { store, service, app, request, save, initial };
}

describe("heartbeat owner controls", () => {
  test("settings start disabled and runtime availability is independent of saved enablement", async () => {
    const { app, save } = setup();
    const initial = await (await app.request("/api/heartbeat")).json();
    expect(initial.settings.enabled).toBe(false);
    expect(initial.runtime.state).toBe("stopped");
    expect(initial.recentRuns).toEqual([]);
    const saved = await (
      await save({ enabled: true, activeStart: "12:00", activeEnd: "12:00" })
    ).json();
    expect(saved.settings.enabled).toBe(true);
    expect(saved.settings.activeEnd).toBe("12:00");
    expect(saved.status.activeNow).toBe(true);
    expect(saved.runtime.state).toBe("stopped");
  });

  test("stale saves and pause/resume requests cannot overwrite a newer owner choice", async () => {
    const { save, request, service, initial } = setup();
    const first = await save({ enabled: true, activeStart: "12:00", activeEnd: "04:00" });
    expect(first.status).toBe(200);
    expect((await save({ maxPerDay: 1 })).status).toBe(409);
    expect(
      (await request("pause", { expectedVersion: initial.version, pausedUntil: null })).status,
    ).toBe(409);
    const beforePause = service.getSettings();
    const paused = await request("pause", {
      expectedVersion: beforePause.version,
      pausedUntil: null,
    });
    expect(paused.status).toBe(200);
    expect((await paused.json()).status.paused).toBe(true);
    expect((await request("resume", { expectedVersion: beforePause.version })).status).toBe(409);
    const resumed = await request("resume", { expectedVersion: service.getSettings().version });
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).status.paused).toBe(false);
    expect(service.getSettings()).toMatchObject({
      enabled: true,
      maxPerDay: 2,
      activeStart: "12:00",
      activeEnd: "04:00",
    });
  });

  test("ordinary settings edits preserve an active pause and ignore forged scheduling fields", async () => {
    const { request, service } = setup();
    const start = service.getSettings();
    const deadline = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      (await request("pause", { expectedVersion: start.version, pausedUntil: deadline })).status,
    ).toBe(200);
    const paused = service.getSettings();
    const saved = await request(
      "settings",
      {
        ...paused,
        expectedVersion: paused.version,
        paused: false,
        pausedUntil: null,
        nextOpportunityAt: "2000-01-01T00:00:00.000Z",
        deliveredToday: 0,
        maxMessageChars: 240,
      },
      "PUT",
    );
    expect(saved.status).toBe(200);
    const result = await saved.json();
    expect(result.settings).toMatchObject({
      paused: true,
      pausedUntil: deadline,
      maxMessageChars: 240,
    });
    expect(result.status.paused).toBe(true);
    expect(result.status.nextOpportunityAt).not.toBe("2000-01-01T00:00:00.000Z");
  });

  test("bad settings and malformed bodies are rejected without saving", async () => {
    const { app, save, request, service, initial } = setup();
    for (const patch of [
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { enabled: "yes" },
      { timezone: "Definitely/NotAZone" },
      { activeStart: "24:00" },
      { minIntervalMinutes: 360, maxIntervalMinutes: 180 },
      { minIdleMinutes: 0 },
      { maxPerDay: 9 },
      { maxUnanswered: 0 },
      { maxMessageChars: 5000 },
    ])
      expect((await save(patch)).status).toBe(400);
    expect((await request("pause", { expectedVersion: 1, pausedUntil: "tomorrow" })).status).toBe(
      400,
    );
    expect((await request("pause", { expectedVersion: 1 })).status).toBe(400);
    expect((await request("resume", [])).status).toBe(400);
    expect(
      (await app.request("/api/heartbeat/settings", { method: "PUT", body: "{}" })).status,
    ).toBe(415);
    expect(
      (
        await app.request("/api/heartbeat/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(service.getSettings()).toEqual(initial);
  });

  test("recent outcome summaries never expose context, messages, provider bodies, or chat identifiers", async () => {
    const secret = "private-fictional-content";
    const { store, service, app } = setup(() => ({
      state: "failed",
      lastError: secret,
      lastTickAt: null,
    }));
    const settings = service.getSettings();
    const time = new Date().toISOString();
    for (const status of ["delivered", "silent", "suppressed", "failed", "unknown"]) {
      store.db
        .query(`INSERT INTO core_heartbeat_runs
        (id,chat_id,status,fence,lease_owner,settings_json,input_watermark,waking_day,snapshot_json,text,result_json,reason,created_at,updated_at,finished_at,delivery_started_at,delivered_at,telegram_message_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          `fictional-${status}`,
          "4242424242",
          status,
          `fence-${status}`,
          "fictional-worker",
          JSON.stringify(settings),
          0,
          time.slice(0, 10),
          JSON.stringify({ text: secret }),
          secret,
          JSON.stringify({ text: secret }),
          secret,
          time,
          time,
          time,
          ["delivered", "unknown"].includes(status) ? time : null,
          status === "delivered" ? time : null,
          status === "delivered" ? "9001" : null,
        );
    }
    const response = await app.request("/api/heartbeat");
    const raw = await response.text();
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("4242424242");
    expect(raw).not.toContain("snapshot");
    expect(raw).not.toContain("telegramMessageId");
    const result = JSON.parse(raw);
    expect(result.runtime).toMatchObject({ state: "failed", lastError: "heartbeat_unavailable" });
    expect(new Set(result.recentRuns.map((run: { status: string }) => run.status))).toEqual(
      new Set(["delivered", "silent", "suppressed", "failed", "unknown"]),
    );
    expect(result.recentRuns.every((run: { reason: string | null }) => run.reason === null)).toBe(
      true,
    );
  });

  test("heartbeat routes inherit private host/origin checks and no-store headers", async () => {
    const store = openStore(":memory:");
    stores.push(store);
    const app = createApp(store, loadConfig({}), {});
    const response = await app.request("http://localhost:3100/api/heartbeat");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await app.request("http://outside.invalid/api/heartbeat")).status).toBe(403);
    expect(
      (
        await app.request("http://localhost:3100/api/heartbeat/pause", {
          method: "POST",
          headers: { Origin: "https://outside.invalid", "Content-Type": "application/json" },
          body: JSON.stringify({ expectedVersion: 1, pausedUntil: null }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("http://localhost:3100/api/heartbeat", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(createHeartbeatService(store).getSettings().version).toBe(1);
  });
});
