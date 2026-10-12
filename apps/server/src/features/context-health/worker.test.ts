import { afterEach, describe, expect, test } from "bun:test";
import {
  createContextHealthService,
  createContextNoticeService,
  createConversationService,
  openStore,
  type Store,
} from "@valerie/core";
import { type ChatMessage, InferenceError, type TextCompletion } from "@valerie/inference";
import { TelegramError, type TelegramTransport } from "../telegram/transport";
import { startTelegramWorker, type TelegramWorker } from "../telegram/worker";
import { runConversationTools } from "../tools/loop";
import type { RegisteredTool } from "../tools/registry";
import { measureCompletion } from "./measure";

const stores: Store[] = [];
const workers: TelegramWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  // Keep test acceptance deterministic even when input and migration share one millisecond.
  store.db
    .query("UPDATE core_migrations SET applied_at=? WHERE id='015-context-notices'")
    .run(new Date(Date.now() - 1000).toISOString());
  const conversation = createConversationService(store);
  const settings = conversation.getSettings();
  conversation.saveSettings({ ...settings, expectedVersion: settings.version, model: "fictional" });
  return {
    store,
    conversation,
    health: createContextHealthService(store),
    notices: createContextNoticeService(store),
  };
}

function accept(conversation: ReturnType<typeof createConversationService>, id = 1) {
  conversation.acceptTelegramBatch({
    nextOffset: id + 1,
    inputs: [
      {
        updateId: id,
        messageId: String(id),
        chatId: "42",
        senderId: "42",
        text: "A fictional check-in.",
      },
    ],
  });
}

function completion(patch: Partial<TextCompletion> = {}): TextCompletion {
  return {
    text: "A fictional reply.",
    finishReason: "stop",
    complete: true,
    requestId: "fictional-receipt",
    usage: { inputTokens: 100, outputTokens: 10 },
    costUsd: null,
    ...patch,
  };
}

function transport(overrides: Partial<TelegramTransport> = {}): TelegramTransport {
  return {
    inspect: async () => ({ botId: "123", webhookActive: false }),
    getUpdates: () => new Promise(() => {}),
    downloadImage: async () => {
      throw new TelegramError("rejected", true);
    },
    sendMessage: async () => ({ messageId: "500" }),
    ...overrides,
  };
}

function start(store: Store, adapter: TelegramTransport) {
  const worker = startTelegramWorker({
    store,
    token: "123:fictional",
    ownerUserId: "42",
    contextNotices: true,
    idleMs: 1,
    retryBaseMs: 1,
    transport: adapter,
    generate: async () => completion({ finishReason: "length", complete: false }),
  });
  workers.push(worker);
  return worker;
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Expected context notice outcome did not occur.");
    await Bun.sleep(1);
  }
}

function heartbeat(store: Store, id: string, status: "failed" | "suppressed", reason: string) {
  const now = new Date().toISOString();
  store.db
    .query(`INSERT INTO core_heartbeat_runs(
    id,chat_id,status,fence,lease_owner,settings_json,input_watermark,waking_day,reason,created_at,updated_at
  ) VALUES(?,'42',?,?,'worker','{}',0,'2026-09-15',?,?,?)`)
    .run(id, status, `${id}-fence`, reason, now, now);
}

