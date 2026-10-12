import { describe, expect, test } from "bun:test";
import {
  createNeuralwattClient,
  discoverNeuralwattModels,
  type NeuralwattModel,
  validateInferenceSettings,
} from "./index";

const entry = {
  id: "fictional-model",
  metadata: {
    display_name: "Fictional Model",
    capabilities: { system_role: true, reasoning_effort: true },
    limits: { max_context_length: 32000, max_output_tokens: 8000 },
    reasoning: {
      mandatory: true,
      default_enabled: true,
      default_effort: "max",
      supported_efforts: ["max", "low"],
      accepted_efforts: ["max", "low", "minimal", "none"],
      effort_aliases: { minimal: "low" },
    },
    pricing: {
      currency: "USD",
      input_per_million: 0.2,
      output_per_million: 0.5,
      cached_input_per_million: 0.02,
      pricing_tbd: false,
    },
    deprecated: false,
  },
};
const model: NeuralwattModel = {
  id: "fictional-model",
  displayName: "Fictional Model",
  maxContextTokens: 32000,
  maxOutputTokens: 8000,
  vision: false,
  maxImages: null,
  systemRole: true,
  reasoningEffort: true,
  deprecated: false,
  reasoning: {
    mandatory: true,
    defaultEnabled: true,
    defaultEffort: "max",
    supportedEfforts: ["max", "low"],
    acceptedEfforts: ["max", "low", "minimal", "none"],
    effortAliases: { minimal: "low" },
  },
  pricing: {
    currency: "USD",
    inputPerMillion: 0.2,
    outputPerMillion: 0.5,
    cachedInputPerMillion: 0.02,
    pricingTbd: false,
  },
};
const apiKey = "fictional-secret";
const messages = [{ role: "user" as const, content: "A fictional test." }];
const completion = () =>
  Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: "Hello.",
          reasoning: "private trace never returned",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 15,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  });

