import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationService,
  createActivityService,
  createCharacterService,
  createConversationService,
  createImageJobService,
  createMemoryService,
  createPromptService,
  defaultImageGenerationPrompt,
  type InferenceSettings,
  InferenceSettingsConflictError,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(path = ":memory:", imageGeneration = false) {
  const store = openStore(path);
  stores.push(store);
  let clock = new Date("2026-09-13T12:00:00.000Z");
  const prompts = createPromptService(store);
  const conversations = createConversationService(store, {
    prompts,
    now: () => clock,
    imageGeneration,
  });
  const current = conversations.getSettings();
  if (!current.model) {
    conversations.saveSettings({
      ...current,
      model: "fictional-model",
      expectedVersion: current.version,
    });
  }
  return {
    store,
    prompts,
    conversations,
    setTime: (value: string) => {
      clock = new Date(value);
    },
  };
}

function accept(
  conversations: ConversationService,
  id: number,
  text = `Input ${id}`,
  receivedAt?: string,
) {
  return conversations.acceptTelegramBatch({
    nextOffset: id + 1,
    inputs: [
      { updateId: id, messageId: String(id), chatId: "123", senderId: "123", text, receivedAt },
    ],
  });
}

function delivered(conversations: ConversationService, text = "A fictional reply") {
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing test turn.");
  conversations.completeGeneration(turn.id, { text });
  const delivery = conversations.claimDelivery();
  if (!delivery) throw new Error("Missing test delivery.");
  conversations.recordDelivery(delivery.id, { status: "sent", messageId: "999" });
  return turn;
}

function save(conversations: ConversationService, updates: Partial<InferenceSettings>) {
  const current = conversations.getSettings();
  return conversations.saveSettings({ ...current, ...updates, expectedVersion: current.version });
}

function saveToolCapabilities(conversations: ConversationService, tools: boolean) {
  const settings = conversations.getSettings();
  return save(conversations, {
    modelCapabilities: {
      id: settings.model,
      displayName: "Fictional model",
      maxContextTokens: settings.modelContextTokens,
      maxOutputTokens: settings.modelMaxOutputTokens,
      systemRole: true,
      reasoningEffort: false,
      deprecated: false,
      tools,
      reasoning: null,
      pricing: {
        currency: null,
        inputPerMillion: null,
        outputPerMillion: null,
        cachedInputPerMillion: null,
        pricingTbd: true,
      },
    },
  });
}

test("Telegram cursor and message deduplication commit together and survive reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-conversations-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const first = fixture(path);
  expect(accept(first.conversations, 50)).toEqual({ accepted: 1 });
  expect(accept(first.conversations, 50)).toEqual({ accepted: 0 });
  expect(
    first.conversations.acceptTelegramBatch({
      nextOffset: 53,
      inputs: [
        {
          updateId: 52,
          messageId: "50",
          chatId: "123",
          senderId: "123",
          text: "Duplicate message",
        },
      ],
    }),
  ).toEqual({ accepted: 0 });
  expect(() =>
    first.conversations.acceptTelegramBatch({
      nextOffset: 60,
      inputs: [
        { updateId: 61, messageId: "61", chatId: "123", senderId: "123", text: "Invalid batch" },
      ],
    }),
  ).toThrow();
  first.store.close();
  stores.splice(stores.indexOf(first.store), 1);
  const reopened = fixture(path);
  expect(reopened.conversations.cursor()).toBe(53);
  expect(reopened.conversations.recentTurns()).toHaveLength(1);
  expect(reopened.conversations.startNextTurn()?.inputText).toBe("Input 50");
  expect(reopened.conversations.startNextTurn()).toBeNull();
});

