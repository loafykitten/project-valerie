import { afterEach, describe, expect, test } from "bun:test";
import {
  createCharacterService,
  createConversationService,
  createHeartbeatContextService,
  createMemoryService,
  createPromptService,
  defaultHeartbeatPrompt,
  HEARTBEAT_SILENT_MARKER,
  type HeartbeatSnapshot,
  openStore,
  type Store,
} from "@valerie/core";
import type { NeuralwattModel, TextCompletion } from "@valerie/inference";
import { createHeartbeatGenerator, validateHeartbeatCompletion } from "./generation";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const model: NeuralwattModel = {
  id: "fictional-reasoning",
  displayName: "Fictional Reasoning",
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  systemRole: true,
  reasoningEffort: true,
  deprecated: false,
  tools: true,
  vision: false,
  maxImages: null,
  reasoning: {
    mandatory: true,
    defaultEnabled: true,
    defaultEffort: "medium",
    supportedEfforts: ["medium"],
    acceptedEfforts: ["medium"],
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

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  let clock = new Date("2026-09-15T20:00:00.000Z");
  const now = () => clock;
  const prompts = createPromptService(store);
  const conversations = createConversationService(store, { now, prompts });
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    model: model.id,
    modelCapabilities: model,
    maxOutputTokens: 8192,
    modelMaxOutputTokens: 16384,
    reasoningEffort: "medium",
  });
  let messageId = 0;
  const accept = (text: string, receivedAt = now().toISOString(), chatId = "123") => {
    messageId++;
    conversations.acceptTelegramBatch({
      nextOffset: messageId + 1,
      inputs: [
        {
          updateId: messageId,
          messageId: String(messageId),
          chatId,
          senderId: chatId,
          text,
          receivedAt,
        },
      ],
    });
  };
  const respond = (text: string, status: "sent" | "unknown" = "sent") => {
    const turn = conversations.startNextTurn();
    if (!turn) throw new Error("Missing fictional turn.");
    conversations.completeGeneration(turn.id, { text });
    const delivery = conversations.claimDelivery();
    if (!delivery) throw new Error("Missing fictional delivery.");
    conversations.recordDelivery(
      delivery.id,
      status === "sent" ? { status, messageId: "900" } : { status, code: "network" },
    );
    return turn;
  };
  return {
    store,
    prompts,
    conversations,
    now,
    accept,
    respond,
    context: createHeartbeatContextService(store, { now }),
    setTime: (value: string) => {
      clock = new Date(value);
    },
  };
}

function completion(text: string, overrides: Partial<TextCompletion> = {}): TextCompletion {
  return {
    text,
    finishReason: "stop",
    complete: true,
    requestId: "fictional-receipt",
    usage: { inputTokens: 200, outputTokens: 1500, reasoningTokens: 1400 },
    costUsd: null,
    ...overrides,
  };
}

