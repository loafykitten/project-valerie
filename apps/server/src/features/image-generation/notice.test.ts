import { afterEach, describe, expect, test } from "bun:test";
import {
  createConversationService,
  createImageJobService,
  createPromptService,
  type ImageJob,
  openStore,
  type Store,
} from "@valerie/core";
import type { NeuralwattModel } from "@valerie/inference";
import { createImageFailureGenerator } from "./notice";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const model: NeuralwattModel = {
  id: "fictional-notice-model",
  displayName: "Fictional Notice Model",
  maxContextTokens: 262144,
  maxOutputTokens: 8192,
  vision: false,
  maxImages: null,
  tools: true,
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

function fixture() {
  const store = openStore(":memory:");
  stores.push(store);
  const conversations = createConversationService(store, { imageGeneration: true });
  const current = conversations.getSettings();
  conversations.saveSettings({
    ...current,
    expectedVersion: current.version,
    model: model.id,
    modelCapabilities: model,
    modelContextTokens: 262144,
    modelMaxOutputTokens: 8192,
    maxOutputTokens: 4096,
    reasoningEffort: null,
  });
  const prompts = createPromptService(store);
  const identity = prompts.get("identity");
  if (!identity) throw new Error("Missing fictional identity prompt.");
  prompts.update(identity.id, {
    content: "Fictional original character voice.",
    expectedVersion: identity.version,
  });
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "42",
        senderId: "42",
        text: "Please send a selfie.",
      },
    ],
  });
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing fictional image turn.");
  const job = createImageJobService(store).enqueue({
    turnId: turn.id,
    toolCallId: "fictional-image-call",
    framing: "selfie",
    sceneTags: ["blue sweater"],
    prompt: "fictional adult, blue sweater",
    workflow: { "8": { class_type: "FictionalOutput", inputs: {} } },
    seed: 10,
  });
  return { store, conversations, prompts, snapshot: turn.snapshot, job };
}

describe("image outcome notices in the captured character voice", () => {
  test("uses the original prompt and model, disables tools and bounds output after later edits", async () => {
    const { store, conversations, prompts, snapshot, job } = fixture();
    const original = JSON.stringify(snapshot);
    const identity = prompts.get("identity");
    if (!identity) throw new Error("Missing fictional identity prompt.");
    prompts.update(identity.id, {
      content: "Changed fictional voice for later turns.",
      expectedVersion: identity.version,
    });
    const settings = conversations.getSettings();
    conversations.saveSettings({
      ...settings,
      expectedVersion: settings.version,
      maxOutputTokens: 8192,
    });
    const generate = createImageFailureGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async (_url, init) => {
        const wire = String(init.body);
        const body = JSON.parse(wire);
        expect(body.model).toBe(snapshot.settings.model);
        expect(body.max_tokens).toBe(2048);
        expect(body.tools).toBeUndefined();
        expect(wire).toContain("Fictional original character voice.");
        expect(wire).not.toContain("Changed fictional voice");
        expect(wire).not.toContain(job.promptId);
        expect(body.messages.at(-1).content).toContain('"status":"failed"');
        expect(body.messages.at(-1).content).toContain('"stage":"image generation"');
        expect(body.messages.at(-1).content).toContain("your own character voice");
        expect(body.messages.at(-1).content).toContain("Do not claim the image was delivered");
        expect(body.messages.at(-1).content).toContain("promise an automatic retry");
        expect(body.messages.at(-1).content).toContain("invent a cause");
        return Response.json({
          choices: [
            {
              message: { content: "I'm sorry, Ember, I couldn't finish that picture." },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    const result = await generate(
      snapshot,
      { ...job, status: "failed", failureCode: "generation_failed" },
      new AbortController().signal,
    );
    expect(result.text).toBe("I'm sorry, Ember, I couldn't finish that picture.");
    expect(JSON.stringify(snapshot)).toBe(original);
  });

  test("uncertain delivery stays uncertain and never increases a smaller captured output budget", async () => {
    const { store, snapshot, job } = fixture();
    snapshot.settings.maxOutputTokens = 1024;
    const generate = createImageFailureGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.max_tokens).toBe(1024);
        expect(body.messages.at(-1).content).toContain('"status":"unknown"');
        expect(body.messages.at(-1).content).toContain('"stage":"Telegram delivery"');
        expect(body.messages.at(-1).content).toContain(
          "could not confirm the outcome, not that it definitely failed",
        );
        return Response.json({
          choices: [
            {
              message: { content: "I couldn't confirm whether the picture reached you, Ember." },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    const result = await generate(
      snapshot,
      { ...job, status: "unknown", assetId: "fictional-asset", failureCode: "delivery_unknown" },
      new AbortController().signal,
    );
    expect(result.text).toBe("I couldn't confirm whether the picture reached you, Ember.");
  });

  test("rejects successful and in-progress image states before asking the model for a failure notice", async () => {
    const { store, snapshot, job } = fixture();
    let requests = 0;
    const generate = createImageFailureGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async () => {
        requests++;
        return Response.json({});
      },
    });
    for (const status of [
      "queued",
      "submitting",
      "running",
      "recovery",
      "ready",
      "sending",
      "sent",
    ] as ImageJob["status"][])
      await expect(
        generate(snapshot, { ...job, status }, new AbortController().signal),
      ).rejects.toMatchObject({ code: "configuration" });
    expect(requests).toBe(0);
  });

  test("never executes a tool proposed during a notice and leaves partial text marked incomplete", async () => {
    const { store, snapshot, job } = fixture();
    const failed = { ...job, status: "failed" as const, failureCode: "generation_failed" };
    const unexpectedTool = createImageFailureGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async () =>
        Response.json({
          choices: [
            {
              message: { content: "", tool_calls: [{ id: "unrequested" }] },
              finish_reason: "tool_calls",
            },
          ],
        }),
    });
    await expect(
      unexpectedTool(snapshot, failed, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
    const partial = createImageFailureGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async () =>
        Response.json({
          choices: [{ message: { content: "I'm sorry" }, finish_reason: "length" }],
        }),
    });
    expect(await partial(snapshot, failed, new AbortController().signal)).toMatchObject({
      complete: false,
      finishReason: "length",
    });
  });
});
