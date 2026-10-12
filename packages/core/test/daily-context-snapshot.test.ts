import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createDailyService,
  createHeartbeatContextService,
  createPromptService,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("ordinary snapshots pin daily records and source attribution; heartbeats receive waking continuity without progress checklists", () => {
  const store = openStore(":memory:");
  stores.push(store);
  const now = () => new Date("2026-09-15T18:00:00.000Z");
  const daily = createDailyService(store, { now });
  daily.saveSettings({
    expectedVersion: daily.getSettings().version,
    allowValerieManageWaking: true,
    allowValerieManageProgress: true,
  });
  const wake = daily.recordWakingReport(
    {
      report: "main_wake",
      mode: "current",
      expectedCurrentDayId: null,
      expectedDayVersion: null,
      occurred: { at: now().toISOString(), basis: "exact", timezone: "America/Chicago" },
      summary: "The owner reports waking for her day.",
    },
    { actor: "owner" },
  );
  if (!wake.day) throw new Error("Missing waking day.");
  const behavior = daily.saveBehavior(
    { name: "Fictional practice", unit: "sessions", valueKind: "count" },
    { actor: "owner" },
  );
  const privateSummary = "Unique detailed progress evidence stays outside the ordinary prompt.";
  daily.recordProgressReport(
    {
      behaviorId: behavior.id,
      wakingDayId: wake.day.id,
      mode: "occurrence",
      value: 1,
      occurred: { at: now().toISOString(), basis: "exact", timezone: "America/Chicago" },
      summary: privateSummary,
    },
    { actor: "owner" },
  );
  const conversations = createConversationService(store, { now, dailyTools: true });
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
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "42",
        senderId: "42",
        receivedAt: now().toISOString(),
        text: "Good morning",
        sourceMetadata: {
          version: 1,
          provenance: "forwarded",
          quotedRanges: [],
          replyQuote: null,
          incomplete: false,
        },
      },
    ],
  });
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing conversation turn.");
  const pinned = structuredClone(turn.snapshot);
  expect(turn.snapshot.dailyToolsEnabled).toBe(true);
  expect(turn.snapshot.daily?.permissions).toEqual({ manageWaking: true, manageProgress: true });
  expect(turn.snapshot.prompt.versions["daily-records"]).toBe(1);
  expect(turn.snapshot.inputSources?.[0]?.sourceMetadata?.provenance).toBe("forwarded");
  expect(JSON.stringify(turn.snapshot.messages)).not.toContain(privateSummary);
  expect(turn.snapshot.contextBudget?.requiredUnits).toBe(
    turn.snapshot.messages.reduce(
      (sum, message) => sum + 32 + Buffer.byteLength(message.content as string),
      0,
    ),
  );
  daily.recordWakingReport(
    {
      report: "sleep_plan",
      mode: "current",
      expectedCurrentDayId: wake.day.id,
      expectedDayVersion: wake.day.version,
      occurred: { at: now().toISOString(), basis: "exact", timezone: "America/Chicago" },
      summary: "A changed expected sleep time.",
      expectedSleepAt: "2026-09-16T09:00:00.000Z",
      sleepEstimateBasis: "owner_plan",
    },
    { actor: "owner" },
  );
  const prompts = createPromptService(store);
  prompts.update("daily-records", {
    expectedVersion: 1,
    content: "A changed daily tracking direction.",
  });
  const heartbeat = createHeartbeatContextService(store, { now }).capture({ chatId: "42" });
  expect(heartbeat.daily?.currentDay?.expectedSleepAt).toBe("2026-09-16T09:00:00.000Z");
  expect(heartbeat.daily?.revision).not.toBe(turn.snapshot.daily?.revision);
  expect(heartbeat.daily).not.toHaveProperty("progress");
  expect(heartbeat.daily).not.toHaveProperty("permissions");
  expect(heartbeat.prompt.versions["daily-records"]).toBeUndefined();
  expect(
    heartbeat.messages.some((message) => message.content.includes('"provenance":"forwarded"')),
  ).toBe(true);
  expect(JSON.stringify(heartbeat.messages)).not.toContain(privateSummary);
  expect(heartbeat.contextBudget?.toolReserveUnits).toBe(0);
  conversations.failGeneration(turn.id, { code: "deadline", retryAt: now().toISOString() });
  expect(conversations.startNextTurn()?.snapshot).toEqual(pinned);
});