describe("heartbeat context", () => {
  test("pins editable voice, core memory, actual messages and delivery timestamps without adding a turn", () => {
    const f = setup();
    createCharacterService(f.store).import(
      Buffer.from(
        JSON.stringify({
          name: "Fictional companion",
          description: "A fictional gentle companion.",
          post_history_instructions: "Keep this authored ending.\n  Preserve spacing.",
        }),
      ),
      { sourceFilename: "fictional.json", expectedActiveImportId: null },
    );
    f.prompts.update("voice", {
      content: "A warm fictional voice, with playful questions.",
      expectedVersion: 1,
    });
    f.prompts.update("heartbeat", {
      content: "Prefer a short invitation to share a small delight.",
      expectedVersion: 1,
    });
    const memories = createMemoryService(f.store, { now: f.now });
    const pinned = memories.save({
      tier: "core",
      kind: "preference",
      title: "Fictional hobbies",
      body: "I enjoy tiny puzzle games and making pottery.",
    });
    f.accept("I finished my little clay bowl.", "2026-09-15T19:00:00.000Z");
    f.respond("I love how much care you put into it.");
    f.accept("I am winding down now.", "2026-09-15T19:55:00.000Z");
    const waiting = f.conversations.startNextTurn();
    if (!waiting) throw new Error("Missing fictional turn.");
    f.conversations.failGeneration(waiting.id, {
      code: "invalid_response",
      result: { text: "Unconfirmed fictional answer, never delivered." },
    });
    const snapshot = f.context.capture({
      chatId: "123",
      recentHeartbeats: [
        { text: "A little warmth from earlier.", deliveredAt: "2026-09-15T18:00:00.000Z" },
      ],
    });
    expect(snapshot.prompt.versions.heartbeat).toBe(2);
    expect(snapshot.prompt.content).toContain("A warm fictional voice");
    expect(snapshot.prompt.content).toContain("Prefer a short invitation");
    expect(snapshot.prompt.versions["memory-direction"]).toBeUndefined();
    expect(snapshot.prompt.versions["image-generation"]).toBeUndefined();
    expect(snapshot.messages.at(-1)?.content).toContain(
      "Keep this authored ending.\n  Preserve spacing.",
    );
    expect(snapshot.memory.core[0]?.body).toBe(pinned.body);
    expect(snapshot.history.includedOwnerMessages).toBe(2);
    expect(snapshot.history.includedAssistantMessages).toBe(1);
    expect(
      snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["I finished my little clay bowl.", "I am winding down now."]);
    const contents = snapshot.messages.map((message) => message.content).join("\n");
    expect(contents).toContain("3:00:00 PM CDT");
    expect(contents).toContain("2:55:00 PM CDT");
    expect(contents).toContain("I love how much care you put into it.");
    expect(contents).not.toContain("Unconfirmed fictional answer");
    expect(contents).toContain("A little warmth from earlier.");
    expect(
      f.store.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM core_conversation_turns")
        .get()?.count,
    ).toBe(2);
    expect(
      f.store.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM core_telegram_inputs")
        .get()?.count,
    ).toBe(2);
    f.prompts.update("heartbeat", { content: "Later heartbeat edit", expectedVersion: 2 });
    memories.save({
      ...pinned,
      id: pinned.id,
      expectedVersion: pinned.version,
      tier: "core",
      body: "A later preference",
    });
    expect(snapshot.prompt.content).not.toContain("Later heartbeat edit");
    expect(snapshot.memory.core[0]?.body).toBe(pinned.body);
    expect(f.context.capture({ chatId: "123" }).prompt.versions.heartbeat).toBe(3);
  });

  test("keeps the 48-hour window, the right chat and only confirmed assistant text", () => {
    const f = setup();
    f.setTime("2026-09-13T19:00:00.000Z");
    f.accept("Old message outside the window.");
    f.respond("Old delivered answer outside the window.");
    f.setTime("2026-09-15T19:00:00.000Z");
    f.accept("Another chat should remain private.", f.now().toISOString(), "456");
    f.respond("Another chat's answer.");
    f.accept("A message whose answer was uncertain.");
    f.respond("An uncertain answer should not appear.", "unknown");
    f.setTime("2026-09-15T20:00:00.000Z");
    const snapshot = f.context.capture({ chatId: "123" });
    const contents = snapshot.messages.map((message) => message.content).join("\n");
    expect(snapshot.history.since).toBe("2026-09-13T20:00:00.000Z");
    expect(contents).toContain("A message whose answer was uncertain.");
    expect(contents).not.toContain("An uncertain answer should not appear.");
    expect(contents).not.toContain("Old message outside the window.");
    expect(contents).not.toContain("Old delivered answer outside the window.");
    expect(contents).not.toContain("Another chat");
  });

  test("retains the latest owner statement with a zero optional history budget", () => {
    const f = setup();
    f.accept("An earlier ordinary topic.");
    f.respond("An earlier ordinary response.");
    f.accept("Please keep tonight quiet.");
    const settings = f.conversations.getSettings();
    f.conversations.saveSettings({
      ...settings,
      expectedVersion: settings.version,
      historyTokens: 0,
    });
    const snapshot = f.context.capture({ chatId: "123" });
    expect(
      snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["Please keep tonight quiet."]);
    expect(snapshot.history.includedAssistantMessages).toBe(0);
    expect(snapshot.history.truncated).toBe(true);
  });

  test("fails closed when the pinned prompt or latest owner statement cannot fit", () => {
    const f = setup();
    f.prompts.update("heartbeat", { content: "x".repeat(130000), expectedVersion: 1 });
    expect(() => f.context.capture({ chatId: "123" })).toThrow("context_budget_exceeded");
    f.prompts.update("heartbeat", { content: "", expectedVersion: 2 });
    const settings = f.conversations.getSettings();
    f.conversations.saveSettings({
      ...settings,
      expectedVersion: settings.version,
      contextTokens: 32768,
    });
    f.accept("x".repeat(30000));
    expect(() => f.context.capture({ chatId: "123" })).toThrow("context_budget_exceeded");
  });

  test("uses the latest accepted owner source even when its timestamp is backdated", () => {
    const f = setup();
    f.accept("A statement accepted first.", "2026-09-15T19:00:00.000Z");
    f.accept("A delayed update accepted most recently.", "2026-09-12T12:00:00.000Z");
    const latest = f.store.db
      .query<{ id: string }, []>("SELECT id FROM core_telegram_inputs ORDER BY rowid DESC LIMIT 1")
      .get();
    const snapshot = f.context.capture({ chatId: "123" });
    expect(snapshot.latestOwnerMessageId).toBe(latest?.id ?? null);
    expect(
      snapshot.messages.some(
        (message) => message.content === "A delayed update accepted most recently.",
      ),
    ).toBe(true);
    expect(
      snapshot.messages.some((message) =>
        message.content.includes("latest accepted owner message"),
      ),
    ).toBe(true);
  });

  test("includes saved sleep evidence while fresh waking updates outrank the habitual schedule", () => {
    const f = setup();
    f.setTime("2026-09-15T13:00:00.000Z");
    createMemoryService(f.store, { now: f.now }).save({
      tier: "short",
      kind: "preference",
      title: "Fictional usual sleep routine",
      body: "I usually sleep from 05:00 until noon local time.",
    });
    f.accept("Good morning, I woke up early today.", "2026-09-15T12:50:00.000Z");
    f.respond("Morning, Ember. Hope the day is off to a good start.");
    f.accept("I'm awake and making some tea.", "2026-09-15T12:55:00.000Z");
    const snapshot = f.context.capture({ chatId: "123" });
    expect(
      snapshot.memory.retrieved.some((record) => record.body.includes("05:00 until noon")),
    ).toBe(true);
    const content = snapshot.messages.map((message) => message.content).join("\n");
    expect(content).toContain("8:00:00 AM CDT");
    expect(content).toContain("Good morning, I woke up early today.");
    expect(content).toContain("I'm awake and making some tea.");
    expect(content).toContain("fresh waking updates that differ from a usual sleep routine");
    expect(snapshot.prompt.content).toContain("A message can be welcome at any hour.");
    expect(snapshot.prompt.content).toContain("in-character *action*");
  });

  test("includes captions while explicitly omitting images and never loads their bytes", () => {
    const f = setup();
    f.conversations.acceptTelegramBatch({
      nextOffset: 2,
      inputs: [
        {
          updateId: 1,
          messageId: "1",
          chatId: "123",
          senderId: "123",
          text: "My pottery shelf.",
          receivedAt: f.now().toISOString(),
          images: [{ fileId: "private-file-id", fileUniqueId: "private-unique-id" }],
        },
      ],
    });
    const snapshot = f.context.capture({ chatId: "123" });
    const message = snapshot.messages.find((entry) => entry.role === "user");
    expect(message?.content).toContain("My pottery shelf.");
    expect(message?.content).toContain("contents are unavailable");
    expect(JSON.stringify(snapshot)).not.toContain("private-file-id");
    expect(JSON.stringify(snapshot)).not.toContain("private-unique-id");
  });

  test("preserves authored and deliberately empty heartbeat prompts on reconciliation", () => {
    const f = setup();
    expect(f.prompts.get("heartbeat")?.content).toBe(defaultHeartbeatPrompt);
    f.prompts.update("heartbeat", { content: "", expectedVersion: 1 });
    createPromptService(f.store);
    expect(
      f.context
        .capture({ chatId: "123" })
        .prompt.prompts.find((prompt) => prompt.id === "heartbeat")?.content,
    ).toBe("");
    expect(f.prompts.history("heartbeat")).toHaveLength(2);
    expect(f.prompts.compose("telegram-text").versions.heartbeat).toBeUndefined();
  });
});

