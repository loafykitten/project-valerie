import { afterEach, describe, expect, test } from "bun:test";
import { createConversationService, openStore, type Store } from "@valerie/core";
import type {
  discoverNeuralwattModels,
  NeuralwattCatalog,
  NeuralwattModel,
} from "@valerie/inference";
import { Hono } from "hono";
import { mountConversationRoutes } from "./routes";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const model: NeuralwattModel = {
  id: "fictional-model",
  displayName: "Fictional Model",
  maxContextTokens: 262144,
  maxOutputTokens: null,
  vision: true,
  maxImages: 20,
  systemRole: true,
  reasoningEffort: true,
  deprecated: false,
  reasoning: {
    mandatory: true,
    defaultEnabled: true,
    defaultEffort: "max",
    supportedEfforts: ["max", "low"],
    acceptedEfforts: ["max", "low"],
    effortAliases: {},
  },
  pricing: {
    currency: "USD",
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
    pricingTbd: true,
  },
};
const catalog: NeuralwattCatalog = {
  scope: "customer",
  checkedAt: "2026-09-13T07:00:00.000Z",
  requestId: "fictional-request",
  models: [model],
};
const secret = "fictional-secret-that-must-never-be-returned";

function setup(discover: typeof discoverNeuralwattModels = async () => structuredClone(catalog)) {
  const store = openStore(":memory:");
  stores.push(store);
  const conversations = createConversationService(store);
  const app = new Hono();
  mountConversationRoutes(app, store, { NEURALWATT_API_KEY: secret }, undefined, { discover });
  const settings = conversations.getSettings();
  const input = {
    ...settings,
    expectedVersion: settings.version,
    model: model.id,
    reasoningEffort: "low",
    temperature: null,
  };
  const save = (body: unknown = input) =>
    app.request("/api/inference/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, conversations, input, save };
}

describe("conversation HTTP settings", () => {
  test("pins authenticated capabilities and ignores browser-forged model limits", async () => {
    const { save, input, conversations } = setup();
    const response = await save({
      ...input,
      modelContextTokens: 9999999,
      modelMaxOutputTokens: 9999999,
      modelCapabilities: { id: "forged" },
      capabilityCheckedAt: "forged",
    });
    expect(response.status).toBe(200);
    const saved = conversations.getSettings();
    expect(saved.modelCapabilities).toEqual(model);
    expect(saved.modelContextTokens).toBe(262144);
    expect(saved.modelMaxOutputTokens).toBe(32768);
    expect(saved.capabilityCheckedAt).toBe(catalog.checkedAt);
    expect(await response.text()).not.toContain(secret);
  });

  test("rejects unverified model, unsupported reasoning, and excessive context without saving", async () => {
    const { save, input, conversations } = setup();
    for (const patch of [
      { model: "not-in-catalog" },
      { reasoningEffort: "none" },
      { contextTokens: 1000000 },
      { maxOutputTokens: 40000 },
      { temperature: 2.1 },
    ]) {
      const response = await save({ ...input, ...patch });
      expect(response.status).toBe(400);
      expect(conversations.getSettings().version).toBe(input.expectedVersion);
      expect(await response.text()).not.toContain(secret);
    }
  });

  test("stale saves avoid catalog calls and concurrent saves cannot overwrite a committed revision", async () => {
    let calls = 0;
    const waiting: Array<() => void> = [];
    const { save, input, conversations } = setup(async () => {
      calls++;
      await new Promise<void>((resolve) => waiting.push(resolve));
      return structuredClone(catalog);
    });
    const first = save();
    const second = save({ ...input, historyHours: 36 });
    for (let count = 0; count < 100 && waiting.length < 2; count++) await Bun.sleep(1);
    expect(waiting.length).toBe(2);
    waiting[0]?.();
    expect((await first).status).toBe(200);
    waiting[1]?.();
    expect((await second).status).toBe(409);
    expect(conversations.getSettings().historyHours).toBe(input.historyHours);
    expect((await save()).status).toBe(409);
    expect(calls).toBe(2);
  });

  test("discovery errors cannot leak provider errors or credentials", async () => {
    const { app, save, conversations, input } = setup(async () => {
      throw new TypeError(`fetch failed https://provider.invalid/${secret}`);
    });
    for (const response of [await app.request("/api/inference/models"), await save()]) {
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(body).not.toContain("provider.invalid");
    }
    expect(conversations.getSettings().version).toBe(input.expectedVersion);
  });

  test("malformed or missing input returns a client error before discovery", async () => {
    let calls = 0;
    const { app, save } = setup(async () => {
      calls++;
      return structuredClone(catalog);
    });
    expect((await save({})).status).toBe(400);
    expect((await save([])).status).toBe(400);
    expect(
      (await app.request("/api/inference/settings", { method: "PUT", body: "{}" })).status,
    ).toBe(415);
    expect(
      (
        await app.request("/api/inference/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(0);
  });
});
