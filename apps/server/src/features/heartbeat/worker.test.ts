import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createHeartbeatService,
  type HeartbeatSnapshot,
  openStore,
  type Store,
} from "@valerie/core";
import type { TextCompletion } from "@valerie/inference";
import { TelegramError, type TelegramTransport, type TelegramUpdate } from "../telegram/transport";
import { startTelegramWorker, type TelegramWorker } from "../telegram/worker";
import type { HeartbeatGeneration } from "./generation";

const workers: TelegramWorker[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const store of stores.splice(0)) store.close();
});
const result = (text: string): TextCompletion => ({
  text,
  complete: true,
  finishReason: "stop",
  requestId: "fictional-heartbeat",
  costUsd: null,
  usage: { inputTokens: 20, outputTokens: 12 },
});
const speak = (
  text = "A little warmth for your evening. Come tell me something whenever you feel like it.",
): HeartbeatGeneration => ({
  decision: "speak",
  text,
  completion: result(text),
});
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Fictional worker did not reach the expected state.");
}
function fixture(
  options: {
    generate?: () => Promise<HeartbeatGeneration>;
    send?: TelegramTransport["sendMessage"];
  } = {},
) {
  const store = openStore(":memory:");
  stores.push(store);
  const past = new Date(Date.now() - 2 * 3600000);
  const conversations = createConversationService(store, { now: () => past });
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    model: "fictional-model",
    expectedVersion: settings.version,
  });
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "42",
        senderId: "42",
        text: "I enjoyed making a fictional paper lantern.",
        receivedAt: past.toISOString(),
      },
    ],
  });
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing fixture turn");
  conversations.completeGeneration(turn.id, {
    text: "An earlier substantial reply can remain unanswered.",
  });
  const delivery = conversations.claimDelivery();
  if (!delivery) throw new Error("Missing fixture delivery");
  conversations.recordDelivery(delivery.id, { status: "sent", messageId: "100" });
  const service = createHeartbeatService(store, { random: () => 0 });
  const current = service.getSettings();
  service.saveSettings({
    ...current,
    enabled: true,
    activeStart: "12:00",
    activeEnd: "12:00",
    expectedVersion: current.version,
  });
  const sent: string[] = [];
  let releasePoll: ((updates: TelegramUpdate[]) => void) | undefined;
  const transport: TelegramTransport = {
    inspect: async () => ({ botId: "123", webhookActive: false }),
    getUpdates: () =>
      new Promise((resolve) => {
        releasePoll = resolve;
      }),
    downloadImage: async () => {
      throw new TelegramError("rejected", true);
    },
    sendMessage: async (input) => {
      sent.push(input.text);
      return options.send ? options.send(input) : { messageId: String(200 + sent.length) };
    },
  };
  const worker = startTelegramWorker({
    store,
    token: "123:fictional",
    ownerUserId: "42",
    transport,
    idleMs: 1,
    heartbeatTickMs: 2,
    generate: async () => result("A reply to the new owner message."),
    heartbeats: {
      service,
      capture: () => ({ kind: "heartbeat", settings: { model: "fictional" } }) as HeartbeatSnapshot,
      generate: options.generate ?? (async () => speak()),
    },
  });
  workers.push(worker);
  return {
    store,
    service,
    worker,
    sent,
    due: async () => {
      await until(() => worker.status().heartbeat?.lastTickAt !== null);
      store.db
        .query("UPDATE core_heartbeat_state SET next_opportunity_at=? WHERE singleton=1")
        .run(new Date().toISOString());
    },
    ownerReply: async () => {
      await until(() => !!releasePoll);
      releasePoll?.([
        {
          update_id: 2,
          message: {
            message_id: 2,
            text: "Good morning, I am awake now.",
            from: { id: 42, is_bot: false },
            chat: { id: 42, type: "private" },
          },
        },
      ]);
    },
  };
}

test("a brief heartbeat follows an unanswered regular reply and records a real delivery without inventing owner input", async () => {
  const f = fixture();
  await f.due();
  await until(() => f.service.recentRuns().some((run) => run.status === "delivered"));
  expect(f.sent).toHaveLength(1);
  const run = f.service.recentRuns()[0];
  expect(run?.text).toBe(f.sent[0]);
  expect(run?.telegramMessageId).toBe("201");
  expect(run?.snapshot).toEqual({ kind: "heartbeat", settings: { model: "fictional" } });
  expect(f.store.db.query("SELECT count(*) AS count FROM core_telegram_inputs").get()).toEqual({
    count: 1,
  });
  expect(f.service.getStatus("42").unansweredCount).toBe(1);
});

test("a fresh owner message interrupts heartbeat generation and direct conversation proceeds", async () => {
  let complete: ((value: HeartbeatGeneration) => void) | undefined;
  const f = fixture({
    generate: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  await f.due();
  await until(() => !!complete);
  await f.ownerReply();
  await until(() => f.sent.includes("A reply to the new owner message."));
  complete?.(speak("This stale heartbeat must never be sent."));
  await until(() => f.service.recentRuns()[0]?.status === "suppressed");
  expect(f.sent).toEqual(["A reply to the new owner message."]);
  expect(f.service.recentRuns()[0]?.reason).toBe("owner_input_changed");
});

test("pausing during generation suppresses the prepared text", async () => {
  let complete: ((value: HeartbeatGeneration) => void) | undefined;
  const f = fixture({
    generate: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  await f.due();
  await until(() => !!complete);
  f.service.pause({ expectedVersion: f.service.getSettings().version, pausedUntil: null });
  complete?.(speak());
  await until(() => f.worker.status().heartbeat?.state === "waiting");
  expect(f.sent).toHaveLength(0);
  expect(f.service.recentRuns()[0]?.status).toBe("suppressed");
  expect(f.service.recentRuns()[0]?.reason).toBe("settings_changed");
  expect(f.service.recentRuns()[0]?.result?.requestId).toBe("fictional-heartbeat");
  expect(f.service.recentRuns()[0]?.text).toBeNull();
});

test("an interrupted heartbeat send remains unknown and is not claimed for replay", async () => {
  const f = fixture({ send: () => new Promise(() => {}) });
  await f.due();
  await until(() => f.service.recentRuns()[0]?.status === "sending");
  await f.worker.stop();
  expect(f.service.recentRuns()[0]?.status).toBe("unknown");
  expect(f.sent).toHaveLength(1);
  expect(
    f.store.db
      .query("SELECT count(*) AS count FROM core_conversation_search WHERE id LIKE 'heartbeat:%'")
      .get(),
  ).toEqual({ count: 0 });
});
