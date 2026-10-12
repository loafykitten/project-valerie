import { afterEach, expect, test } from "bun:test";
import type { Store } from "@valerie/core";
import { messageEditFixture } from "../../../../../packages/core/test/message-edit-fixture";
import { createApp } from "../../app";
import { loadConfig } from "../../config";
import {
  createTelegramTransport,
  TelegramError,
  type TelegramTransport,
} from "../telegram/transport";
import { startTelegramWorker } from "../telegram/worker";

const stores: Store[] = [],
  workers: ReturnType<typeof startTelegramWorker>[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop();
  for (const s of stores.splice(0)) s.close();
});
function fixture() {
  const f = messageEditFixture();
  stores.push(f.store);
  return f;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture missing");
  return value;
}
const signal = () => new AbortController().signal;

test("Telegram edit transport verifies target, exact text, and already-matching replies without leaking errors", async () => {
  let calls = 0;
  const transport = createTelegramTransport({
    token: "123:fictional",
    fetch: async (url, init) => {
      calls++;
      expect(url.endsWith("/editMessageText")).toBe(true);
      const request = JSON.parse(String(init.body));
      expect(request).toEqual({ chat_id: "42", message_id: 500, text: "Exact *actions* and 💖" });
      return Response.json({
        ok: true,
        result: { message_id: 500, chat: { id: 42 }, text: request.text },
      });
    },
  });
  const input = {
    chatId: "42",
    messageId: "500",
    text: "Exact *actions* and 💖",
    signal: signal(),
  };
  expect(await transport.editMessageText(input)).toEqual({ messageId: "500", unchanged: false });
  const unchanged = createTelegramTransport({
    token: "123:fictional",
    fetch: async () =>
      Response.json(
        {
          ok: false,
          error_code: 400,
          description:
            "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
        },
        { status: 400 },
      ),
  });
  expect(await unchanged.editMessageText(input)).toEqual({ messageId: "500", unchanged: true });
  for (const result of [
    { message_id: 501, chat: { id: 42 }, text: input.text },
    { message_id: 500, chat: { id: 99 }, text: input.text },
    { message_id: 500, chat: { id: 42 }, text: "Wrong text" },
    true,
  ]) {
    const wrong = createTelegramTransport({
      token: "123:fictional",
      fetch: async () => Response.json({ ok: true, result }),
    });
    await expect(wrong.editMessageText(input)).rejects.toMatchObject({
      code: "invalid_response",
      definitive: false,
    });
  }
  const rejected = createTelegramTransport({
    token: "123:fictional",
    fetch: async () =>
      Response.json(
        { ok: false, error_code: 400, description: "PRIVATE provider failure body" },
        { status: 400 },
      ),
  });
  await expect(rejected.editMessageText(input)).rejects.toMatchObject({
    code: "rejected",
    definitive: true,
  });
  const uncertain = createTelegramTransport({
    token: "123:fictional",
    fetch: async () => {
      throw new Error("https://secret-token");
    },
  });
  await expect(uncertain.editMessageText(input)).rejects.toThrow(
    "Telegram request failed: network.",
  );
  await expect(transport.editMessageText({ ...input, text: "\ud800" })).rejects.toMatchObject({
    code: "configuration",
  });
  expect(calls).toBe(1);
});

test("owner-only edit API observes host, origin, version, delivery and content boundaries", async () => {
  const f = fixture(),
    { turn, ids } = f.deliver(),
    id = required(ids[0]);
  const app = createApp(f.store, loadConfig({}), { TELEGRAM_ALLOWED_USER_ID: "42" });
  const path = `http://localhost:3100/api/conversation/messages/${id}/edits`;
  const body = { id: crypto.randomUUID(), expectedVersion: 1, text: "A dashboard revision" };
  const post = (headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  expect((await post({ Origin: "https://attacker.example" })).status).toBe(403);
  expect((await post({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect(f.store.db.query("SELECT * FROM core_message_edits").all()).toHaveLength(0);
  expect((await post()).status).toBe(202);
  expect((await post()).status).toBe(202);
  const messages = await (
    await app.request(`http://localhost:3100/api/conversation/turns/${turn.id}/messages`)
  ).json();
  expect(messages.messages[0].edit.status).toBe("queued");
  expect(messages.messages[0].text).toBe("Original lavender reply.");
  const other = createApp(f.store, loadConfig({}), { TELEGRAM_ALLOWED_USER_ID: "77" });
  expect(
    (await other.request(`http://localhost:3100/api/conversation/turns/${turn.id}/messages`))
      .status,
  ).toBe(404);
  expect(
    (
      await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      })
    ).status,
  ).toBe(400);
  expect(
    (await app.request("http://localhost:3100/api/conversation/turns?before=bad")).status,
  ).toBe(400);
});

async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Worker did not settle");
    await Bun.sleep(2);
  }
}
test("worker applies edits through its lease, leaves unknown outcomes untouched, and explicitly retries the same text", async () => {
  const f = fixture(),
    { turn, ids } = f.deliver(),
    edit = f.queue(required(ids[0]));
  let attempts = 0,
    sends = 0;
  const transport: TelegramTransport = {
    inspect: async () => ({ botId: "123", webhookActive: false }),
    getUpdates: () => new Promise(() => {}),
    downloadImage: async () => new Uint8Array(),
    sendMessage: async () => {
      sends++;
      return { messageId: "900" };
    },
    editMessageText: async (input) => {
      attempts++;
      expect(input.text).toBe(edit.text);
      if (attempts === 1) throw new TelegramError("network");
      return { messageId: input.messageId, unchanged: true };
    },
  };
  const worker = startTelegramWorker({
    store: f.store,
    token: "123:fictional",
    ownerUserId: "42",
    idleMs: 1,
    transport,
    generate: async () => {
      throw new Error("Must not generate");
    },
  });
  workers.push(worker);
  await until(() => f.edits.messages(turn.id, "42")[0]?.edit?.status === "unknown");
  expect(f.conversation.recentTurns()[0]?.outputText).toBe("Original lavender reply.");
  expect(attempts).toBe(1);
  f.edits.retry(edit.id, "42");
  await until(() => f.edits.messages(turn.id, "42")[0]?.edit?.status === "applied");
  expect(attempts).toBe(2);
  expect(sends).toBe(0);
  expect(f.conversation.recentTurns()[0]?.outputText).toBe(edit.text);
});

test("a locally rejected confirmation records its own failure class, not a network failure", async () => {
  const f = fixture(),
    { turn, ids } = f.deliver();
  f.queue(required(ids[0]));
  const worker = startTelegramWorker({
    store: f.store,
    token: "123:fictional",
    ownerUserId: "42",
    idleMs: 1,
    generate: async () => {
      throw new Error("Must not generate");
    },
    transport: {
      inspect: async () => ({ botId: "123", webhookActive: false }),
      getUpdates: () => new Promise(() => {}),
      downloadImage: async () => new Uint8Array(),
      sendMessage: async () => {
        throw new Error("Must not send");
      },
      editMessageText: async () => ({ messageId: "wrong-receipt", unchanged: false }),
    },
  });
  workers.push(worker);
  await until(() => f.edits.messages(turn.id, "42")[0]?.edit?.status === "unknown");
  expect(f.edits.messages(turn.id, "42")[0]?.edit?.failureCode).toBe("confirmation_not_saved");
  expect(f.conversation.recentTurns()[0]?.outputText).toBe("Original lavender reply.");
  expect(worker.status().state).not.toBe("failed");
});
