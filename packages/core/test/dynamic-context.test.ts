import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createDynamicService,
  createHeartbeatContextService,
  createPromptService,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("focus snapshots pin compact context and prompt revisions without routinely sending progress notes", () => {
  const store = openStore(":memory:");
  stores.push(store);
  const now = () => new Date("2026-09-15T18:00:00.000Z");
  const conversations = createConversationService(store, {
    now,
    memoryTools: true,
    dynamicTools: true,
  });
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    model: "fictional",
    modelCapabilities: {
      id: "fictional",
      displayName: "Fictional",
      systemRole: true,
      tools: true,
      reasoningEffort: false,
      deprecated: false,
      reasoning: null,
      maxContextTokens: settings.modelContextTokens,
      maxOutputTokens: settings.modelMaxOutputTokens,
      pricing: {
        currency: null,
        inputPerMillion: null,
        outputPerMillion: null,
        cachedInputPerMillion: null,
        pricingTbd: true,
      },
    },
  });
  const dynamic = createDynamicService(store, { now });
  const focus = dynamic.saveFocus(
    {
      title: "Creative enjoyment",
      reason: "Make room for a pleasant practice.",
      startDate: "2026-09-15",
      reviewDate: "2026-10-27",
      practices: ["Try a little sketch."],
      indicators: [],
    },
    { actor: "owner" },
  );
  dynamic.addNote(
    {
      focusId: focus.id,
      expectedFocusVersion: focus.version,
      body: "A unique detailed progress note stays available by retrieval.",
      kind: "owner_report",
    },
    { actor: "owner" },
  );
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "42",
        senderId: "42",
        text: "I enjoyed a game today.",
        receivedAt: now().toISOString(),
      },
    ],
  });
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Expected test turn.");
  expect(turn.snapshot.dynamicToolsEnabled).toBe(true);
  expect(turn.snapshot.dynamic?.focus?.title).toBe("Creative enjoyment");
  expect(turn.snapshot.prompt.versions["growth-focus"]).toBe(1);
  expect(JSON.stringify(turn.snapshot.messages)).not.toContain("unique detailed progress note");
  const prompt = createPromptService(store);
  prompt.update("growth-focus", {
    expectedVersion: 1,
    content: "An owner-edited focus direction.",
  });
  dynamic.setFocusState(
    { id: focus.id, expectedVersion: focus.version, state: "paused" },
    { actor: "owner" },
  );
  const heartbeat = createHeartbeatContextService(store, { now }).capture({ chatId: "42" });
  expect(heartbeat.dynamic?.focus?.phase).toBe("paused");
  expect(heartbeat.prompt.versions["growth-focus"]).toBe(2);
  expect(
    heartbeat.messages.some((message) => message.content.includes("Do not press its practices")),
  ).toBe(true);
  expect(turn.snapshot.dynamic?.focus?.phase).toBe("active");
  expect(turn.snapshot.prompt.versions["growth-focus"]).toBe(1);
  expect(turn.snapshot.contextBudget?.toolReserveUnits).toBeGreaterThan(0);
  expect(heartbeat.contextBudget?.toolReserveUnits).toBe(0);
  expect(prompt.compose("telegram-text").versions["growth-focus"]).toBeUndefined();
});