describe("context notices in the actual worker send loop", () => {
  test("definitive throttling retries the same notice and preserves a Telegram receipt", async () => {
    const f = setup();
    accept(f.conversation);
    const sent: string[] = [];
    start(
      f.store,
      transport({
        sendMessage: async ({ text }) => {
          sent.push(text);
          if (sent.length === 1) throw new TelegramError("rate_limited", true, 0);
          return { messageId: "501" };
        },
      }),
    );
    await until(() => f.notices.list()[0]?.status === "sent");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(sent[0]).toContain("completion allowance");
    expect(f.notices.list()[0]?.attempts).toBe(2);
    expect(f.notices.list()[0]?.telegramMessageId).toBe("501");
    expect(f.store.db.query("SELECT id FROM core_heartbeat_runs").all()).toHaveLength(0);
  });

  test("ambiguous notice sends remain unknown across worker restart", async () => {
    const f = setup();
    accept(f.conversation);
    let sends = 0;
    const first = start(
      f.store,
      transport({
        sendMessage: async () => {
          sends++;
          throw new TelegramError("network");
        },
      }),
    );
    await until(() => f.notices.list()[0]?.status === "unknown");
    await first.stop();
    let polled = false;
    start(
      f.store,
      transport({
        getUpdates: () => {
          polled = true;
          return new Promise(() => {});
        },
        sendMessage: async () => {
          sends++;
          return { messageId: "unexpected" };
        },
      }),
    );
    await until(() => polled);
    expect(f.notices.list()[0]?.status).toBe("unknown");
    expect(f.notices.claim("42", "outsider")).toBeNull();
    expect(sends).toBe(1);
  });

  test("shutdown during an unresponsive notice send does not block or authorize a resend", async () => {
    const f = setup();
    accept(f.conversation);
    let resolveSend: ((value: { messageId: string }) => void) | undefined;
    let sends = 0;
    const worker = start(
      f.store,
      transport({
        sendMessage: () => {
          sends++;
          return new Promise((resolve) => {
            resolveSend = resolve;
          });
        },
      }),
    );
    await until(() => f.notices.list()[0]?.status === "sending");
    await worker.stop();
    expect(f.notices.list()[0]?.status).toBe("unknown");
    resolveSend?.({ messageId: "late-receipt" });
    await Promise.resolve();
    let polled = false;
    start(
      f.store,
      transport({
        getUpdates: () => {
          polled = true;
          return new Promise(() => {});
        },
        sendMessage: async () => {
          sends++;
          return { messageId: "502" };
        },
      }),
    );
    await until(() => polled);
    expect(sends).toBe(1);
    expect(f.notices.list()[0]?.status).toBe("unknown");
  });
});

describe("context notice evidence changes", () => {
  test("a heartbeat capture failure without a snapshot still creates a capacity notice", () => {
    const f = setup();
    heartbeat(f.store, "capture-failed", "failed", "context_budget_exceeded");
    expect(f.notices.reconcile("42")).toBe(1);
    expect(f.notices.list()[0]?.sourceId).toBe("capture-failed");
    expect(f.notices.list()[0]?.text).toContain("could not fit");
  });

  test("a late request receipt revisits a previously observed suppressed heartbeat once", () => {
    const f = setup();
    heartbeat(f.store, "late", "suppressed", "owner_input_changed");
    expect(f.notices.reconcile("42")).toBe(1);
    expect(f.notices.list()).toHaveLength(0);
    expect(f.notices.reconcile("42")).toBe(0);
    f.health.recordRequest({
      kind: "heartbeat",
      sourceId: "late",
      attempt: 1,
      startedAt: new Date().toISOString(),
      elapsedMs: 75,
      requestId: "late-provider-receipt",
      finishReason: "length",
      failureCode: null,
      usage: { inputTokens: 100, outputTokens: 2048 },
      estimates: { estimator: "utf8-byte-upper-bound", messageUnits: 300, toolSchemaUnits: 0 },
    });
    expect(f.notices.reconcile("42")).toBe(1);
    expect(f.notices.list()[0]?.category).toBe("output");
    expect(f.notices.reconcile("42")).toBe(0);
    expect(f.notices.list()).toHaveLength(1);
  });

  test("completion allowance recovery is independent of a separate input-pressure episode", () => {
    const f = setup();
    accept(f.conversation);
    const first = f.conversation.startNextTurn();
    if (!first) throw new Error("Missing first turn.");
    f.conversation.failGeneration(first.id, {
      code: "incomplete_response",
      result: completion({ finishReason: "length", complete: false }),
    });
    f.notices.reconcile("42");
    expect(f.notices.list()[0]?.category).toBe("output");
    accept(f.conversation, 2);
    const second = f.conversation.startNextTurn();
    if (!second) throw new Error("Missing second turn.");
    // A complete response can still have encountered a bounded tool continuation.
    f.store.db
      .query(
        "INSERT INTO core_activity(id,kind,summary,status,created_at,metadata_json) VALUES('tool-capacity','context.tool_budget','Capacity test.','failed',?,?)",
      )
      .run(new Date().toISOString(), JSON.stringify({ turnId: second.id }));
    f.conversation.completeGeneration(second.id, completion());
    f.notices.reconcile("42");
    expect(f.notices.list().find((notice) => notice.category === "output")?.status).toBe(
      "cancelled",
    );
    expect(f.notices.list().find((notice) => notice.category === "context")?.status).toBe(
      "pending",
    );
  });

  test("a successful manual retry does not reopen output pressure from the source's older request", () => {
    const f = setup();
    accept(f.conversation);
    const first = f.conversation.startNextTurn();
    if (!first) throw new Error("Missing first turn.");
    const recorded = (finishReason: "stop" | "length") =>
      f.health.recordRequest({
        kind: "conversation",
        sourceId: first.id,
        attempt: 1,
        startedAt: new Date().toISOString(),
        elapsedMs: 5,
        requestId: `manual-${finishReason}`,
        finishReason,
        failureCode: null,
        usage: { inputTokens: 100, outputTokens: finishReason === "length" ? 2048 : 20 },
        estimates: { estimator: "utf8-byte-upper-bound", messageUnits: 300, toolSchemaUnits: 0 },
      });
    recorded("length");
    f.conversation.failGeneration(first.id, {
      code: "incomplete_response",
      result: completion({ finishReason: "length", complete: false }),
    });
    f.notices.reconcile("42");
    expect(f.notices.list()[0]?.status).toBe("pending");
    f.conversation.retryTurn(first.id);
    const retried = f.conversation.startNextTurn();
    expect(retried?.attempts).toBe(1);
    recorded("stop");
    f.conversation.completeGeneration(first.id, completion());
    f.notices.reconcile("42");
    expect(f.health.getSource("conversation", first.id)?.signals).toContain(
      "output_budget_exhausted",
    );
    expect(f.notices.list()).toHaveLength(1);
    expect(f.notices.list()[0]?.status).toBe("cancelled");
  });
});

