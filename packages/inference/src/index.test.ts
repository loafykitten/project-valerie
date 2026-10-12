import { describe, expect, test } from "bun:test";
import { createNeuralwattClient, InferenceError } from "./index";

const messages = [{ role: "user" as const, content: "A fictional test." }];
const options = { apiKey: "fictional-secret", model: "configured-model" };
describe("Neuralwatt transport", () => {
  test("uses configured model, bounds output, opts out of hosted tools, and preserves request ID", async () => {
    const client = createNeuralwattClient({
      ...options,
      transport: async (url, init) => {
        expect(url).toBe("https://api.neuralwatt.com/v1/chat/completions");
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get("X-NW-Tools-Opt-Out")).toBe("true");
        expect(JSON.parse(String(init.body)).model).toBe("configured-model");
        return Response.json(
          { choices: [{ message: { content: "Hello." }, finish_reason: "stop" }] },
          { headers: { "X-Request-ID": "request-123" } },
        );
      },
    });
    const result = await client.complete({ messages });
    expect(result.complete).toBe(true);
    expect(result.requestId).toBe("request-123");
    expect(result.usage.outputTokens).toBeNull();
    expect(result.costUsd).toBeNull();
  });
  test("marks exhausted reasoning budget partial, not a completed reply", async () => {
    const client = createNeuralwattClient({
      ...options,
      transport: async () =>
        Response.json({ choices: [{ message: { content: null }, finish_reason: "length" }] }),
    });
    expect(await client.complete({ messages })).toMatchObject({ text: "", complete: false });
  });
  test("redacts provider body and never retries a potentially billed request implicitly", async () => {
    let calls = 0;
    const client = createNeuralwattClient({
      ...options,
      transport: async () => {
        calls++;
        return new Response("fictional-secret in unsafe provider body", { status: 429 });
      },
    });
    try {
      await client.complete({ messages });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceError);
      expect(String(error)).not.toContain("fictional-secret");
      expect(error).toMatchObject({ code: "rate_limited", retryable: true, status: 429 });
    }
    expect(calls).toBe(1);
  });
  test("rejects malformed completion and honors cancellation", async () => {
    const client = createNeuralwattClient({ ...options, transport: async () => Response.json({}) });
    await expect(client.complete({ messages })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.complete({ messages, signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "cancelled",
    });
  });
  test("total request deadline reaches the transport", async () => {
    const client = createNeuralwattClient({
      ...options,
      timeoutMs: 10,
      transport: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    });
    await expect(client.complete({ messages })).rejects.toMatchObject({ code: "deadline" });
  });
});