test("each turn pins settings, ordered prompts, runtime context and history across retries", () => {
  const { store, prompts, conversations } = fixture();
  accept(conversations, 1, "Earlier question");
  delivered(conversations, "Earlier answer");
  const identity = prompts.get("identity");
  if (!identity) throw new Error("Missing fixture prompt.");
  prompts.update(identity.id, {
    content: "An exact authored line.\n",
    expectedVersion: identity.version,
  });
  accept(conversations, 2, "Continue our topic");
  const first = conversations.startNextTurn();
  if (!first) throw new Error("Missing turn.");
  expect(first.snapshot.messages.map((message) => message.content)).toEqual(
    expect.arrayContaining(["Earlier question", "Earlier answer", "Continue our topic"]),
  );
  expect(first.snapshot.prompt.content).toContain("An exact authored line.\n");
  expect(first.snapshot.messages[1]?.content).toContain("America/Chicago");
  expect(first.snapshot.messages[1]?.content).toContain("No image generation is available.");
  expect(first.snapshot.messages[1]?.content).toContain("No reminder scheduling");
  const original = JSON.stringify(first.snapshot);
  save(conversations, { temperature: 0.8 });
  const updatedPrompt = prompts.get(identity.id);
  if (!updatedPrompt) throw new Error("Missing fixture prompt.");
  prompts.update(identity.id, { content: "New revision", expectedVersion: updatedPrompt.version });
  expect(conversations.recoverInterrupted()).toEqual({ generations: 1, deliveries: 0 });
  const retry = conversations.startNextTurn();
  expect(JSON.stringify(retry?.snapshot)).toBe(original);
  expect(retry?.attempts).toBe(2);
  expect(() =>
    store.db
      .query("UPDATE core_conversation_turns SET snapshot_json = '{}' WHERE id = ?")
      .run(first.id),
  ).toThrow("immutable");
  const settings = conversations.getSettings();
  expect(() =>
    conversations.saveSettings({ ...settings, expectedVersion: settings.version - 1 }),
  ).toThrow(InferenceSettingsConflictError);
  expect(
    store.db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM core_inference_settings_revisions",
      )
      .get()?.count,
  ).toBe(3);
});

test("history is a bounded suffix of whole delivered exchanges with an age window", () => {
  const { conversations, setTime } = fixture();
  save(conversations, { historyHours: 24, historyTokens: 350 });
  setTime("2026-09-10T12:00:00.000Z");
  accept(conversations, 1, "Old question");
  delivered(conversations, "Old answer");
  setTime("2026-09-13T11:00:00.000Z");
  accept(conversations, 2, "Recent one");
  delivered(conversations, "Recent reply one");
  accept(conversations, 3, "Recent two");
  delivered(conversations, "Recent reply two");
  setTime("2026-09-13T12:00:00.000Z");
  accept(conversations, 4, "Current");
  const snapshot = conversations.startNextTurn()?.snapshot;
  expect(snapshot?.history.includedTurns).toBe(1);
  expect(snapshot?.history.truncated).toBe(true);
  expect(snapshot?.history.estimatedTokens).toBeLessThanOrEqual(350);
  expect(snapshot?.messages.filter((message) => message.role !== "system")).toEqual([
    { role: "user", content: "Recent two" },
    { role: "assistant", content: "Recent reply two" },
    { role: "user", content: "Current" },
  ]);
  expect(conversations.recentTurns()).toHaveLength(4);
});

test("dated exchanges preserve a waking day across midnight and pin current time and owner guidance", () => {
  const { store, prompts, conversations, setTime } = fixture();
  const memory = createMemoryService(store);
  const routine = memory.save({
    tier: "core",
    kind: "fact",
    title: "Fictional sleep routine",
    body: "I usually sleep after sunrise and wake in the early afternoon.",
  });
  setTime("2026-09-13T18:00:00.000Z");
  accept(conversations, 1, "I just woke up.");
  delivered(conversations, "Good morning.");
  setTime("2026-09-13T21:30:00.000Z");
  accept(conversations, 2, "I had noodles for my first meal.");
  delivered(conversations, "Glad you ate.");
  setTime("2026-09-14T07:40:00.000Z");
  accept(conversations, 3, "It is still the same day for me.", "2026-09-14T07:39:00.000Z");
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing fictional midnight turn.");
  const snapshot = turn.snapshot;
  expect(snapshot.memory?.core.map((item) => item.id)).toContain(routine.id);
  expect(snapshot.history.includedTurns).toBe(2);
  expect(snapshot.history.truncated).toBe(false);
  const clock = String(snapshot.messages[1]?.content);
  expect(clock).toContain("Monday, September 14, 2026 at 2:40:00 AM CDT");
  expect(clock).toContain("message received: Monday, September 14, 2026 at 2:39:00 AM CDT");
  const timing = snapshot.messages.filter((message) =>
    String(message.content).startsWith("Following exchange timestamps"),
  );
  expect(timing).toHaveLength(2);
  expect(timing[0]?.content).toContain("Sunday, September 13, 2026 at 1:00:00 PM CDT");
  expect(timing[1]?.content).toContain("Sunday, September 13, 2026 at 4:30:00 PM CDT");
  expect(snapshot.messages).toContainEqual({
    role: "user",
    content: "I had noodles for my first meal.",
  });
  const pinned = JSON.stringify(snapshot);
  prompts.update("conversation-context", {
    content: "Updated fictional direction.",
    expectedVersion: 1,
  });
  setTime("2026-09-14T08:00:00.000Z");
  conversations.recoverInterrupted();
  expect(JSON.stringify(conversations.startNextTurn()?.snapshot)).toBe(pinned);
  conversations.failGeneration(turn.id, { code: "fictional_probe" });
  accept(conversations, 4, "Continuing our conversation.");
  expect(conversations.startNextTurn()?.snapshot.prompt.versions["conversation-context"]).toBe(2);
});