describe("authenticated model capabilities", () => {
  test("requires matching customer scope in both authenticated response locations", async () => {
    for (const [bodyScope, headerScope] of [
      ["public", "customer"],
      ["customer", "public"],
      ["customer", ""],
    ]) {
      await expect(
        discoverNeuralwattModels({
          apiKey,
          transport: async () =>
            Response.json(
              { scope: bodyScope, data: [entry] },
              { headers: { "x-models-scope": headerScope ?? "" } },
            ),
        }),
      ).rejects.toMatchObject({ code: "catalog_scope" });
    }
  });
  test("normalizes exact alias reasoning metadata and known prices", async () => {
    const catalog = await discoverNeuralwattModels({
      apiKey,
      transport: async (url, init) => {
        expect(url).toBe("https://api.neuralwatt.com/v1/models");
        expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
        return Response.json(
          { scope: "customer", data: [entry] },
          { headers: { "x-models-scope": "customer" } },
        );
      },
    });
    expect(catalog.models).toEqual([{ ...model, tools: false }]);
    expect(JSON.stringify(catalog)).not.toContain(apiKey);
  });
  test("unknown and placeholder pricing remains unknown and duplicate IDs fail closed", async () => {
    const unpublished = structuredClone(entry);
    unpublished.metadata.pricing.pricing_tbd = true;
    const catalog = await discoverNeuralwattModels({
      apiKey,
      transport: async () =>
        Response.json(
          { scope: "customer", data: [unpublished] },
          { headers: { "x-models-scope": "customer" } },
        ),
    });
    expect(catalog.models[0]?.pricing.inputPerMillion).toBeNull();
    await expect(
      discoverNeuralwattModels({
        apiKey,
        transport: async () =>
          Response.json(
            { scope: "customer", data: [entry, entry] },
            { headers: { "x-models-scope": "customer" } },
          ),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  test("validates actual reasoning behavior and model output bounds before sending", () => {
    expect(() =>
      validateInferenceSettings(model, { maxTokens: 4096, reasoningEffort: "minimal" }),
    ).not.toThrow();
    for (const settings of [
      { maxTokens: 4096, reasoningEffort: "none" as const },
      { maxTokens: 9000 },
      { maxTokens: 4096, temperature: Number.NaN },
      { maxTokens: 4096, temperature: 2.1 },
    ])
      expect(() => validateInferenceSettings(model, settings)).toThrow();
    expect(() =>
      validateInferenceSettings({ ...model, maxContextTokens: null }, { maxTokens: 4096 }),
    ).toThrow();
  });
});

describe("pinned conversational completion", () => {
  test("pins capabilities, copies only message fields, and returns actual token details without reasoning", async () => {
    const capabilities = structuredClone(model);
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities,
      transport: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.reasoning_effort).toBe("low");
        expect(body.temperature).toBe(0.8);
        expect(body.messages[0]).toEqual(messages[0]);
        expect(body.tools).toBeUndefined();
        return completion();
      },
    });
    capabilities.reasoning = null;
    const result = await client.complete({
      messages: [
        Object.assign(
          { role: "user" as const, content: "A fictional test." },
          { reasoning: "must not be forwarded" },
        ),
      ],
      maxTokens: 4096,
      reasoningEffort: "low",
      temperature: 0.8,
    });
    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 8,
      cachedInputTokens: 5,
      reasoningTokens: 3,
    });
    expect(JSON.stringify(result)).not.toContain("private trace");
    expect(result.costUsd).toBeNull();
  });
  test("rejects capability alias mismatch and reasoning settings without a verified catalog", async () => {
    expect(() =>
      createNeuralwattClient({ apiKey, model: "another-alias", capabilities: model }),
    ).toThrow();
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      transport: async () => {
        throw new Error("must not reach provider");
      },
    });
    await expect(client.complete({ messages, reasoningEffort: "low" })).rejects.toMatchObject({
      code: "configuration",
    });
  });
  test("rejects request growth before provider and unexpected tool results after provider", async () => {
    let calls = 0;
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: model,
      transport: async () => {
        calls++;
        return Response.json({
          choices: [
            {
              message: { content: "Done", tool_calls: [{ id: "unrequested" }] },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    await expect(
      client.complete({ messages: [{ role: "user", content: "x".repeat(100000) }] }),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(calls).toBe(0);
    await expect(client.complete({ messages })).rejects.toMatchObject({ code: "invalid_response" });
    expect(calls).toBe(1);
  });
  test("rejects oversized responses and deadlines cover stalled response streams", async () => {
    const large = createNeuralwattClient({
      apiKey,
      model: model.id,
      transport: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    });
    await expect(large.complete({ messages })).rejects.toMatchObject({ code: "invalid_response" });
    let cancelled = false;
    const stalled = createNeuralwattClient({
      apiKey,
      model: model.id,
      timeoutMs: 10,
      transport: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    await expect(stalled.complete({ messages })).rejects.toMatchObject({ code: "deadline" });
    expect(cancelled).toBe(true);
  });
  test("caller cancellation reaches stalled transport and provider errors expose only safe kinds", async () => {
    const controller = new AbortController();
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      transport: async () => new Promise(() => undefined),
    });
    const pending = client.complete({ messages, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    for (const [status, code] of [
      [401, "authentication"],
      [403, "authentication"],
      [413, "context_overflow"],
      [500, "provider"],
    ] as const) {
      const failed = createNeuralwattClient({
        apiKey,
        model: model.id,
        transport: async () => new Response(apiKey, { status }),
      });
      await expect(failed.complete({ messages })).rejects.toMatchObject({ code, status });
    }
  });
  test("rate limiting exposes safe Retry-After without retrying", async () => {
    for (const [header, expected] of [
      ["120", 120],
      ["garbage", undefined],
      ["900000", undefined],
    ] as const) {
      let calls = 0;
      const client = createNeuralwattClient({
        apiKey,
        model: model.id,
        transport: async () => {
          calls++;
          return new Response(apiKey, { status: 429, headers: { "retry-after": header } });
        },
      });
      await expect(client.complete({ messages })).rejects.toMatchObject({
        code: "rate_limited",
        retryAfterSeconds: expected,
      });
      expect(calls).toBe(1);
    }
  });
});
