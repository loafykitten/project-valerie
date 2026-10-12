import { afterEach, expect, test } from "bun:test";
import { openStore, type Store } from "@valerie/core";
import { Hono } from "hono";
import { mountContextHealthRoutes } from "./routes";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("context diagnostics and export report their actual notification state with bounded queries", async () => {
  const store = openStore(":memory:");
  stores.push(store);
  const app = new Hono();
  mountContextHealthRoutes(app, store, { notificationDelivery: () => "disabled" });
  const response = await app.request("/api/context-health");
  expect(response.status).toBe(200);
  expect((await response.json()).notificationDelivery).toBe("disabled");
  const download = await app.request("/api/context-health/export");
  expect(download.headers.get("content-disposition")).toContain("valerie-context-health.json");
  expect((await download.json()).qualityThreshold.status).toBe("uncalibrated");
  for (const value of ["0", "51", "-1", "1e1", "a"]) {
    expect((await app.request(`/api/context-health?limit=${value}`)).status).toBe(400);
  }
  expect((await app.request("/api/context-health/conversation/missing")).status).toBe(404);
  expect((await app.request("/api/context-health/unknown/missing")).status).toBe(400);
});