test("exchange timestamps distinguish repeated local times across the daylight saving boundary", () => {
  const { conversations, setTime } = fixture();
  setTime("2026-11-01T06:30:00.000Z");
  accept(conversations, 1, "Before the clock changes.");
  delivered(conversations);
  setTime("2026-11-01T07:30:00.000Z");
  accept(conversations, 2, "After the clock changes.");
  const snapshot = conversations.startNextTurn()?.snapshot;
  expect(snapshot?.messages[1]?.content).toContain("1:30:00 AM CST");
  expect(
    snapshot?.messages.find((message) =>
      String(message.content).startsWith("Following exchange timestamps"),
    )?.content,
  ).toContain("1:30:00 AM CDT");
});

test("saved Post-History Instructions follow history and the current user message verbatim", () => {
  const { store, conversations } = fixture();
  const postHistory = "Keep this exact instruction.\r\n  Authored spacing.\n";
  createCharacterService(store).import(
    new Uint8Array(
      Buffer.from(
        JSON.stringify({
          name: "Fictional character",
          description: "A fictional companion.",
          post_history_instructions: postHistory,
        }),
      ),
    ),
    { sourceFilename: "fictional.json", expectedActiveImportId: null },
  );
  accept(conversations, 1, "An earlier question");
  delivered(conversations, "An earlier response");
  accept(conversations, 2, "The current question");
  const snapshot = conversations.startNextTurn()?.snapshot;
  if (!snapshot) throw new Error("Missing fixture snapshot.");
  expect(snapshot?.messages.at(-2)).toEqual({ role: "user", content: "The current question" });
  expect(snapshot?.messages.at(-1)).toEqual({
    role: "system",
    content: snapshot?.prompt.postHistoryContent,
  });
  expect(snapshot?.messages.at(-1)?.content).toContain(postHistory);
  expect(snapshot?.prompt.content).not.toContain(postHistory);
});

test("settings changes between database connections affect only the next snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-conversation-snapshot-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const first = fixture(path);
  accept(first.conversations, 1);
  const second = fixture(path);
  const saved = save(second.conversations, { temperature: 0.4 });
  const turn = first.conversations.startNextTurn();
  expect(turn?.snapshot.settings.version).toBe(saved.version);
  save(second.conversations, { temperature: 0.9 });
  expect(turn?.snapshot.settings.temperature).toBe(0.4);
  expect(first.conversations.getSettings().temperature).toBe(0.9);
});