describe("heartbeat generation", () => {
  test("uses pinned model, full reasoning budget and no tools, returning only the complete selected text", async () => {
    const f = setup();
    f.accept("I finally solved that little puzzle.");
    const text =
      "Your puzzle victory still makes me smile, Ember. Come tell me what you're enjoying when you feel like a little company.";
    const generator = createHeartbeatGenerator({
      store: f.store,
      apiKey: "fictional-secret",
      now: f.now,
      transport: async (_url, request) => {
        const body = JSON.parse(String(request.body));
        expect(body.model).toBe(model.id);
        expect(body.max_tokens).toBe(8192);
        expect(body.reasoning_effort).toBe("medium");
        expect(body.tools).toBeUndefined();
        expect(
          body.messages.some((message: { content: string }) =>
            message.content.includes("Later voice edit"),
          ),
        ).toBe(false);
        return Response.json(
          {
            choices: [
              {
                message: { content: text },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 300,
              completion_tokens: 1500,
              completion_tokens_details: { reasoning_tokens: 1400 },
            },
          },
          { headers: { "x-request-id": "fictional-provider-receipt" } },
        );
      },
    });
    const snapshot = generator.capture({ chatId: "123" });
    expect(snapshot.responseFormat).toBe("text-or-silent-v1");
    expect(snapshot.messages.map((message) => message.content).join("\n")).toContain(
      HEARTBEAT_SILENT_MARKER,
    );
    const before = JSON.stringify(snapshot);
    f.prompts.update("voice", { content: "Later voice edit", expectedVersion: 1 });
    const result = await generator.generate(snapshot, new AbortController().signal);
    expect(result).toMatchObject({
      decision: "speak",
      text,
      completion: {
        requestId: "fictional-provider-receipt",
        usage: { outputTokens: 1500, reasoningTokens: 1400 },
        costUsd: null,
      },
    });
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(
      f.store.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM core_conversation_turns")
        .get()?.count,
    ).toBe(1);
  });

  test("honors explicit silence and retains its actual receipt and unknown cost", () => {
    const f = setup();
    const result = validateHeartbeatCompletion(
      f.context.capture({ chatId: "123" }),
      completion(HEARTBEAT_SILENT_MARKER),
    );
    expect(result).toEqual({
      decision: "silent",
      reason: "model_silence",
      completion: completion(HEARTBEAT_SILENT_MARKER),
    });
    expect(Object.hasOwn(result, "text")).toBe(false);
  });

  test.each([
    '```json\n{"decision":"silent"}\n```',
    "```text\nThinking of you, Ember.\n```",
    'Checking in, Ember. {"decision":"speak","text":"Hi"}',
    'Checking in, Ember.\n{"decision":"speak","text":"Hi"}',
    'Here is the message: ```json {"decision":"silent"}```',
    '{"decision":"speak","text":"Checking in, Ember."}',
    '{"decision":"silent"}',
    '{"decision":"silent","text":"Hello"}',
    '{"decision":"speak","text":"Hi","reason":"extra"}',
    '{"decision":"speak","text":"   "}',
    '{"decision":"speak","text":false}',
    '[{"decision":"silent"}]',
    '"Checking in, Ember."',
    "decision: speak\ntext: Checking in, Ember.",
    "<response>Checking in, Ember.</response>",
    "null",
    "   ",
  ])("rejects malformed or extra output rather than exposing it: %s", (encoded) => {
    const f = setup();
    const raw = completion(encoded);
    const result = validateHeartbeatCompletion(f.context.capture({ chatId: "123" }), raw);
    expect(result).toEqual({ decision: "rejected", reason: "invalid_decision", completion: raw });
  });

  test.each([
    `Checking in, Ember. ${HEARTBEAT_SILENT_MARKER}`,
    `${HEARTBEAT_SILENT_MARKER}\nThinking of you, Ember.`,
    ` ${HEARTBEAT_SILENT_MARKER} `,
    `\`${HEARTBEAT_SILENT_MARKER}\``,
    "[[heartbeat_silent]]",
    "[HEARTBEAT_SILENT]",
    "[[HEARTBEAT_SILEN]]",
    "Checking in. [[HEARTBEATSILENT]]",
    "[[HEARTBEAT",
    "HEARTBEAT_SILENT",
  ])("rejects malformed or embedded private silence markers: %s", (text) => {
    const f = setup();
    const raw = completion(text);
    expect(validateHeartbeatCompletion(f.context.capture({ chatId: "123" }), raw)).toEqual({
      decision: "rejected",
      reason: "invalid_decision",
      completion: raw,
    });
  });

  test("accepts native warmth and actions unchanged without semantic keyword restrictions", () => {
    const f = setup();
    const snapshot = f.context.capture({ chatId: "123" });
    for (const text of [
      "Just a quick hello for your afternoon, Ember. Hope it's going well.",
      "*waves* Rest easy, Ember. A little encouragement for whenever you find it. 💜",
      "I'm still smiling about your decision to give that ceramic frog a tiny hat. It's impossible not to adore him.",
      "A silent movie and a warm cup of tea sound lovely. Come tell me what you picked when you feel like some company.",
    ]) {
      const raw = completion(text);
      expect(validateHeartbeatCompletion(snapshot, raw)).toEqual({
        decision: "speak",
        text,
        completion: raw,
      });
    }
  });

  test("rejects reasoning exhaustion and length endings even when the partial text looks complete", () => {
    const f = setup();
    const raw = completion("Hi, Ember.", {
      finishReason: "length",
      complete: false,
    });
    const result = validateHeartbeatCompletion(f.context.capture({ chatId: "123" }), raw);
    expect(result).toEqual({ decision: "rejected", reason: "incomplete_output", completion: raw });
  });

  test("suppresses overlong messages without chopping or rewriting them", () => {
    const f = setup();
    const snapshot = f.context.capture({ chatId: "123", maxMessageChars: 80 });
    const raw = completion("💜".repeat(41));
    expect(validateHeartbeatCompletion(snapshot, raw)).toEqual({
      decision: "rejected",
      reason: "message_too_long",
      completion: raw,
    });
    const bounded = "💜".repeat(40);
    expect(validateHeartbeatCompletion(snapshot, completion(bounded))).toMatchObject({
      decision: "speak",
      text: bounded,
    });
  });

  test("suppresses repeat heartbeats and confirmed direct replies while allowing ordinary warmth", () => {
    const f = setup();
    f.accept("I made a small bowl.");
    f.respond("Your little bowl turned out beautifully, Ember.");
    const snapshot = f.context.capture({
      chatId: "123",
      recentHeartbeats: [
        { text: "Checking in, Ember. 💜", deliveredAt: "2026-09-15T19:00:00.000Z" },
      ],
    });
    for (const text of ["CHECKING IN EMBER!", "Your little bowl turned out beautifully, Ember."]) {
      expect(validateHeartbeatCompletion(snapshot, completion(text))).toMatchObject({
        decision: "rejected",
        reason: "duplicate_message",
      });
    }
    const text = "Checking in, Ember. Have you picked a glaze for that little bowl?";
    expect(validateHeartbeatCompletion(snapshot, completion(text))).toMatchObject({
      decision: "speak",
      text,
    });
  });

  test("refuses an invalid pinned context before contacting the provider", async () => {
    const f = setup();
    let calls = 0;
    const generator = createHeartbeatGenerator({
      store: f.store,
      apiKey: "fictional-secret",
      now: f.now,
      transport: async () => {
        calls++;
        throw new Error("Unexpected provider request.");
      },
    });
    const snapshot: HeartbeatSnapshot = generator.capture({ chatId: "123" });
    snapshot.settings.contextTokens = 4096;
    await expect(generator.generate(snapshot, new AbortController().signal)).rejects.toMatchObject({
      code: "configuration",
    });
    expect(calls).toBe(0);
  });
});
