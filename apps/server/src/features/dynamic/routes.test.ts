import { afterEach, expect, test } from "bun:test";
import { createDynamicService, openStore, type Store } from "@valerie/core";
import { createApp } from "../../app";
import { loadConfig } from "../../config";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const fields = {
  title: "Enjoy creative practice",
  reason: "Make room for enjoyment without judging every result.",
  startDate: "2026-09-15",
  reviewDate: "2026-10-27",
  practices: ["Notice an enjoyable part of making things."],
  indicators: [],
};
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
    app.request(`http://localhost:3100/api/dynamic${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, app, request };
}

test("Dynamic Details owner API saves exact focus revisions, permissions and source-linked notes", async () => {
  const f = fixture();
  const empty = await f.request();
  expect(empty.headers.get("Cache-Control")).toBe("no-store");
  expect(await empty.json()).toMatchObject({
    current: null,
    history: [],
    settings: { version: 1, allowValerieManageFocus: false, allowValerieLogNotes: false },
  });
  const saved = await f.request("/focus", "POST", {
    ...fields,
    authoredBy: "valerie",
    state: "archived",
  });
  expect(saved.status).toBe(200);
  const { focus } = await saved.json();
  expect(focus).toMatchObject({ ...fields, version: 1, authoredBy: "owner", state: "active" });
  expect(focus.sources[0]).toMatchObject({ type: "owner_entry", role: "owner" });
  const edited = await f.request(`/focus/${focus.id}`, "PUT", {
    ...fields,
    expectedVersion: 1,
    reason: "An exact revision.\nA second line.",
  });
  expect(edited.status).toBe(200);
  expect((await edited.json()).focus.reason).toBe("An exact revision.\nA second line.");
  expect(
    (await f.request(`/focus/${focus.id}`, "PUT", { ...fields, expectedVersion: 1 })).status,
  ).toBe(409);
  expect((await (await f.request(`/focus/${focus.id}/revisions/1`)).json()).focus.reason).toBe(
    fields.reason,
  );
  expect((await f.request(`/focus/${focus.id}/revisions/0`)).status).toBe(400);
  const permissions = await f.request("/settings", "PUT", {
    expectedVersion: 1,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  expect((await permissions.json()).settings).toMatchObject({
    version: 2,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  const note = await f.request(`/focus/${focus.id}/notes`, "POST", {
    expectedFocusVersion: 2,
    body: "I enjoyed painting a coaster.",
    kind: "owner_report",
    authoredBy: "valerie",
  });
  expect(note.status).toBe(200);
  const written = (await note.json()).note;
  expect(written).toMatchObject({ authoredBy: "owner", superseded: false });
  expect((await (await f.request(`/focus/${focus.id}`)).json()).notes).toEqual([written]);
  expect((await (await f.request(`/focus/${focus.id}/notes?limit=1`)).json()).items).toEqual([
    written,
  ]);
});

test("owner API rejects stale permissions, malformed evidence and attempts to edit archived history", async () => {
  const f = fixture();
  const { focus } = await (await f.request("/focus", "POST", fields)).json();
  expect(
    (
      await f.request(`/focus/${focus.id}/notes`, "POST", {
        body: "Missing current version.",
        kind: "owner_report",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request(`/focus/${focus.id}/notes`, "POST", {
        expectedFocusVersion: 1,
        body: "A claimed source.",
        kind: "owner_report",
        sourceIds: ["conversation:missing"],
      })
    ).status,
  ).toBe(400);
  expect((await f.request("/focus", "POST", fields)).status).toBe(409);
  const paused = await f.request(`/focus/${focus.id}/state`, "POST", {
    expectedVersion: 1,
    state: "paused",
  });
  expect((await paused.json()).focus.phase).toBe("paused");
  expect(
    (await f.request(`/focus/${focus.id}/state`, "POST", { expectedVersion: 1, state: "active" }))
      .status,
  ).toBe(409);
  const archived = await f.request(`/focus/${focus.id}/state`, "POST", {
    expectedVersion: 2,
    state: "archived",
  });
  expect((await archived.json()).focus.state).toBe("archived");
  expect(
    (await f.request(`/focus/${focus.id}`, "PUT", { ...fields, expectedVersion: 3 })).status,
  ).toBe(400);
  expect(
    (await f.request(`/focus/${focus.id}/state`, "POST", { expectedVersion: 3, state: "active" }))
      .status,
  ).toBe(400);
  const settings = {
    expectedVersion: 1,
    allowValerieManageFocus: true,
    allowValerieLogNotes: false,
  };
  expect((await f.request("/settings", "PUT", settings)).status).toBe(200);
  expect((await f.request("/settings", "PUT", settings)).status).toBe(409);
  expect(
    (
      await f.request("/settings", "PUT", {
        ...settings,
        expectedVersion: 2,
        allowValerieManageFocus: "true",
      })
    ).status,
  ).toBe(400);
  expect((await f.request("/focus/missing")).status).toBe(404);
  expect((await f.request(`/focus/${focus.id}/notes?limit=51`)).status).toBe(400);
});

test("Dynamic Details keeps private route protections and records no edit for invalid requests", async () => {
  const f = fixture();
  expect(
    (await f.request("", "GET", undefined, { Origin: "https://untrusted.example" })).status,
  ).toBe(403);
  expect(
    (await f.request("/focus", "POST", fields, { Origin: "https://untrusted.example" })).status,
  ).toBe(403);
  expect((await f.request("/focus", "POST", null)).status).toBe(400);
  expect((await f.request("/focus", "POST", { ...fields, reviewDate: "2026-02-30" })).status).toBe(
    400,
  );
  expect((await f.request("/focus", "POST", { ...fields, title: "🪴".repeat(31) })).status).toBe(
    400,
  );
  expect((await f.request("/focus", "POST", fields, { "Content-Type": "text/plain" })).status).toBe(
    400,
  );
  expect(createDynamicService(f.store).list()).toEqual([]);
  expect(
    f.store.db
      .query("SELECT count(*) AS count FROM core_activity WHERE kind LIKE 'dynamic.%'")
      .get(),
  ).toEqual({ count: 0 });
});