test("history keeps a large recent topic within budget and leaves archived exchanges intact", () => {
  const { conversations } = fixture();
  const input = "A".repeat(3000);
  const output = "B".repeat(3000);
  for (let id = 1; id <= 16; id++) {
    accept(conversations, id, input);
    delivered(conversations, output);
  }
  accept(conversations, 17, "Continue the day-long topic");
  const next = conversations.startNextTurn();
  expect(next?.snapshot.history.includedTurns).toBe(15);
  const timingBytes =
    next?.snapshot.messages
      .filter((message) => String(message.content).startsWith("Following exchange timestamps"))
      .reduce((sum, message) => sum + Buffer.byteLength(String(message.content)) + 16, 0) ?? 0;
  expect(timingBytes).toBeGreaterThan(0);
  expect(next?.snapshot.history.estimatedTokens).toBe(90480 + timingBytes);
  expect(next?.snapshot.history.estimatedTokens).toBeLessThanOrEqual(
    next?.snapshot.history.budgetTokens ?? 0,
  );
  expect(conversations.recentTurns()).toHaveLength(17);
});

test("unknown Telegram deliveries are never replayed or included as if delivered", () => {
  const { store, conversations } = fixture();
  accept(conversations, 1);
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing turn.");
  conversations.completeGeneration(turn.id, { text: "First second", chunks: ["First ", "second"] });
  const first = conversations.claimDelivery();
  if (!first) throw new Error("Missing delivery.");
  expect(conversations.claimDelivery()).toBeNull();
  expect(conversations.startNextTurn()).toBeNull();
  expect(conversations.recoverInterrupted()).toEqual({ generations: 0, deliveries: 1 });
  expect(conversations.claimDelivery()).toBeNull();
  expect(conversations.recoverInterrupted()).toEqual({ generations: 0, deliveries: 0 });
  expect(conversations.recentTurns()[0]?.status).toBe("unknown");
  expect(
    store.db
      .query<{ status: string }, []>(
        "SELECT status FROM core_conversation_outbox ORDER BY sequence",
      )
      .all()
      .map((row) => row.status),
  ).toEqual(["unknown", "cancelled"]);
  accept(conversations, 2);
  expect(conversations.startNextTurn()?.snapshot.history.includedTurns).toBe(0);
  expect(createActivityService(store).list({ query: "restart" })[0]?.status).toBe("failed");
});

test("a failed or uncertain reply preserves older confirmed topic context without inventing delivery", () => {
  const { conversations } = fixture();
  accept(conversations, 1, "Our ongoing topic");
  delivered(conversations, "A confirmed answer");
  accept(conversations, 2, "A followup that failed");
  const failed = conversations.startNextTurn();
  if (!failed) throw new Error("Missing turn.");
  conversations.failGeneration(failed.id, { code: "provider" });
  accept(conversations, 3, "Another followup");
  const uncertain = conversations.startNextTurn();
  if (!uncertain) throw new Error("Missing turn.");
  conversations.completeGeneration(uncertain.id, { text: "Unconfirmed output" });
  const delivery = conversations.claimDelivery();
  if (!delivery) throw new Error("Missing delivery.");
  conversations.recordDelivery(delivery.id, { status: "unknown", code: "network" });
  accept(conversations, 4, "Continue our topic");
  const snapshot = conversations.startNextTurn()?.snapshot;
  expect(snapshot?.history.includedTurns).toBe(1);
  expect(snapshot?.history.truncated).toBe(true);
  expect(snapshot?.messages.filter((message) => message.role !== "system")).toEqual([
    { role: "user", content: "Our ongoing topic" },
    { role: "assistant", content: "A confirmed answer" },
    { role: "user", content: "Continue our topic" },
  ]);
});

test("incomplete provider results retain factual usage and private output across manual retry", () => {
  const { store, conversations } = fixture();
  accept(conversations, 1);
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing turn.");
  conversations.failGeneration(turn.id, {
    code: "incomplete_response",
    result: {
      text: "PRIVATE_PARTIAL_OUTPUT",
      finishReason: "length",
      requestId: "req/test",
      costUsd: 0.001,
      usage: { inputTokens: 23, outputTokens: 200, cachedInputTokens: null, reasoningTokens: 195 },
    },
  });
  expect(conversations.claimDelivery()).toBeNull();
  expect(conversations.recentTurns()[0]).toMatchObject({
    status: "failed",
    outputText: "PRIVATE_PARTIAL_OUTPUT",
    canRetry: true,
    nextAttemptAt: null,
  });
  const activity = createActivityService(store).list({ query: "generation failed" })[0];
  expect(activity?.metadataJson).toContain('"outputTokens":200');
  expect(activity?.metadataJson).not.toContain("PRIVATE_PARTIAL_OUTPUT");
  conversations.retryTurn(turn.id);
  expect(conversations.recentTurns()[0]?.canRetry).toBe(false);
  delivered(conversations, "A completed response");
  expect(
    store.db
      .query<{ text: string }, [string]>(
        "SELECT output_text AS text FROM core_conversation_results WHERE turn_id = ? ORDER BY rowid",
      )
      .all(turn.id)
      .map((row) => row.text),
  ).toEqual(["PRIVATE_PARTIAL_OUTPUT", "A completed response"]);
});

