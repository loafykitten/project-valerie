import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type ConversationSnapshot,
  createConversationService,
  createMemoryService,
  createPromptService,
  defaultImageGenerationPrompt,
  openStore,
  type Store,
} from "@valerie/core";
import type { NeuralwattModel } from "@valerie/inference";
import {
  createConversationGenerator,
  type ImageGenerationBinding,
  type ImageToolInvocation,
  materializeConversationMessages,
} from "./inference";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const imageCall = {
  id: "functions.generate_image:0",
  type: "function",
  function: {
    name: "generate_image",
    arguments: JSON.stringify({
      framing: "selfie",
      scene_tags: ["blue cardigan", "warm smile", "garden", "soft daylight"],
    }),
  },
};
const imageRequestResponse = (calls: unknown[] = [imageCall]) =>
  Response.json(
    {
      choices: [
        {
          message: { content: "Unconfirmed text that must never be delivered.", tool_calls: calls },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 8,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    },
    { headers: { "x-request-id": "fictional-tool-request" } },
  );
const acknowledgementResponse = () =>
  Response.json(
    {
      choices: [
        {
          message: { content: "Give me a moment, Ember. I'm making that picture for you." },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 35,
        completion_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    },
    { headers: { "x-request-id": "fictional-acknowledgement" } },
  );

function imageToolSetup(imageDirection?: string) {
  const fixture = setup();
  const prompts = createPromptService(fixture.store);
  if (imageDirection !== undefined)
    prompts.update("image-generation", { content: imageDirection, expectedVersion: 1 });
  fixture.snapshot.prompt = prompts.compose("telegram-text", { imageGeneration: true });
  fixture.snapshot.messages = [
    {
      role: "system",
      content: `Fictional saved character voice.\n\n${fixture.snapshot.prompt.content}`,
    },
    { role: "user", content: "Could you send a selfie?" },
    { role: "system", content: "Fictional saved post-history instruction." },
  ];
  fixture.snapshot.imageGenerationEnabled = true;
  fixture.snapshot.settings.modelCapabilities = { ...model, tools: true };
  let saved: ImageToolInvocation | null = null;
  let enqueues = 0;
  const binding: ImageGenerationBinding = {
    getForTurn: () => saved,
    enqueue: ({ invocation }) => {
      enqueues++;
      saved ??= { ...invocation, result: { jobId: "fictional-image-job", status: "queued" } };
      return saved;
    },
  };
  return { ...fixture, binding, enqueues: () => enqueues, saved: () => saved };
}

describe("character image requests", () => {
  test("Flex executes a streamed image proposal only after its completion receipt", async () => {
    for (const truncated of [true, false]) {
      const fixture = imageToolSetup();
      fixture.snapshot.settings.model = "fictional-vision-flex";
      fixture.snapshot.settings.modelCapabilities = {
        ...model,
        id: "fictional-vision-flex",
        tools: true,
      };
      let requests = 0;
      const generate = createConversationGenerator({
        store: fixture.store,
        apiKey: "fictional",
        imageGeneration: fixture.binding,
        transport: async (_url, init) => {
          requests++;
          expect(JSON.parse(String(init.body)).stream).toBe(true);
          const first = requests === 1;
          expect(fixture.enqueues()).toBe(first ? 0 : 1);
          const wire = first
            ? { delta: { tool_calls: [{ index: 0, ...imageCall }] }, finish_reason: "tool_calls" }
            : {
                delta: { content: "Give me a moment to make that picture." },
                finish_reason: "stop",
              };
          return new Response(
            `data: ${JSON.stringify({ service_tier: "flex", choices: [{ index: 0, ...wire }] })}\n\n${truncated ? "" : "data: [DONE]\n\n"}`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      if (truncated) {
        await expect(
          generate(fixture.snapshot, new AbortController().signal, "fictional-turn"),
        ).rejects.toMatchObject({ code: "invalid_response" });
        expect(fixture.enqueues()).toBe(0);
      } else {
        const result = await generate(
          fixture.snapshot,
          new AbortController().signal,
          "fictional-turn",
        );
        expect(result).toMatchObject({
          complete: true,
          serviceTier: "flex",
          text: "Give me a moment to make that picture.",
        });
        expect(fixture.enqueues()).toBe(1);
        expect(requests).toBe(2);
      }
    }
  });

  test("memory and an image share a durable tool round and retry without repeating either write", async () => {
    const fixture = imageToolSetup();
    fixture.conversations.acceptTelegramBatch({
      nextOffset: 2,
      inputs: [
        {
          updateId: 1,
          messageId: "1",
          chatId: "123",
          senderId: "123",
          text: "I prefer a written checklist. Send a selfie?",
        },
      ],
    });
    const input = fixture.store.db
      .query<{ id: string; turnId: string }, []>(
        "SELECT id,turn_id AS turnId FROM core_telegram_inputs",
      )
      .get();
    if (!input) throw new Error("Fixture missing current input.");
    fixture.snapshot.memory = createMemoryService(fixture.store).capture("checklist");
    fixture.snapshot.memoryToolsEnabled = true;
    const memoryCall = {
      id: "functions.memory_save:0",
      type: "function",
      function: {
        name: "memory_save",
        arguments: JSON.stringify({
          title: "written checklist",
          body: "I prefer a written checklist.",
          kind: "preference",
          sourceIds: [`conversation:${input.id}`],
        }),
      },
    };
    let requests = 0;
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: fixture.binding,
      transport: async (_url, request) => {
        requests++;
        const body = JSON.parse(String(request.body));
        expect(
          body.tools.map((tool: { function: { name: string } }) => tool.function.name),
        ).toContain("activity_search");
        if (requests === 1) return imageRequestResponse([memoryCall, imageCall]);
        expect(
          body.messages.filter((message: { role: string }) => message.role === "tool"),
        ).toHaveLength(2);
        expect(String(request.body)).not.toContain("Unconfirmed text");
        expect(String(request.body)).toContain('\\"status\\":\\"queued\\"');
        if (requests === 2) return new Response("private provider failure", { status: 503 });
        return acknowledgementResponse();
      },
    });
    await expect(
      generate(fixture.snapshot, new AbortController().signal, input.turnId),
    ).rejects.toMatchObject({ code: "provider" });
    const result = await generate(fixture.snapshot, new AbortController().signal, input.turnId);
    expect(result.complete).toBe(true);
    expect(result.usage.inputTokens).toBe(55);
    expect(fixture.enqueues()).toBe(1);
    expect(fixture.saved()?.call.id).toBe(imageCall.id);
    expect(fixture.saved()?.completion.usage.inputTokens).toBe(20);
    expect(
      fixture.store.db.query("SELECT count(*) AS count FROM core_memory_operations").get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.store.db.query("SELECT count(*) AS count FROM core_tool_outcomes").get(),
    ).toEqual({ count: 2 });
    // Retried journal playback is not another provider call. Failed calls retain unknown usage.
    expect(
      fixture.store.db
        .query(`SELECT input_tokens AS input, failure_code AS failure
      FROM core_context_requests ORDER BY rowid`)
        .all(),
    ).toEqual([
      { input: 20, failure: null },
      { input: null, failure: "provider" },
      { input: 35, failure: null },
    ]);
  });

  test("queues once and uses the model's in-character acknowledgement with pinned prompts and settings", async () => {
    const fixture = imageToolSetup();
    const before = JSON.stringify(fixture.snapshot);
    let requests = 0;
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: fixture.binding,
      transport: async (_url, request) => {
        requests++;
        const body = JSON.parse(String(request.body));
        expect(body.model).toBe(fixture.snapshot.settings.model);
        expect(body.max_tokens).toBe(fixture.snapshot.settings.maxOutputTokens);
        expect(body.messages).toContainEqual(fixture.snapshot.messages[0]);
        expect(body.messages).toContainEqual(fixture.snapshot.messages[2]);
        expect(
          body.messages
            .map((message: { content: string }) => message.content)
            .join("\n")
            .split(defaultImageGenerationPrompt),
        ).toHaveLength(2);
        if (requests === 1) {
          expect(body.tools[0].function.name).toBe("generate_image");
          expect(body.messages.at(-1)).toEqual(fixture.snapshot.messages[2]);
          return imageRequestResponse();
        }
        expect(fixture.enqueues()).toBe(1);
        expect(body.tools).toBeUndefined();
        expect(body.messages).toContainEqual({
          role: "assistant",
          content: "",
          tool_calls: [imageCall],
        });
        expect(body.messages).toContainEqual({
          role: "tool",
          tool_call_id: imageCall.id,
          content: JSON.stringify({ jobId: "fictional-image-job", status: "queued" }),
        });
        expect(String(request.body)).not.toContain("Unconfirmed text");
        expect(body.messages.at(-1).content).toContain("your own character voice");
        expect(body.messages.at(-1).content).toContain("take a moment");
        expect(body.messages.at(-1).content).toContain("do not claim it has been sent");
        return acknowledgementResponse();
      },
    });
    const result = await generate(fixture.snapshot, new AbortController().signal, "fictional-turn");
    expect(result.text).toBe("Give me a moment, Ember. I'm making that picture for you.");
    expect(result.usage).toEqual({
      inputTokens: 55,
      outputTokens: 23,
      cachedInputTokens: null,
      reasoningTokens: 3,
    });
    expect(result.costUsd).toBeNull();
    expect(result.requestId).toBe("fictional-acknowledgement");
    expect(fixture.saved()?.completion.requestId).toBe("fictional-tool-request");
    expect(requests).toBe(2);
    expect(JSON.stringify(fixture.snapshot)).toBe(before);
  });

  test("an acknowledgement retry resumes the saved tool outcome without another enqueue or image selection", async () => {
    const fixture = imageToolSetup("Original fictional picture direction.");
    const before = JSON.stringify(fixture.snapshot);
    let requests = 0;
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: fixture.binding,
      transport: async (_url, request) => {
        requests++;
        const body = JSON.parse(String(request.body));
        const content = body.messages
          .map((message: { content: string }) => message.content)
          .join("\n");
        expect(content).toContain("Original fictional picture direction.");
        expect(content).not.toContain("Updated fictional picture direction.");
        expect(content).not.toContain(defaultImageGenerationPrompt);
        if (requests === 1) return imageRequestResponse();
        expect(body.tools).toBeUndefined();
        if (requests === 2) return new Response("private provider error", { status: 503 });
        return acknowledgementResponse();
      },
    });
    await expect(
      generate(fixture.snapshot, new AbortController().signal, "fictional-turn"),
    ).rejects.toMatchObject({ code: "provider" });
    expect(fixture.enqueues()).toBe(1);
    createPromptService(fixture.store).update("image-generation", {
      content: "Updated fictional picture direction.",
      expectedVersion: 2,
    });
    const result = await generate(fixture.snapshot, new AbortController().signal, "fictional-turn");
    expect(result.complete).toBe(true);
    expect(requests).toBe(3);
    expect(fixture.enqueues()).toBe(1);
    expect(result.usage.inputTokens).toBe(55);
    expect(JSON.stringify(fixture.snapshot)).toBe(before);
  });

  test("a cleared pinned image direction is honored without restoring the original default", async () => {
    const fixture = imageToolSetup("");
    expect(fixture.snapshot.prompt.versions["image-generation"]).toBe(2);
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: fixture.binding,
      transport: async (_url, request) => {
        const body = JSON.parse(String(request.body));
        expect(body.tools[0].function.name).toBe("generate_image");
        const content = body.messages
          .map((message: { content: string }) => message.content)
          .join("\n");
        expect(content).not.toContain(defaultImageGenerationPrompt);
        expect(content).not.toContain("# Image Generation");
        return acknowledgementResponse();
      },
    });
    await generate(fixture.snapshot, new AbortController().signal, "fictional-turn");
    expect(fixture.enqueues()).toBe(0);
  });

  test("legacy enabled snapshots keep the original image direction despite newer saved edits", async () => {
    const fixture = imageToolSetup("New direction saved after this legacy turn.");
    fixture.snapshot.prompt = createPromptService(fixture.store).compose("telegram-text");
    fixture.snapshot.messages[0] = { role: "system", content: "Fictional legacy character voice." };
    const before = JSON.stringify(fixture.snapshot);
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: fixture.binding,
      transport: async (_url, request) => {
        const body = JSON.parse(String(request.body));
        expect(body.messages[0]).toEqual({ role: "system", content: defaultImageGenerationPrompt });
        expect(String(request.body)).not.toContain("New direction saved after this legacy turn.");
        expect(body.tools[0].function.name).toBe("generate_image");
        return acknowledgementResponse();
      },
    });
    await generate(fixture.snapshot, new AbortController().signal, "fictional-turn");
    expect(JSON.stringify(fixture.snapshot)).toBe(before);
  });

  test("malformed, extra-field and multiple tool calls produce a generated failure without queueing", async () => {
    for (const calls of [
      [{ ...imageCall, function: { ...imageCall.function, arguments: "{" } }],
      [
        {
          ...imageCall,
          function: {
            ...imageCall.function,
            arguments: JSON.stringify({
              framing: "selfie",
              scene_tags: ["garden"],
              workflow: "untrusted",
            }),
          },
        },
      ],
      [imageCall, { ...imageCall, id: "second-call" }],
    ]) {
      const fixture = imageToolSetup();
      let requests = 0;
      const generate = createConversationGenerator({
        store: fixture.store,
        apiKey: "fictional-secret",
        imageGeneration: fixture.binding,
        transport: async (_url, request) => {
          requests++;
          if (requests === 1) return imageRequestResponse(calls);
          const body = JSON.parse(String(request.body));
          if (calls.length === 1) expect(body.tools[0].function.name).toBe("generate_image");
          else expect(body.tools).toBeUndefined();
          const results = body.messages.filter(
            (message: { role: string }) => message.role === "tool",
          );
          expect(results).toHaveLength(calls.length);
          for (const result of results)
            expect(JSON.parse(result.content)).toMatchObject({
              status: "rejected",
              imageQueued: false,
            });
          return Response.json({
            choices: [
              {
                message: { content: "I couldn't get the picture started, Ember." },
                finish_reason: "stop",
              },
            ],
          });
        },
      });
      expect(
        (await generate(fixture.snapshot, new AbortController().signal, "fictional-turn")).text,
      ).toBe("I couldn't get the picture started, Ember.");
      expect(fixture.enqueues()).toBe(0);
      expect(
        fixture.store.db
          .query("SELECT count(*) AS count FROM core_activity WHERE kind='image.tool_rejected'")
          .get(),
      ).toEqual({ count: 1 });
    }
  });

  test("the workflow's argument rejection is reported in character and does not fabricate queued success", async () => {
    const fixture = imageToolSetup();
    let requests = 0;
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: {
        getForTurn: () => null,
        enqueue: () => {
          throw new TypeError("private identity restriction");
        },
      },
      transport: async (_url, request) => {
        if (++requests === 1) return imageRequestResponse();
        expect(String(request.body)).not.toContain("private identity restriction");
        expect(String(request.body)).toContain("invalid_image_arguments");
        return Response.json({
          choices: [
            {
              message: { content: "I couldn't get the picture started, Ember." },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    await generate(fixture.snapshot, new AbortController().signal, "fictional-turn");
    expect(requests).toBe(2);
  });

  test("repairs comma-separated scene tags once, queues only the valid array, and persists cumulative usage for acknowledgement retries", async () => {
    const fixture = imageToolSetup();
    const before = JSON.stringify(fixture.snapshot);
    const malformed = {
      ...imageCall,
      function: {
        ...imageCall.function,
        arguments: JSON.stringify({
          framing: "selfie",
          scene_tags: "blue cardigan, warm smile, garden",
        }),
      },
    };
    let requests = 0;
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: fixture.binding,
      transport: async (_url, request) => {
        requests++;
        const body = JSON.parse(String(request.body));
        if (requests === 1) {
          expect(body.tools[0].function.parameters.properties.scene_tags.description).toContain(
            "A JSON array",
          );
          expect(body.messages[0].content).toContain('"scene_tags":["blue cardigan"');
          return imageRequestResponse([malformed]);
        }
        if (requests === 2) {
          expect(fixture.enqueues()).toBe(0);
          expect(body.tools[0].function.name).toBe("generate_image");
          expect(body.messages.at(-1).content).toContain("only correction attempt");
          expect(body.messages.at(-1).content).toContain(
            "Remove all identity attributes, hair, eyes, ears, glasses",
          );
          expect(body.messages).toContainEqual({
            role: "tool",
            tool_call_id: malformed.id,
            content: JSON.stringify({
              status: "rejected",
              code: "invalid_image_arguments",
              imageQueued: false,
            }),
          });
          // Providers can reuse a tool-call ID across requests; the final pair stays unambiguous.
          return imageRequestResponse();
        }
        expect(fixture.enqueues()).toBe(1);
        expect(body.tools).toBeUndefined();
        expect(
          body.messages.filter((message: { role: string }) => message.role === "tool"),
        ).toEqual([
          {
            role: "tool",
            tool_call_id: imageCall.id,
            content: JSON.stringify({ jobId: "fictional-image-job", status: "queued" }),
          },
        ]);
        expect(String(request.body)).not.toContain("only correction attempt");
        if (requests === 3) return new Response("private provider error", { status: 503 });
        return acknowledgementResponse();
      },
    });
    await expect(
      generate(fixture.snapshot, new AbortController().signal, "fictional-turn"),
    ).rejects.toMatchObject({ code: "provider" });
    expect(fixture.saved()?.completion.usage).toEqual({
      inputTokens: 40,
      outputTokens: 16,
      cachedInputTokens: null,
      reasoningTokens: 4,
    });
    const rejection = fixture.store.db
      .query<{ metadata_json: string }, []>(
        "SELECT metadata_json FROM core_activity WHERE kind='image.tool_rejected'",
      )
      .get();
    expect(JSON.parse(rejection?.metadata_json ?? "{}")).toMatchObject({
      calls: [{ arguments: malformed.function.arguments }],
      usage: { inputTokens: 20, outputTokens: 8 },
      requestId: "fictional-tool-request",
      attempt: 1,
    });
    const final = await generate(fixture.snapshot, new AbortController().signal, "fictional-turn");
    expect(final.text).toBe("Give me a moment, Ember. I'm making that picture for you.");
    expect(final.usage).toEqual({
      inputTokens: 75,
      outputTokens: 31,
      cachedInputTokens: null,
      reasoningTokens: 5,
    });
    expect(final.costUsd).toBeNull();
    expect(fixture.enqueues()).toBe(1);
    expect(requests).toBe(4);
    expect(JSON.stringify(fixture.snapshot)).toBe(before);
  });

  test("two invalid argument rounds end with one generated failure and no queued image", async () => {
    const fixture = imageToolSetup();
    let requests = 0;
    const malformed = {
      ...imageCall,
      function: {
        ...imageCall.function,
        arguments: JSON.stringify({ framing: "selfie", scene_tags: "garden, soft daylight" }),
      },
    };
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: fixture.binding,
      transport: async (_url, request) => {
        requests++;
        const body = JSON.parse(String(request.body));
        if (requests < 3) {
          expect(body.tools[0].function.name).toBe("generate_image");
          return imageRequestResponse([malformed]);
        }
        expect(body.tools).toBeUndefined();
        expect(body.messages.at(-1).content).toContain("no image was queued");
        expect(body.messages.at(-1).content).toContain("Do not promise delivery");
        return Response.json({
          choices: [
            {
              message: { content: "I couldn't get the picture started, Ember." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        });
      },
    });
    const final = await generate(fixture.snapshot, new AbortController().signal, "fictional-turn");
    expect(final.text).toBe("I couldn't get the picture started, Ember.");
    expect(final.usage.inputTokens).toBe(52);
    expect(final.usage.outputTokens).toBe(22);
    expect(requests).toBe(3);
    expect(fixture.enqueues()).toBe(0);
    const rejections = fixture.store.db
      .query<{ metadata_json: string }, []>(
        "SELECT metadata_json FROM core_activity WHERE kind='image.tool_rejected' ORDER BY rowid",
      )
      .all()
      .map((row) => JSON.parse(row.metadata_json));
    expect(rejections).toHaveLength(2);
    expect(rejections.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(
      rejections.every(({ usage }) => usage.inputTokens === 20 && usage.outputTokens === 8),
    ).toBe(true);
  });

  test("workflow identity restrictions remain enforced and only safe validation reasons reach a correction", async () => {
    for (const code of ["identity_conflict", "invalid_scene"] as const) {
      const fixture = imageToolSetup();
      let requests = 0;
      let rejected = false;
      const generate = createConversationGenerator({
        store: fixture.store,
        apiKey: "fictional-secret",
        imageGeneration: {
          getForTurn: fixture.binding.getForTurn,
          enqueue: (input) => {
            if (!rejected) {
              rejected = true;
              throw new TypeError(code);
            }
            return fixture.binding.enqueue(input);
          },
        },
        transport: async (_url, request) => {
          requests++;
          if (requests === 1) return imageRequestResponse();
          const body = JSON.parse(String(request.body));
          if (requests === 2) {
            expect(body.messages).toContainEqual({
              role: "tool",
              tool_call_id: imageCall.id,
              content: JSON.stringify({ status: "rejected", code, imageQueued: false }),
            });
            expect(body.tools[0].function.name).toBe("generate_image");
            return imageRequestResponse();
          }
          expect(body.tools).toBeUndefined();
          return acknowledgementResponse();
        },
      });
      expect(
        (await generate(fixture.snapshot, new AbortController().signal, "fictional-turn")).complete,
      ).toBe(true);
      expect(fixture.enqueues()).toBe(1);
      expect(requests).toBe(3);
    }
  });

  test("new tools require configured image generation, a pinned enabled snapshot, turn identity and verified model tools", async () => {
    for (const disabled of ["configuration", "snapshot", "model", "turn"] as const) {
      const fixture = imageToolSetup();
      if (disabled === "snapshot") fixture.snapshot.imageGenerationEnabled = false;
      if (disabled === "model")
        fixture.snapshot.settings.modelCapabilities = { ...model, tools: false };
      const generate = createConversationGenerator({
        store: fixture.store,
        apiKey: "fictional-secret",
        imageGeneration: disabled === "configuration" ? undefined : fixture.binding,
        transport: async (_url, request) => {
          expect(JSON.parse(String(request.body)).tools).toBeUndefined();
          return acknowledgementResponse();
        },
      });
      await generate(
        fixture.snapshot,
        new AbortController().signal,
        disabled === "turn" ? undefined : "fictional-turn",
      );
      expect(fixture.enqueues()).toBe(0);
    }
  });

  test("a second-round tool proposal is rejected instead of executing another image request", async () => {
    const fixture = imageToolSetup();
    const generate = createConversationGenerator({
      store: fixture.store,
      apiKey: "fictional-secret",
      imageGeneration: fixture.binding,
      transport: async () => imageRequestResponse(),
    });
    await expect(
      generate(fixture.snapshot, new AbortController().signal, "fictional-turn"),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fixture.enqueues()).toBe(1);
  });
});
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=",
  "base64",
);
const sha256 = createHash("sha256").update(image).digest("hex");
const attachmentId = "11111111-1111-4111-8111-111111111111";
const model: NeuralwattModel = {
  id: "fictional-vision",
  displayName: "Fictional Vision",
  maxContextTokens: 262144,
  maxOutputTokens: 8192,
  vision: true,
  maxImages: 20,
  systemRole: true,
  reasoningEffort: false,
  deprecated: false,
  reasoning: null,
  pricing: {
    currency: "USD",
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
    pricingTbd: true,
  },
};

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  const conversations = createConversationService(store);
  const current = conversations.getSettings();
  conversations.saveSettings({
    ...current,
    expectedVersion: current.version,
    model: model.id,
    modelCapabilities: model,
    modelContextTokens: 262144,
    modelMaxOutputTokens: 8192,
    reasoningEffort: null,
  });
  const snapshot: ConversationSnapshot = {
    capturedAt: "2026-09-13T08:00:00.000Z",
    settings: conversations.getSettings(),
    prompt: createPromptService(store).compose("telegram-text"),
    messages: [
      { role: "system", content: "Fictional saved prompt." },
      { role: "user", content: "Earlier fictional topic." },
      { role: "assistant", content: "Earlier confirmed answer." },
      {
        role: "user",
        content: [
          { type: "text", text: "What do you see?" },
          { type: "image", attachmentId, sha256, mimeType: "image/png" },
          { type: "text", text: "One sentence, please." },
        ],
      },
      { role: "system", content: "Fictional Post-History Instructions." },
    ],
    history: {
      estimator: "utf8-byte-upper-bound-plus-image-allowance",
      includedTurns: 1,
      estimatedTokens: 8192,
      budgetTokens: 96000,
      since: "2026-09-11T08:00:00.000Z",
      truncated: false,
    },
  };
  return { store, conversations, snapshot };
}

describe("immutable conversation image materialization", () => {
  test("keeps captions, images, history and Post-History Instructions in order without mutating the snapshot", () => {
    const { snapshot } = setup();
    const before = JSON.stringify(snapshot);
    const reader = (id: string) => {
      expect(id).toBe(attachmentId);
      return {
        bytes: image,
        sha256,
        mimeType: "image/png",
        fileId: "private-telegram-file-id",
        url: "https://api.telegram.org/file/bot123:private/photos/image.png",
      };
    };
    const messages = materializeConversationMessages(snapshot, reader);
    expect(messages).toEqual([
      { role: "system", content: "Fictional saved prompt." },
      { role: "user", content: "Earlier fictional topic." },
      { role: "assistant", content: "Earlier confirmed answer." },
      {
        role: "user",
        content: [
          { type: "text", text: "What do you see?" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
          },
          { type: "text", text: "One sentence, please." },
        ],
      },
      { role: "system", content: "Fictional Post-History Instructions." },
    ]);
    const wire = JSON.stringify(messages);
    expect(wire).not.toContain("telegram.org");
    expect(wire).not.toContain("private-telegram-file-id");
    expect(wire).not.toContain("attachmentId");
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(before).not.toContain("base64");
    expect(before).toContain(attachmentId);
  });

  test("fails closed for missing assets, mismatched metadata, and bytes that no longer match their saved hash", () => {
    const { snapshot } = setup();
    const modified = Uint8Array.from(image);
    modified[modified.length - 1] = (modified[modified.length - 1] ?? 0) ^ 1;
    for (const attachment of [
      undefined,
      { bytes: image, sha256: "0".repeat(64), mimeType: "image/png" },
      { bytes: image, sha256, mimeType: "image/jpeg" },
      { bytes: modified, sha256, mimeType: "image/png" },
    ]) {
      try {
        materializeConversationMessages(snapshot, () => attachment);
        throw new Error("Expected pinned attachment validation to fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "configuration" });
        expect(String(error)).not.toContain(attachmentId);
      }
    }
  });

  test("the generator rejects a missing pinned asset before making a provider request", async () => {
    const { store, snapshot } = setup();
    let calls = 0;
    const generate = createConversationGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async () => {
        calls++;
        return Response.json({});
      },
    });
    await expect(
      Promise.resolve().then(() => generate(snapshot, new AbortController().signal)),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(calls).toBe(0);
  });

  test("the generator uses the archived image and captured settings after newer edits", async () => {
    const { store, conversations } = setup();
    const prompts = createPromptService(store);
    const identity = prompts.get("identity");
    if (!identity) throw new Error("Missing fictional identity prompt");
    prompts.update("identity", {
      content: "Original fictional identity.",
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
          text: "Describe this fictional image.",
          images: [
            {
              fileId: "private-telegram-file-id",
              fileUniqueId: "private-telegram-unique-id",
              mimeType: "image/png",
            },
          ],
        },
      ],
    });
    const download = conversations.claimAttachmentDownload();
    if (!download) throw new Error("Expected pending fictional image");
    conversations.saveAttachment(download.id, { bytes: image });
    const turn = conversations.startNextTurn();
    if (!turn) throw new Error("Expected an image-ready turn");
    const before = JSON.stringify(turn.snapshot);
    const current = conversations.getSettings();
    conversations.saveSettings({
      ...current,
      expectedVersion: current.version,
      maxOutputTokens: 1024,
      temperature: 1.5,
    });
    const edited = prompts.get("identity");
    if (!edited) throw new Error("Missing fictional identity prompt");
    prompts.update("identity", {
      content: "New fictional identity, for the next turn.",
      expectedVersion: edited.version,
    });
    let calls = 0;
    const generate = createConversationGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async (_url, request) => {
        calls++;
        const wire = String(request.body);
        const body = JSON.parse(wire);
        expect(body.model).toBe(turn.snapshot.settings.model);
        expect(body.max_tokens).toBe(turn.snapshot.settings.maxOutputTokens);
        expect(body.temperature).toBeUndefined();
        expect(wire).toContain("Original fictional identity.");
        expect(wire).not.toContain("New fictional identity");
        expect(wire).not.toContain("private-telegram");
        expect(wire).not.toContain("telegram.org");
        expect(wire).not.toContain("attachmentId");
        expect(body.messages.at(-1)).toEqual({
          role: "user",
          content: [
            { type: "text", text: "Describe this fictional image." },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
            },
          ],
        });
        return Response.json({
          choices: [{ message: { content: "A fictional pixel." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        });
      },
    });
    expect((await generate(turn.snapshot, new AbortController().signal)).text).toBe(
      "A fictional pixel.",
    );
    expect(calls).toBe(1);
    expect(JSON.stringify(turn.snapshot)).toBe(before);
    expect(before).not.toContain("base64");
    expect(before).toContain(download.id);
    expect(conversations.getAttachment(download.id)?.bytes).toEqual(new Uint8Array(image));
  });

  test("corrupted stored bytes fail their pinned SHA check before inference", async () => {
    const { store, conversations } = setup();
    conversations.acceptTelegramBatch({
      nextOffset: 2,
      inputs: [
        {
          updateId: 1,
          messageId: "1",
          chatId: "42",
          senderId: "42",
          text: "",
          images: [{ fileId: "fictional-file", fileUniqueId: "fictional-unique" }],
        },
      ],
    });
    const download = conversations.claimAttachmentDownload();
    if (!download) throw new Error("Expected pending fictional image");
    conversations.saveAttachment(download.id, { bytes: image });
    const turn = conversations.startNextTurn();
    if (!turn) throw new Error("Expected an image-ready turn");
    const corrupted = Uint8Array.from(image);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 1;
    // Emulate corruption below the immutable archive API in this disposable in-memory store.
    store.db.exec("DROP TRIGGER core_conversation_attachment_immutable");
    store.db
      .query("UPDATE core_conversation_attachments SET original_bytes = ? WHERE id = ?")
      .run(corrupted, download.id);
    let calls = 0;
    const generate = createConversationGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async () => {
        calls++;
        return Response.json({});
      },
    });
    await expect(
      Promise.resolve().then(() => generate(turn.snapshot, new AbortController().signal)),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(calls).toBe(0);
  });
});
