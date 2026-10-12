import { describe, expect, test } from "bun:test";
import { createNeuralwattClient, inferenceTimeoutMs, type NeuralwattModel } from "./index";

const messages = [{ role: "user" as const, content: "A fictional test." }];
const model: NeuralwattModel = {
  id: "fictional-flex",
  displayName: "Fictional Flex",
  maxContextTokens: 131072,
  maxOutputTokens: null,
  vision: false,
  tools: true,
  maxImages: null,
  systemRole: true,
  reasoningEffort: false,
  deprecated: false,
  reasoning: null,
  pricing: {
    currency: null,
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
    pricingTbd: true,
  },
};
const tool = { name: "lookup", description: "Fictional lookup", parameters: { type: "object" } };
const delta = (value: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ service_tier: "flex", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
const end = "data: [DONE]\n\n";
const answer = delta({ content: "Hello." }, "stop");
function streamed(text: string, step = 17, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + step));
        offset = Math.min(bytes.length, offset + step);
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "fictional-receipt",
        ...headers,
      },
    },
  );
}
function client(text: string, headers: Record<string, string> = {}) {
  return createNeuralwattClient({
    apiKey: "fictional",
    model: model.id,
    capabilities: model,
    transport: async () => streamed(text, 17, headers),
  });
}