test("delivery retries serialize chunks and only complete the turn after all receipts", () => {
  const { conversations, setTime } = fixture();
  accept(conversations, 1);
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing turn.");
  conversations.completeGeneration(turn.id, { text: "one two", chunks: ["one ", "two"] });
  const first = conversations.claimDelivery();
  if (!first) throw new Error("Missing delivery.");
  conversations.recordDelivery(first.id, {
    status: "retry",
    code: "rate_limited",
    retryAt: "2026-09-13T12:00:02.000Z",
  });
  expect(conversations.claimDelivery()).toBeNull();
  expect(conversations.recentTurns()[0]).toMatchObject({
    canRetry: false,
    nextAttemptAt: "2026-09-13T12:00:02.000Z",
  });
  setTime("2026-09-13T12:00:03.000Z");
  const retry = conversations.claimDelivery();
  expect(retry?.id).toBe(first.id);
  expect(retry?.attempts).toBe(2);
  conversations.recordDelivery(first.id, { status: "sent", messageId: "1001" });
  expect(conversations.recentTurns()[0]?.status).toBe("generated");
  const second = conversations.claimDelivery();
  if (!second) throw new Error("Missing second delivery.");
  expect(second.sequence).toBe(1);
  conversations.recordDelivery(second.id, { status: "sent", messageId: "1002" });
  expect(conversations.recentTurns()[0]?.status).toBe("delivered");
  expect(conversations.recentTurns()[0]?.nextAttemptAt).toBeNull();
  expect(() =>
    conversations.recordDelivery(second.id, { status: "sent", messageId: "1002" }),
  ).toThrow();
});

test("generation retry waits until due; manual retry rejects old or delivered-intent turns", () => {
  const { conversations, setTime } = fixture();
  accept(conversations, 1);
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing turn.");
  conversations.failGeneration(turn.id, { code: "provider", retryAt: "2026-09-13T12:00:02.000Z" });
  expect(conversations.recentTurns()[0]).toMatchObject({
    canRetry: false,
    nextAttemptAt: "2026-09-13T12:00:02.000Z",
  });
  expect(conversations.startNextTurn()).toBeNull();
  setTime("2026-09-13T12:00:03.000Z");
  expect(conversations.startNextTurn()?.attempts).toBe(2);
  conversations.failGeneration(turn.id, { code: "provider" });
  conversations.retryTurn(turn.id);
  expect(conversations.startNextTurn()?.id).toBe(turn.id);
  conversations.failGeneration(turn.id, { code: "provider" });
  expect(conversations.recentTurns()[0]).toMatchObject({ canRetry: true, nextAttemptAt: null });
  accept(conversations, 2);
  expect(conversations.recentTurns().find((summary) => summary.id === turn.id)?.canRetry).toBe(
    false,
  );
  expect(() => conversations.retryTurn(turn.id)).toThrow("newer");
});

test("a failed delivery cannot be offered as a manual generation retry", () => {
  const { conversations } = fixture();
  accept(conversations, 1);
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing turn.");
  conversations.completeGeneration(turn.id, { text: "A generated reply" });
  const delivery = conversations.claimDelivery();
  if (!delivery) throw new Error("Missing delivery.");
  conversations.recordDelivery(delivery.id, { status: "failed", code: "rejected" });
  expect(conversations.recentTurns()[0]).toMatchObject({
    status: "failed",
    canRetry: false,
    nextAttemptAt: null,
  });
  expect(() => conversations.retryTurn(turn.id)).toThrow("delivery attempt");
});