describe("provider invocation measurement", () => {
  test("journal replay avoids both tool reexecution and a second receipt for the original call", async () => {
    const f = setup();
    accept(f.conversation);
    const turn = f.conversation.startNextTurn();
    if (!turn) throw new Error("Missing turn.");
    let calls = 0;
    let executions = 0;
    const tool: RegisteredTool = {
      name: "fictional_lookup",
      description: "Read a fictional fixture.",
      effect: "read",
      allowedTurnKinds: ["user"],
      timeoutMs: 100,
      maxOutputBytes: 256,
      parameters: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { found: { type: "boolean" } },
        required: ["found"],
      },
      execute: () => {
        executions++;
        return { found: true };
      },
    };
    const run = (attempt: number) => {
      const measure = measureCompletion(f.store, {
        kind: "conversation",
        sourceId: turn.id,
        attempt,
      });
      const messages: ChatMessage[] = [{ role: "user", content: "A fictional lookup." }];
      return runConversationTools({
        store: f.store,
        turnId: turn.id,
        messages,
        signal: new AbortController().signal,
        tools: [tool],
        contextTokens: 32000,
        maxOutputTokens: 1024,
        complete: (current, definitions) =>
          measure(current, definitions, async () => {
            calls++;
            if (calls === 1)
              return completion({
                text: "",
                finishReason: "tool_calls",
                complete: false,
                requestId: "first-tool",
                toolCalls: [{ id: "first-call", name: "fictional_lookup", arguments: "{}" }],
              });
            if (calls === 2) throw new InferenceError("deadline", true);
            return completion({
              requestId: "new-final",
              usage: { inputTokens: 200, outputTokens: 20 },
            });
          }),
      });
    };
    await expect(run(1)).rejects.toBeInstanceOf(InferenceError);
    expect((await run(2)).usage.inputTokens).toBe(300);
    const report = f.health.getSource("conversation", turn.id);
    expect(calls).toBe(3);
    expect(executions).toBe(1);
    expect(report?.requests).toHaveLength(3);
    expect(report?.requests.map((request) => request.requestId)).toEqual([
      "first-tool",
      null,
      "new-final",
    ]);
    expect(report?.requests.map((request) => request.attempt)).toEqual([1, 1, 2]);
    expect(report?.peakInputTokens).toBe(200);
    expect(report?.cumulativeUsage.inputTokens).toBeNull();
  });

  test("unexpected exceptions retain a safe failure code while keeping private bodies out of the ledger", async () => {
    const f = setup();
    accept(f.conversation);
    const turn = f.conversation.startNextTurn();
    if (!turn) throw new Error("Missing turn.");
    const secret = "Fictional private provider body";
    const failure = new Error(secret);
    const measure = measureCompletion(f.store, {
      kind: "conversation",
      sourceId: turn.id,
      attempt: 1,
    });
    await expect(
      measure([{ role: "user", content: secret }], undefined, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const report = f.health.getSource("conversation", turn.id);
    expect(report?.requests[0]?.failureCode).toBe("unknown");
    expect(report?.requests[0]?.inputTokens).toBeNull();
    expect(JSON.stringify(report)).not.toContain(secret);
    const row = f.store.db.query("SELECT * FROM core_context_requests").get();
    expect(JSON.stringify(row)).not.toContain(secret);
  });
});