describe("Flex completion streams", () => {
  test("assembles split UTF8 and CRLF with keepalives, usage, tier and cost receipts", async () => {
    const wire = [
      ": keepalive\n\n",
      delta({ role: "assistant", reasoning_content: "never expose" }),
      delta({ content: "Hi 🌿" }),
      delta({}, "stop"),
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":10},"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
      ': energy {"energy_kwh":0.01}\n\n: cost {"request_cost_usd":0.000013,"budget_remaining_usd":99}\n\n',
      end,
    ]
      .join("")
      .replaceAll("\n", "\r\n");
    const c = createNeuralwattClient({
      apiKey: "fictional",
      model: model.id,
      capabilities: model,
      transport: async (_url, init) => {
        expect(JSON.parse(String(init.body))).toMatchObject({
          stream: true,
          stream_options: { include_usage: true },
        });
        expect(new Headers(init.headers).get("x-nw-tools-opt-out")).toBe("true");
        return streamed(wire, 1, { "x-nw-service-tier": "flex" });
      },
    });
    const result = await c.complete({ messages });
    expect(result).toMatchObject({
      text: "Hi 🌿",
      complete: true,
      serviceTier: "flex",
      costUsd: 0.000013,
      requestId: "fictional-receipt",
      usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 10, reasoningTokens: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("never expose");
    expect(JSON.stringify(result)).not.toContain("budget_remaining");
  });

  test("assembles interleaved indexed tool fragments and preserves validation", async () => {
    const wire =
      delta({
        tool_calls: [
          {
            index: 0,
            id: "call-",
            type: "function",
            function: { name: "look", arguments: '{"q":' },
          },
          {
            index: 1,
            id: "second",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      }) +
      delta(
        { tool_calls: [{ index: 0, id: "one", function: { name: "up", arguments: '"🌿"}' } }] },
        "tool_calls",
      ) +
      end;
    const result = await client(wire).complete({ messages, tools: [tool] });
    expect(result).toMatchObject({
      complete: false,
      finishReason: "tool_calls",
      serviceTier: "flex",
      toolCalls: [
        { id: "call-one", name: "lookup", arguments: '{"q":"🌿"}' },
        { id: "second", name: "lookup", arguments: "{}" },
      ],
    });
    await expect(client(wire).complete({ messages })).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(
      client(wire).complete({ messages, tools: [{ ...tool, name: "other" }] }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("supports multiline data and CR line endings", async () => {
    const wire =
      'data: {"choices":\ndata: [{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n' +
      end;
    expect((await client(wire.replaceAll("\n", "\r")).complete({ messages })).text).toBe("hello");
  });

  test("unknown or standard tier stays honest, including zero reported cost", async () => {
    const unknown = answer.replace('"service_tier":"flex",', "");
    expect(await client(unknown + end).complete({ messages })).toMatchObject({
      serviceTier: null,
      costUsd: null,
    });
    expect(
      await client(
        answer.replace('"service_tier":"flex"', '"service_tier":"future-tier"') + end,
      ).complete({ messages }),
    ).toMatchObject({ serviceTier: null });
    expect(
      await client(`${unknown}: cost {"request_cost_usd":0}\n\n${end}`, {
        "x-nw-service-tier": "standard",
      }).complete({ messages }),
    ).toMatchObject({ serviceTier: "standard", costUsd: 0 });
    await expect(
      client(answer + end, { "x-nw-service-tier": "standard" }).complete({ messages }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("requires finish and DONE and rejects invalid or contradictory streams", async () => {
    for (const wire of [
      answer,
      delta({ content: "partial" }) + end,
      end,
      answer + delta({ content: "extra" }) + end,
      `data: broken\n\n${end}`,
      delta({}, "content_filter") + end,
      delta({ tool_calls: [{ index: 4 }] }, "tool_calls") + end,
      delta(
        { tool_calls: [{ index: 1, id: "gap", function: { name: "lookup", arguments: "{}" } }] },
        "tool_calls",
      ) + end,
      delta(
        {
          tool_calls: [
            { index: 0, id: "big", function: { name: "lookup", arguments: "a".repeat(8193) } },
          ],
        },
        "tool_calls",
      ) + end,
      `${answer}data: {"choices":[],"service_tier":"standard"}\n\n${end}`,
    ])
      await expect(client(wire).complete({ messages, tools: [tool] })).rejects.toMatchObject({
        code: "invalid_response",
      });
  });

  test("provider errors are redacted and never retried", async () => {
    for (const wire of [
      'event: error\ndata: {"message":"private"}\n\n',
      'data: {"error":{"message":"private"}}\n\n',
    ]) {
      let calls = 0;
      const c = createNeuralwattClient({
        apiKey: "fictional",
        model: model.id,
        transport: async () => {
          calls++;
          return streamed(wire);
        },
      });
      await expect(c.complete({ messages })).rejects.toMatchObject({
        code: "provider",
        retryable: false,
      });
      expect(calls).toBe(1);
    }
  });

  test("length exhaustion stays partial and missing accounting remains unknown", async () => {
    expect(
      await client(delta({ content: "unfinished" }, "length") + end).complete({ messages }),
    ).toMatchObject({
      complete: false,
      finishReason: "length",
      usage: { inputTokens: null },
      costUsd: null,
    });
  });

  test("bounds events, assembled text, and total stream bytes", async () => {
    for (const wire of [
      `: ${"x".repeat(262145)}`,
      Array.from({ length: 17 }, () => delta({ content: "x".repeat(65536) })).join("") + end,
      `: ${"x".repeat(65530)}\n\n`.repeat(260),
    ]) {
      const c = createNeuralwattClient({
        apiKey: "fictional",
        model: model.id,
        transport: async () => streamed(wire, 16384),
      });
      await expect(c.complete({ messages })).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  test("deadline and cancellation apply throughout a stalled body despite keepalives", async () => {
    for (const cancel of [false, true]) {
      let cancelled = false;
      const external = new AbortController();
      const c = createNeuralwattClient({
        apiKey: "fictional",
        model: model.id,
        timeoutMs: cancel ? 1000 : 10,
        transport: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`: keepalive\n\n${answer}`));
                if (cancel) setTimeout(() => external.abort(), 5);
              },
              cancel() {
                cancelled = true;
                return new Promise(() => {});
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      await expect(c.complete({ messages, signal: external.signal })).rejects.toMatchObject({
        code: cancel ? "cancelled" : "deadline",
      });
      expect(cancelled).toBe(true);
    }
  });

  test("does not accept non-streaming fallback or malformed UTF8 for Flex", async () => {
    for (const response of [
      Response.json({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }] }),
      new Response(new Uint8Array([255]), { headers: { "content-type": "text/event-stream" } }),
    ]) {
      const c = createNeuralwattClient({
        apiKey: "fictional",
        model: model.id,
        transport: async () => response,
      });
      await expect(c.complete({ messages })).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  test("Flex gets a finite five-minute allowance and standard requests retain their limits", () => {
    expect(inferenceTimeoutMs("fictional-flex")).toBe(300000);
    expect(inferenceTimeoutMs("fictional")).toBe(120000);
    expect(inferenceTimeoutMs("fictional", 90000)).toBe(90000);
    expect(() =>
      createNeuralwattClient({ apiKey: "fictional", model: model.id, timeoutMs: 300001 }),
    ).toThrow();
  });
});