test("oversized saved prompts fail visibly without sending or dropping archived input", () => {
  const { conversations, prompts } = fixture();
  save(conversations, { contextTokens: 8192, maxOutputTokens: 1024 });
  const identity = prompts.get("identity");
  if (!identity) throw new Error("Missing prompt.");
  prompts.update(identity.id, { content: "X".repeat(8192), expectedVersion: identity.version });
  accept(conversations, 1, "Please answer");
  expect(conversations.startNextTurn()).toBeNull();
  expect(conversations.recentTurns()[0]).toMatchObject({
    status: "failed",
    failureCode: "context_budget_exceeded",
    inputText: "Please answer",
    settingsVersion: null,
  });
  expect(conversations.claimDelivery()).toBeNull();
});

test("a persistent bot identity and expiring owner lease prevent a second poller", () => {
  const { conversations, setTime } = fixture();
  conversations.bindTelegramBot("555");
  conversations.bindTelegramBot("555");
  expect(() => conversations.bindTelegramBot("556")).toThrow("identity changed");
  expect(conversations.acquireTelegramLease("first", "2026-09-13T12:01:00.000Z")).toBe(true);
  expect(conversations.acquireTelegramLease("second", "2026-09-13T12:01:00.000Z")).toBe(false);
  conversations.releaseTelegramLease("second");
  expect(conversations.renewTelegramLease("first", "2026-09-13T12:01:30.000Z")).toBe(true);
  setTime("2026-09-13T12:02:00.000Z");
  expect(conversations.renewTelegramLease("first", "2026-09-13T12:03:00.000Z")).toBe(false);
  expect(conversations.acquireTelegramLease("second", "2026-09-13T12:03:00.000Z")).toBe(true);
});

test("the default service accepts durable inputs but waits for a selected model", () => {
  const store = openStore(":memory:");
  stores.push(store);
  const conversations = createConversationService(store);
  accept(conversations, 1);
  expect(conversations.getSettings().model).toBe("");
  expect(conversations.startNextTurn()).toBeNull();
  expect(conversations.recentTurns()[0]?.status).toBe("queued");
});

test.each([
  { configured: false, tools: true, enabled: false },
  { configured: true, tools: false, enabled: false },
  { configured: true, tools: true, enabled: true },
])(
  "image generation snapshot requires both configuration and verified tools: %j",
  ({ configured, tools, enabled }) => {
    const { conversations } = fixture(":memory:", configured);
    saveToolCapabilities(conversations, tools);
    accept(conversations, 1);
    const turn = conversations.startNextTurn();
    expect(turn?.snapshot.imageGenerationEnabled).toBe(enabled);
    if (enabled) {
      expect(turn?.snapshot.messages[1]?.content).toContain(
        "generated and delivered asynchronously",
      );
      expect(turn?.snapshot.prompt.versions["image-generation"]).toBe(1);
      expect(turn?.snapshot.messages[0]?.content).toContain(defaultImageGenerationPrompt);
    } else {
      expect(turn?.snapshot.messages[1]?.content).toContain("No image generation is available.");
      expect(turn?.snapshot.prompt.versions["image-generation"]).toBeUndefined();
      expect(turn?.snapshot.messages[0]?.content).not.toContain(defaultImageGenerationPrompt);
    }
    if (!turn) throw new Error("Missing fixture turn.");
    const capabilities = conversations.getSettings().modelCapabilities;
    if (!capabilities) throw new Error("Missing fixture capabilities.");
    save(conversations, { modelCapabilities: { ...capabilities, tools: !tools } });
    conversations.recoverInterrupted();
    expect(conversations.startNextTurn()?.snapshot).toEqual(turn.snapshot);
  },
);

