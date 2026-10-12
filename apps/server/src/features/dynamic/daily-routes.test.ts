import { afterEach, expect, test } from "bun:test";
import { createDynamicService, openStore, type Store } from "@valerie/core";
import { createApp } from "../../app";
import { loadConfig } from "../../config";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = openStore(":memory:");
  stores.push(store);
  const app = createApp(store, loadConfig({}), {});
  const request = (
    path = "",
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`http://localhost:3100/api/dynamic/daily${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, request };
}

test("owner daily settings preserve focus scopes and detect stale versions", async () => {
  const f = fixture(),
    dynamic = createDynamicService(f.store),
    current = dynamic.getSettings();
  dynamic.saveSettings({
    ...current,
    expectedVersion: current.version,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  const response = await f.request();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const overview = await response.json();
  const saved = await f.request("/settings", "PUT", {
    expectedVersion: overview.settings.version,
    allowValerieManageWaking: true,
    allowValerieManageProgress: true,
  });
  expect(saved.status).toBe(200);
  expect((await saved.json()).settings).toMatchObject({
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
    allowValerieManageWaking: true,
    allowValerieManageProgress: true,
  });
  expect(
    (
      await f.request("/settings", "PUT", {
        expectedVersion: overview.settings.version,
        allowValerieManageWaking: false,
        allowValerieManageProgress: false,
      })
    ).status,
  ).toBe(409);
  expect(
    (await f.request("", "GET", undefined, { Origin: "https://not-owner.invalid" })).status,
  ).toBe(403);
});

test("local time resolution exposes DST adjustment and server now without creating work", async () => {
  const f = fixture();
  const gap = await f.request("/resolve-time", "POST", {
    mode: "local",
    timezone: "America/Chicago",
    localDateTime: "2026-03-08T02:30",
  });
  expect(gap.status).toBe(200);
  expect(await gap.json()).toMatchObject({
    at: "2026-03-08T08:00:00.000Z",
    localDateTime: "2026-03-08T03:00",
    offset: "UTC-05:00",
    adjustment: "gap_forward",
  });
  const first = await f.request("/resolve-time", "POST", {
    mode: "local",
    timezone: "America/Chicago",
    localDateTime: "2026-11-01T01:30",
  });
  expect(await first.json()).toMatchObject({
    at: "2026-11-01T06:30:00.000Z",
    adjustment: "overlap_first",
  });
  const second = await f.request("/resolve-time", "POST", {
    mode: "local",
    timezone: "America/Chicago",
    localDateTime: "2026-11-01T01:30",
    occurrence: "second",
  });
  expect(await second.json()).toMatchObject({
    at: "2026-11-01T07:30:00.000Z",
    adjustment: "overlap_second",
  });
  const before = Date.now();
  const now = await (
    await f.request("/resolve-time", "POST", { mode: "now", timezone: "America/Chicago" })
  ).json();
  expect(Date.parse(now.at)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(now.at)).toBeLessThanOrEqual(Date.now());
  expect(
    (await f.request("/resolve-time", "POST", { mode: "now", timezone: "invalid/zone" })).status,
  ).toBe(400);
  expect(f.store.db.query("SELECT id FROM core_dynamic_events").all()).toHaveLength(0);
  expect(f.store.db.query("SELECT id FROM core_conversation_outbox").all()).toHaveLength(0);
});

test("owner entries retain revisions and unassigned filtering without forged observation or scheduling", async () => {
  const f = fixture();
  const occurred = { at: null, timezone: "America/Chicago", basis: "unknown" };
  const wake = await f.request("/waking", "POST", {
    report: "main_wake",
    mode: "current",
    expectedCurrentDayId: null,
    expectedDayVersion: null,
    occurred,
    summary: "A fictional wake.",
  });
  expect(wake.status).toBe(200);
  const day = (await wake.json()).day;
  const behavior = (
    await (
      await f.request("/behaviors", "POST", {
        name: "Fictional practice",
        unit: "events",
        valueKind: "count",
      })
    ).json()
  ).behavior;
  const report = await f.request("/progress", "POST", {
    behaviorId: behavior.id,
    wakingDayId: null,
    occurred,
    summary: "An unassigned fictional report.",
    mode: "occurrence",
    value: 1,
    authoredBy: "valerie",
  });
  expect(report.status).toBe(200);
  const event = (await report.json()).event;
  expect(event.authoredBy).toBe("owner");
  expect((await (await f.request("/events")).json()).items).toHaveLength(2);
  expect((await (await f.request("/events?dayId=unassigned")).json()).items).toHaveLength(1);
  const edit = await f.request(`/events/${event.id}`, "PUT", {
    expectedVersion: 1,
    wakingDayId: day.id,
    summary: "A corrected report.",
  });
  expect(edit.status).toBe(200);
  expect((await (await f.request(`/events/${event.id}?revision=1`)).json()).event.summary).toBe(
    "An unassigned fictional report.",
  );
  expect(
    (await f.request(`/events/${event.id}`, "PUT", { expectedVersion: 1, summary: "Stale edit." }))
      .status,
  ).toBe(409);
  expect(
    (
      await f.request("/progress", "POST", {
        behaviorId: behavior.id,
        wakingDayId: day.id,
        occurred,
        summary: "Forged observation.",
        mode: "occurrence",
        value: 1,
        evidenceKind: "integration_observation",
      })
    ).status,
  ).toBe(400);
  expect((await f.request(`/events/${event.id}/void`, "POST", { expectedVersion: 2 })).status).toBe(
    200,
  );
  expect((await (await f.request(`/events/${event.id}`)).json()).event.state).toBe("voided");
  expect(f.store.db.query("SELECT id FROM core_conversation_outbox").all()).toHaveLength(0);
});