test("image direction revisions apply to the next turn while interrupted turns retain their complete snapshot", () => {
  const { prompts, conversations } = fixture(":memory:", true);
  saveToolCapabilities(conversations, true);
  prompts.update("image-generation", {
    content: "Original fictional picture direction.",
    expectedVersion: 1,
  });
  accept(conversations, 1, "Please send a selfie.");
  const first = conversations.startNextTurn();
  if (!first) throw new Error("Missing image turn.");
  expect(first.snapshot.prompt.versions["image-generation"]).toBe(2);
  expect(first.snapshot.messages[0]?.content).toContain("Original fictional picture direction.");
  const pinned = JSON.stringify(first.snapshot);
  prompts.update("image-generation", {
    content: "Updated fictional picture direction.",
    expectedVersion: 2,
  });
  conversations.recoverInterrupted();
  expect(JSON.stringify(conversations.startNextTurn()?.snapshot)).toBe(pinned);
  conversations.failGeneration(first.id, { code: "provider" });
  accept(conversations, 2, "Please try another picture.");
  const next = conversations.startNextTurn();
  if (!next) throw new Error("Missing next image turn.");
  expect(next.snapshot.prompt.versions["image-generation"]).toBe(3);
  expect(next.snapshot.messages[0]?.content).toContain("Updated fictional picture direction.");
  expect(next.snapshot.messages[0]?.content).not.toContain("Original fictional picture direction.");
  expect(JSON.stringify(first.snapshot)).toBe(pinned);
});

test("image direction consumes the pinned context budget and an oversized edit fails before inference", () => {
  const { prompts, conversations } = fixture(":memory:", true);
  saveToolCapabilities(conversations, true);
  save(conversations, { contextTokens: 8192, maxOutputTokens: 1024 });
  prompts.update("image-generation", { content: "X".repeat(8192), expectedVersion: 1 });
  accept(conversations, 1, "Please send a selfie.");
  expect(conversations.startNextTurn()).toBeNull();
  expect(conversations.recentTurns()[0]).toMatchObject({
    status: "failed",
    failureCode: "context_budget_exceeded",
    inputText: "Please send a selfie.",
  });
  expect(conversations.claimDelivery()).toBeNull();
});

test("image outcomes capture pending and receipt-backed sent facts immutably in their originating chat", () => {
  const { store, conversations } = fixture();
  const jobs = createImageJobService(store);
  accept(conversations, 1, "Please send a picture.");
  const first = conversations.startNextTurn();
  if (!first) throw new Error("Missing image turn.");
  const job = jobs.enqueue({
    turnId: first.id,
    toolCallId: "call-fictional",
    framing: "selfie",
    sceneTags: ["blue sweater"],
    prompt: "fictional adult character, blue sweater",
    workflow: { fictional: true },
    seed: 123,
  });
  conversations.completeGeneration(first.id, { text: "Give me a moment." });
  const acknowledgement = conversations.claimDelivery();
  if (!acknowledgement) throw new Error("Missing image acknowledgement.");
  conversations.recordDelivery(acknowledgement.id, { status: "sent", messageId: "333" });
  accept(conversations, 2, "How is it going?");
  const second = conversations.startNextTurn();
  if (!second) throw new Error("Missing followup turn.");
  const outcomes = (snapshot: typeof first.snapshot) =>
    snapshot.messages
      .filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.startsWith("Recent character image outcomes"),
      )
      .map((message) => message.content)
      .join("\n");
  expect(outcomes(second.snapshot)).toContain('"status":"queued"');
  expect(outcomes(second.snapshot)).toContain("Only sent means Telegram confirmed photo delivery.");
  const snapshotJson = JSON.stringify(second.snapshot);
  jobs.claimRender();
  jobs.saveImage(
    job.id,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  jobs.claimDelivery();
  jobs.recordDelivery(job.id, { status: "sent", messageId: "334" });
  expect(JSON.stringify(second.snapshot)).toBe(snapshotJson);
  conversations.failGeneration(second.id, { code: "provider" });
  accept(conversations, 3, "Did it finish?");
  const third = conversations.startNextTurn();
  if (!third) throw new Error("Missing completion followup.");
  expect(outcomes(third.snapshot)).toContain('"status":"sent"');
  expect(outcomes(third.snapshot)).not.toContain('"deliveredAt":null');
  conversations.failGeneration(third.id, { code: "provider" });
  conversations.acceptTelegramBatch({
    nextOffset: 5,
    inputs: [
      { updateId: 4, messageId: "4", chatId: "456", senderId: "456", text: "Separate chat." },
    ],
  });
  const separate = conversations.startNextTurn();
  if (!separate) throw new Error("Missing separate chat turn.");
  expect(outcomes(separate.snapshot)).toBe("");
});
