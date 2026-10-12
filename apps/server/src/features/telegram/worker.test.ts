import { afterEach, describe, expect, test } from "bun:test";
import {
  type ConversationSnapshot,
  createConversationService,
  createImageJobService,
  createPromptService,
  openStore,
  type Store,
} from "@valerie/core";
import { InferenceError, type TextCompletion } from "@valerie/inference";
import { fictionalWorkflow, testPng } from "../image-generation/fixtures.test";
import { createImageFailureGenerator } from "../image-generation/notice";
import { prepareImageRequest } from "../image-generation/profile";
import { TelegramError, type TelegramTransport, type TelegramUpdate } from "./transport";
import { startTelegramWorker, type TelegramWorker } from "./worker";

const stores: Store[] = [];
const workers: TelegramWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  for (const store of stores.splice(0)) store.close();
});

const completion = (text = "*smiles* Hello."): TextCompletion => ({
  text,
  complete: true,
  finishReason: "stop",
  requestId: "fictional-request",
  costUsd: null,
  usage: { inputTokens: 100, outputTokens: 8 },
});

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  const conversations = createConversationService(store);
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    model: "fictional-model",
  });
  return { store, conversations };
}

function update(id: number, text = "Hi"): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
    },
  };
}

function transport(overrides: Partial<TelegramTransport> = {}): TelegramTransport {
  return {
    inspect: async () => ({ botId: "123", webhookActive: false }),
    getUpdates: () => new Promise(() => {}),
    downloadImage: async () => {
      throw new TelegramError("rejected", true);
    },
    sendMessage: async () => ({ messageId: "100" }),
    ...overrides,
  };
}

function start(
  store: Store,
  adapter: TelegramTransport,
  generate: Parameters<typeof startTelegramWorker>[0]["generate"] = async () => completion(),
) {
  const worker = startTelegramWorker({
    store,
    token: "123:fictional",
    ownerUserId: "42",
    transport: adapter,
    generate,
    idleMs: 1,
    retryBaseMs: 1,
  });
  workers.push(worker);
  return worker;
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Expected worker outcome did not occur.");
    await Bun.sleep(1);
  }
}

function input(conversations: ReturnType<typeof createConversationService>, id = 1) {
  conversations.acceptTelegramBatch({
    nextOffset: id + 1,
    inputs: [
      { updateId: id, messageId: String(id), chatId: "42", senderId: "42", text: `Message ${id}` },
    ],
  });
}

test("background rendering leaves chat usable and uploads the final image after the acknowledgement", async () => {
  const { store, conversations } = setup();
  const images = createImageJobService(store);
  const sent: string[] = [];
  const uploaded: string[] = [];
  let render: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    render = resolve;
  });
  const worker = startTelegramWorker({
    store,
    token: "123:fictional",
    ownerUserId: "42",
    idleMs: 1,
    transport: transport({
      sendMessage: async ({ text }) => {
        sent.push(text);
        return { messageId: String(100 + sent.length) };
      },
      sendPhoto: async ({ bytes, replyToMessageId }) => {
        expect(Buffer.from(bytes)).toEqual(testPng);
        expect(sent).toEqual([
          "Let me make that for you; it'll take a moment.",
          "We can keep chatting.",
        ]);
        uploaded.push(replyToMessageId);
        return { messageId: "200" };
      },
    }),
    generate: async (_snapshot, _signal, turnId) => {
      if (!turnId) throw new Error("Missing turn ID");
      if (sent.length) return completion("We can keep chatting.");
      const id = crypto.randomUUID();
      const request = prepareImageRequest(
        fictionalWorkflow(),
        { framing: "selfie", scene_tags: ["blue sweater"] },
        { jobId: id },
      );
      images.enqueue({
        id,
        turnId,
        toolCallId: "fictional-call",
        ...request,
        prompt: request.positivePrompt,
      });
      return completion("Let me make that for you; it'll take a moment.");
    },
    images: {
      service: images,
      run: async (signal) => {
        await until(() => images.recentJobs().length > 0);
        const job = images.claimRender();
        if (!job) throw new Error("No render to claim");
        await Promise.race([
          gate,
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        if (!signal.aborted) images.saveImage(job.id, testPng);
      },
    },
  });
  workers.push(worker);
  input(conversations);
  await until(() => sent.length === 1);
  input(conversations, 2);
  await until(() => sent.length === 2);
  expect(uploaded).toHaveLength(0);
  render?.();
  await until(() => images.recentJobs()[0]?.status === "sent");
  expect(uploaded).toEqual(["1"]);
  await worker.stop();
  expect(images.recentJobs()[0]?.telegramMessageId).toBe("200");
});

for (const scenario of ["render_failure", "lost_photo_receipt"] as const) {
  test(`${scenario} sends one generated factual notice using the pinned voice and then continues chatting`, async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    const prompts = createPromptService(store);
    const identity = prompts.get("identity");
    if (!identity) throw new Error("Missing fictional identity prompt.");
    prompts.update(identity.id, {
      content: "Fictional original image-request voice.",
      expectedVersion: identity.version,
    });
    const images = createImageJobService(store);
    const sent: string[] = [];
    let photos = 0;
    let noticeRequests = 0;
    let requestedSnapshot: ConversationSnapshot | undefined;
    let releaseRender: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const noticeText =
      scenario === "render_failure"
        ? "I'm sorry, Ember, I couldn't finish the picture."
        : "I couldn't confirm whether that picture reached you, Ember.";
    const generateNotice = createImageFailureGenerator({
      store,
      apiKey: "fictional-secret",
      transport: async (_url, request) => {
        noticeRequests++;
        const wire = String(request.body);
        const body = JSON.parse(wire);
        expect(body.tools).toBeUndefined();
        expect(wire).toContain("Fictional original image-request voice.");
        expect(wire).not.toContain("Fictional later voice.");
        const instruction = body.messages.at(-1).content;
        expect(instruction).toContain(
          scenario === "render_failure" ? '"status":"failed"' : '"status":"unknown"',
        );
        if (scenario === "lost_photo_receipt") {
          expect(instruction).toContain('"stage":"Telegram delivery"');
          expect(instruction).toContain(
            "could not confirm the outcome, not that it definitely failed",
          );
        }
        return Response.json({
          choices: [{ message: { content: noticeText }, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        });
      },
    });
    const worker = startTelegramWorker({
      store,
      token: "123:fictional",
      ownerUserId: "42",
      idleMs: 1,
      transport: transport({
        sendMessage: async ({ text }) => {
          sent.push(text);
          return { messageId: String(100 + sent.length) };
        },
        sendPhoto: async () => {
          photos++;
          throw new TelegramError("network");
        },
      }),
      generate: async (snapshot, _signal, turnId) => {
        if (!turnId) throw new Error("Missing image turn identity.");
        if (requestedSnapshot) return completion("Of course, we can keep talking.");
        requestedSnapshot = structuredClone(snapshot);
        const id = crypto.randomUUID();
        const request = prepareImageRequest(
          fictionalWorkflow(),
          { framing: "selfie", scene_tags: ["blue sweater"] },
          { jobId: id },
        );
        images.enqueue({
          id,
          turnId,
          toolCallId: "fictional-image-call",
          ...request,
          prompt: request.positivePrompt,
        });
        return completion("Let me make that picture, Ember. It'll take a moment.");
      },
      generateImageFailure: async (snapshot, job, signal) => {
        if (!requestedSnapshot) throw new Error("The requesting snapshot was not captured.");
        expect(snapshot).toEqual(requestedSnapshot);
        expect(job.status).toBe(scenario === "render_failure" ? "failed" : "unknown");
        expect(job.failureCode).toBe(scenario === "render_failure" ? "render_failed" : "network");
        return generateNotice(snapshot, job, signal);
      },
      images: {
        service: images,
        run: async (signal) => {
          await until(() => images.recentJobs().length > 0);
          const job = images.claimRender();
          if (!job) throw new Error("Missing image render.");
          await Promise.race([
            gate,
            new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
          ]);
          if (signal.aborted) return;
          if (scenario === "render_failure") images.fail(job.id, "render_failed");
          else images.saveImage(job.id, testPng);
        },
      },
    });
    workers.push(worker);
    input(conversations);
    await until(() => sent.length === 1);
    const edited = prompts.get("identity");
    if (!edited) throw new Error("Missing fictional identity prompt.");
    prompts.update(edited.id, {
      content: "Fictional later voice.",
      expectedVersion: edited.version,
    });
    releaseRender?.();
    await until(() => {
      const job = images.recentJobs()[0];
      return Boolean(job && images.getFailureNotice(job.id)?.status === "sent");
    });
    const job = images.recentJobs()[0];
    if (!job) throw new Error("Missing terminal image job.");
    const notice = images.getFailureNotice(job.id);
    expect(notice).toMatchObject({
      status: "sent",
      text: noticeText,
      telegramMessageId: "102",
      result: { usage: { inputTokens: 30, outputTokens: 12 } },
    });
    expect(sent).toEqual(["Let me make that picture, Ember. It'll take a moment.", noticeText]);
    expect(photos).toBe(scenario === "render_failure" ? 0 : 1);
    expect(job.status).toBe(scenario === "render_failure" ? "failed" : "unknown");
    expect(job.telegramMessageId).toBeNull();
    input(conversations, 2);
    await until(() => conversations.status().counts.delivered === 2);
    expect(sent).toEqual([
      "Let me make that picture, Ember. It'll take a moment.",
      noticeText,
      "Of course, we can keep talking.",
    ]);
    expect(noticeRequests).toBe(1);
    expect(photos).toBe(scenario === "render_failure" ? 0 : 1);
    await worker.stop();
  });
}

const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L9sAAAAASUVORK5CYII=",
  "base64",
);

function enableVision(conversations: ReturnType<typeof createConversationService>) {
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    modelCapabilities: {
      id: settings.model,
      displayName: "Fictional vision model",
      maxContextTokens: settings.modelContextTokens,
      maxOutputTokens: settings.modelMaxOutputTokens,
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
    },
  });
}

function photoUpdate(
  id: number,
  caption = "What is in this picture?",
  album?: string,
): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      caption,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
      photo: [{ file_id: `photo-${id}`, file_unique_id: `unique-${id}`, width: 1, height: 1 }],
      ...(album ? { media_group_id: album } : {}),
    },
  };
}

function snapshotImages(snapshot: ConversationSnapshot) {
  return snapshot.messages
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .filter((part) => part.type === "image");
}

describe("Telegram conversation worker", () => {
  test("persists owner image references and cursor before downloading, then generates from archived image refs", async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    let polls = 0;
    let finishDownload: ((bytes: Uint8Array) => void) | undefined;
    let generated: ConversationSnapshot | undefined;
    start(
      store,
      transport({
        getUpdates: async () => (++polls === 1 ? [photoUpdate(10)] : new Promise(() => {})),
        downloadImage: () =>
          new Promise((resolve) => {
            finishDownload = resolve;
          }),
      }),
      async (snapshot) => {
        generated = snapshot;
        return completion("A small picture.");
      },
    );
    await until(() => Boolean(finishDownload));
    expect(conversations.cursor()).toBe(11);
    expect(conversations.recentTurns()).toHaveLength(1);
    expect(generated).toBeUndefined();
    finishDownload?.(imageBytes);
    await until(() => conversations.status().counts.delivered === 1);
    const ref = generated && snapshotImages(generated)[0];
    expect(ref?.mimeType).toBe("image/png");
    expect(ref && conversations.getAttachment(ref.attachmentId)?.bytes).toEqual(imageBytes);
    expect(JSON.stringify(generated)).not.toContain("photo-10");
    expect(JSON.stringify(generated)).not.toContain("api.telegram.org");
  });

  test("reuses archived image bytes and the pinned image snapshot on inference retry", async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    let polls = 0;
    let downloads = 0;
    const snapshots: ConversationSnapshot[] = [];
    start(
      store,
      transport({
        getUpdates: async () => (++polls === 1 ? [photoUpdate(10)] : new Promise(() => {})),
        downloadImage: async () => {
          downloads++;
          return imageBytes;
        },
      }),
      async (snapshot) => {
        snapshots.push(snapshot);
        if (snapshots.length === 1) throw new InferenceError("network", true);
        return completion();
      },
    );
    await until(() => conversations.status().counts.delivered === 1);
    expect(downloads).toBe(1);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toEqual(snapshots[0]);
  });

  test("never downloads photos from a different sender, group or bot", async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    let polls = 0;
    let downloads = 0;
    const base = photoUpdate(10).message as Record<string, unknown>;
    start(
      store,
      transport({
        getUpdates: async () =>
          ++polls === 1
            ? [
                { update_id: 10, message: { ...base, from: { id: 99, is_bot: false } } },
                { update_id: 11, message: { ...base, chat: { id: 42, type: "group" } } },
                { update_id: 12, message: { ...base, from: { id: 42, is_bot: true } } },
              ]
            : new Promise(() => {}),
        downloadImage: async () => {
          downloads++;
          return imageBytes;
        },
      }),
    );
    await until(() => conversations.cursor() === 13);
    expect(downloads).toBe(0);
    expect(conversations.recentTurns()).toHaveLength(0);
  });

  test("groups image album updates across polling batches into one reply", async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    let polls = 0;
    const snapshots: ConversationSnapshot[] = [];
    start(
      store,
      transport({
        getUpdates: async () => {
          polls++;
          if (polls === 1) return [photoUpdate(10, "Compare these.", "album")];
          if (polls === 2) return [photoUpdate(11, "", "album")];
          return new Promise(() => {});
        },
        downloadImage: async () => imageBytes,
      }),
      async (snapshot) => {
        snapshots.push(snapshot);
        return completion();
      },
    );
    await until(() => conversations.status().counts.delivered === 1);
    expect(snapshots).toHaveLength(1);
    expect(snapshotImages(snapshots[0] as ConversationSnapshot)).toHaveLength(2);
    expect(conversations.recentTurns()).toHaveLength(1);
    expect(conversations.cursor()).toBe(12);
  });

  test("a video-first mixed album preserves its caption and omitted member alongside the ready photo", async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    let polls = 0;
    const downloads: string[] = [];
    const snapshots: ConversationSnapshot[] = [];
    const caption = "  Compare *these*\nplease.  ";
    start(
      store,
      transport({
        getUpdates: async () => {
          polls++;
          if (polls === 1)
            return [
              {
                update_id: 10,
                message: {
                  message_id: 10,
                  from: { id: 42, is_bot: false },
                  chat: { id: 42, type: "private" },
                  media_group_id: "mixed-album",
                  caption,
                  video: { file_id: "never-download-video" },
                },
              },
            ];
          if (polls === 2) return [photoUpdate(11, "", "mixed-album")];
          return new Promise(() => {});
        },
        downloadImage: async ({ fileId }) => {
          downloads.push(fileId);
          return imageBytes;
        },
      }),
      async (snapshot) => {
        snapshots.push(snapshot);
        return completion();
      },
    );
    await until(() => conversations.status().counts.delivered === 1);
    expect(snapshots).toHaveLength(1);
    expect(snapshotImages(snapshots[0] as ConversationSnapshot)).toHaveLength(1);
    const userParts = snapshots[0]?.messages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content,
      );
    expect(userParts).toContainEqual({ type: "text", text: caption });
    expect(userParts?.some((part) => part.type === "text" && /omitted/i.test(part.text))).toBe(
      true,
    );
    expect(downloads).toEqual(["photo-11"]);
    expect(conversations.recentTurns()).toHaveLength(1);
    expect(conversations.cursor()).toBe(12);
    expect(
      store.db
        .query("SELECT input_text,rejection_code FROM core_telegram_inputs WHERE update_id=10")
        .get(),
    ).toEqual({ input_text: caption, rejection_code: "unsupported_album_media" });
  });

  test("a valid album identifier between 101 and 200 characters does not stop the worker", async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    let polls = 0;
    const worker = start(
      store,
      transport({
        getUpdates: async () =>
          ++polls === 1
            ? [photoUpdate(10, "Long album identifier", "a".repeat(150))]
            : new Promise(() => {}),
        downloadImage: async () => imageBytes,
      }),
    );
    await until(() => conversations.status().counts.delivered === 1);
    expect(worker.status().state).toBe("running");
    expect(conversations.cursor()).toBe(11);
  });

  test("aborts image downloads on stop and recovers them on restart", async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    let polls = 0;
    let downloading: AbortSignal | undefined;
    const first = start(
      store,
      transport({
        getUpdates: async () => (++polls === 1 ? [photoUpdate(10)] : new Promise(() => {})),
        downloadImage: async ({ signal }) => {
          downloading = signal;
          return new Promise(() => {});
        },
      }),
    );
    await until(() => Boolean(downloading));
    await first.stop();
    expect(downloading?.aborted).toBe(true);
    start(store, transport({ downloadImage: async () => imageBytes }));
    await until(() => conversations.status().counts.delivered === 1);
    expect(conversations.recentTurns()).toHaveLength(1);
  });

  test("unsupported image documents record failure without downloading or generating", async () => {
    const { store, conversations } = setup();
    let polls = 0;
    let downloads = 0;
    let generations = 0;
    start(
      store,
      transport({
        getUpdates: async () =>
          ++polls === 1
            ? [
                {
                  update_id: 10,
                  message: {
                    message_id: 10,
                    caption: "This one",
                    from: { id: 42, is_bot: false },
                    chat: { id: 42, type: "private" },
                    document: {
                      file_id: "heic",
                      file_unique_id: "unique-heic",
                      mime_type: "image/heic",
                    },
                  },
                },
              ]
            : new Promise(() => {}),
        downloadImage: async () => {
          downloads++;
          return imageBytes;
        },
      }),
      async () => {
        generations++;
        return completion();
      },
    );
    await until(() => conversations.status().counts.failed === 1);
    expect(conversations.cursor()).toBe(11);
    expect(conversations.recentTurns()[0]?.failureCode).toBe("unsupported_image_format");
    expect(downloads).toBe(0);
    expect(generations).toBe(0);
  });

  test("a failed image download cannot mutate a successor after the polling lease expires", async () => {
    const { store, conversations } = setup();
    enableVision(conversations);
    let polls = 0;
    let rejectDownload: ((error: Error) => void) | undefined;
    const worker = start(
      store,
      transport({
        getUpdates: async () => (++polls === 1 ? [photoUpdate(10)] : new Promise(() => {})),
        downloadImage: () =>
          new Promise((_resolve, reject) => {
            rejectDownload = reject;
          }),
      }),
    );
    await until(() => Boolean(rejectDownload));
    store.db
      .query("UPDATE core_telegram_state SET lease_expires_at = ?")
      .run("1970-01-01T00:00:00.000Z");
    conversations.acquireTelegramLease("new-worker", new Date(Date.now() + 60_000).toISOString());
    conversations.recoverInterrupted();
    const successor = conversations.claimAttachmentDownload();
    expect(successor).not.toBeNull();
    rejectDownload?.(new TelegramError("network"));
    await until(() => worker.status().state === "failed");
    expect(worker.status().lastError).toBe("lease_lost");
    expect(conversations.recentTurns()[0]?.attachments[0]?.status).toBe("downloading");
  });

  test("deduplicates repeated batches with an atomic cursor and persists actual delivery", async () => {
    const { store, conversations } = setup();
    const offsets: number[] = [];
    let generations = 0;
    const sent: string[] = [];
    const worker = start(
      store,
      transport({
        getUpdates: async ({ offset }) => {
          offsets.push(offset);
          if (offsets.length <= 2) return [update(10)];
          return new Promise(() => {});
        },
        sendMessage: async ({ text }) => {
          sent.push(text);
          return { messageId: "100" };
        },
      }),
      async () => {
        generations += 1;
        return completion();
      },
    );
    await until(() => conversations.status().counts.delivered === 1 && offsets.length === 3);
    await worker.stop();
    expect(offsets).toEqual([0, 11, 11]);
    expect(conversations.cursor()).toBe(11);
    expect(generations).toBe(1);
    expect(sent).toEqual(["*smiles* Hello."]);
    expect(
      store.db.query("SELECT telegram_message_id FROM core_conversation_outbox").get(),
    ).toEqual({ telegram_message_id: "100" });
  });

  test("a second worker cannot start or call Telegram while the lease is held", async () => {
    const { store } = setup();
    const first = start(store, transport());
    let inspected = false;
    expect(() =>
      start(
        store,
        transport({
          inspect: async () => {
            inspected = true;
            return { botId: "123", webhookActive: false };
          },
        }),
      ),
    ).toThrow("polling lease");
    expect(inspected).toBe(false);
    await first.stop();
    const replacement = start(store, transport());
    await replacement.stop();
  });

  test("never polls or sends while an existing webhook is active", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let externalActions = 0;
    const worker = start(
      store,
      transport({
        inspect: async () => ({ botId: "123", webhookActive: true }),
        getUpdates: async () => {
          externalActions += 1;
          return [];
        },
        sendMessage: async () => {
          externalActions += 1;
          return { messageId: "100" };
        },
      }),
    );
    expect(worker.status().state).toBe("starting");
    await until(() => worker.status().state === "failed");
    expect(worker.status().lastError).toBe("webhook_active");
    expect(externalActions).toBe(0);
    expect(
      store.db.query("SELECT count(*) AS count FROM core_activity WHERE status = 'pending'").get(),
    ).toEqual({ count: 0 });
  });

  test("an invalid token cannot bind bot identity or recover pending work", async () => {
    const { store, conversations } = setup();
    input(conversations);
    conversations.startNextTurn();
    const invalid = startTelegramWorker({
      store,
      token: "999:typo",
      ownerUserId: "42",
      generate: async () => completion(),
      transport: transport({
        inspect: async () => {
          throw new TelegramError("unauthorized", true);
        },
      }),
      idleMs: 1,
    });
    workers.push(invalid);
    await until(() => invalid.status().state === "failed");
    await invalid.stop();
    expect(store.db.query("SELECT bot_id FROM core_telegram_state").get()).toEqual({
      bot_id: null,
    });
    expect(conversations.recentTurns()[0]?.status).toBe("generating");
    start(store, transport());
    await until(() => conversations.status().counts.delivered === 1);
    expect(store.db.query("SELECT bot_id FROM core_telegram_state").get()).toEqual({
      bot_id: "123",
    });
  });

  test("an ambiguous first chunk is never resent and cancels its remaining chunks", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let sends = 0;
    const first = start(
      store,
      transport({
        sendMessage: async () => {
          sends += 1;
          throw new TelegramError("server");
        },
      }),
      async () => completion("a".repeat(5000)),
    );
    await until(() => conversations.status().counts.unknown === 1);
    await first.stop();
    const replacement = start(
      store,
      transport({
        sendMessage: async () => {
          sends += 1;
          return { messageId: "100" };
        },
      }),
    );
    await Bun.sleep(10);
    await replacement.stop();
    expect(sends).toBe(1);
    expect(
      store.db.query("SELECT status FROM core_conversation_outbox ORDER BY sequence").all(),
    ).toEqual([{ status: "unknown" }, { status: "cancelled" }]);
  });

  test("retries only explicit rate limits and preserves chunk order", async () => {
    const { store, conversations } = setup();
    input(conversations);
    const sent: string[] = [];
    start(
      store,
      transport({
        sendMessage: async ({ text }) => {
          sent.push(text);
          if (sent.length === 1) throw new TelegramError("rate_limited", true);
          return { messageId: String(100 + sent.length) };
        },
      }),
      async () => completion("a".repeat(5000)),
    );
    await until(() => conversations.status().counts.delivered === 1);
    expect(sent.map((text) => text.length)).toEqual([4096, 4096, 904]);
  });

  test("recovers interrupted generation with its exact original prompt and settings", async () => {
    const { store, conversations } = setup();
    input(conversations);
    const original = conversations.startNextTurn();
    expect(original).not.toBeNull();
    const settings = conversations.getSettings();
    conversations.saveSettings({
      ...settings,
      expectedVersion: settings.version,
      model: "changed-model",
    });
    createPromptService(store).update("identity", {
      content: "Changed identity.",
      expectedVersion: 1,
    });
    let usedSnapshot: unknown;
    start(store, transport(), async (snapshot) => {
      usedSnapshot = snapshot;
      return completion();
    });
    await until(() => conversations.status().counts.delivered === 1);
    expect(usedSnapshot).toEqual(original?.snapshot);
    expect(conversations.recentTurns()[0]?.attempts).toBe(2);
  });

  test("aborts and joins stuck generation before returning from stop", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let generationSignal: AbortSignal | undefined;
    const worker = start(store, transport(), async (_snapshot, signal) => {
      generationSignal = signal;
      return new Promise(() => {});
    });
    await until(() => Boolean(generationSignal));
    await worker.stop();
    expect(generationSignal?.aborted).toBe(true);
    expect(worker.status().state).toBe("stopped");
    expect(conversations.recentTurns()[0]?.status).toBe("retry");
    expect(store.db.query("SELECT lease_owner FROM core_telegram_state").get()).toEqual({
      lease_owner: null,
    });
  });

  test("aborting an in-flight send records unknown without retry on restart", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let sending = false;
    const worker = start(
      store,
      transport({
        sendMessage: () => {
          sending = true;
          return new Promise(() => {});
        },
      }),
    );
    await until(() => sending);
    await worker.stop();
    expect(conversations.recentTurns()[0]?.status).toBe("unknown");
    expect(conversations.claimDelivery()).toBeNull();
  });

  test("bounds inference retries", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let generations = 0;
    let sends = 0;
    start(
      store,
      transport({
        sendMessage: async () => {
          sends += 1;
          return { messageId: "100" };
        },
      }),
      async () => {
        generations += 1;
        throw new InferenceError("network", true);
      },
    );
    await until(() => conversations.status().counts.failed === 1);
    expect(generations).toBe(3);
    expect(sends).toBe(0);
  });

  test("never sends partial output when generation runs out of tokens", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let sends = 0;
    start(
      store,
      transport({
        sendMessage: async () => {
          sends += 1;
          return { messageId: "100" };
        },
      }),
      async () => ({
        ...completion("unfinished"),
        complete: false,
        finishReason: "length",
        usage: {
          inputTokens: 100,
          outputTokens: 4096,
          cachedInputTokens: 50,
          reasoningTokens: 4080,
        },
      }),
    );
    await until(() => conversations.status().counts.failed === 1);
    expect(conversations.recentTurns()[0]?.failureCode).toBe("incomplete_response");
    expect(sends).toBe(0);
    const row = store.db
      .query<{ result_json: string; output_text: string }, []>(
        "SELECT result_json, output_text FROM core_conversation_turns",
      )
      .get();
    expect(row?.output_text).toBe("unfinished");
    expect(JSON.parse(row?.result_json ?? "{}")).toMatchObject({
      requestId: "fictional-request",
      costUsd: null,
      finishReason: "length",
      usage: { inputTokens: 100, outputTokens: 4096, cachedInputTokens: 50, reasoningTokens: 4080 },
    });
  });

  test("lease loss fences completed generation before any message can be sent", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let resolveGeneration: ((result: TextCompletion) => void) | undefined;
    let sends = 0;
    const worker = start(
      store,
      transport({
        sendMessage: async () => {
          sends += 1;
          return { messageId: "100" };
        },
      }),
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    await until(() => Boolean(resolveGeneration));
    store.db
      .query("UPDATE core_telegram_state SET lease_expires_at = ?")
      .run("1970-01-01T00:00:00.000Z");
    expect(
      conversations.acquireTelegramLease("new-worker", new Date(Date.now() + 60_000).toISOString()),
    ).toBe(true);
    resolveGeneration?.(completion());
    await until(() => worker.status().state === "failed");
    await worker.stop();
    expect(worker.status().lastError).toBe("lease_lost");
    expect(sends).toBe(0);
    expect(store.db.query("SELECT count(*) AS count FROM core_conversation_outbox").get()).toEqual({
      count: 0,
    });
    expect(store.db.query("SELECT lease_owner FROM core_telegram_state").get()).toEqual({
      lease_owner: "new-worker",
    });
  });

  test("lease loss fences rejected generation from changing its successor's turn", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let rejectGeneration: ((error: Error) => void) | undefined;
    const worker = start(
      store,
      transport(),
      () =>
        new Promise((_resolve, reject) => {
          rejectGeneration = reject;
        }),
    );
    await until(() => Boolean(rejectGeneration));
    store.db
      .query("UPDATE core_telegram_state SET lease_expires_at = ?")
      .run("1970-01-01T00:00:00.000Z");
    conversations.acquireTelegramLease("new-worker", new Date(Date.now() + 60_000).toISOString());
    conversations.recoverInterrupted();
    const successor = conversations.startNextTurn();
    rejectGeneration?.(new InferenceError("network", true));
    await until(() => worker.status().state === "failed");
    expect(worker.status().lastError).toBe("lease_lost");
    expect(conversations.recentTurns()[0]).toMatchObject({
      id: successor?.id,
      status: "generating",
      attempts: 2,
    });
  });

  test("lease loss fences a send error from changing the new owner's delivery state", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let rejectSend: ((error: Error) => void) | undefined;
    const worker = start(
      store,
      transport({
        sendMessage: () =>
          new Promise((_resolve, reject) => {
            rejectSend = reject;
          }),
      }),
    );
    await until(() => Boolean(rejectSend));
    store.db
      .query("UPDATE core_telegram_state SET lease_expires_at = ?")
      .run("1970-01-01T00:00:00.000Z");
    conversations.acquireTelegramLease("new-worker", new Date(Date.now() + 60_000).toISOString());
    rejectSend?.(new TelegramError("network"));
    await until(() => worker.status().state === "failed");
    expect(worker.status().lastError).toBe("lease_lost");
    expect(store.db.query("SELECT status FROM core_conversation_outbox").get()).toEqual({
      status: "sending",
    });
  });

  test("reconnects polling from the committed cursor and stops on a competing poller", async () => {
    const { store, conversations } = setup();
    const offsets: number[] = [];
    const worker = start(
      store,
      transport({
        getUpdates: async ({ offset }) => {
          offsets.push(offset);
          if (offsets.length === 1) throw new TelegramError("network");
          if (offsets.length === 2) return [{ update_id: 80 }];
          throw new TelegramError("conflict", true);
        },
      }),
    );
    await until(() => worker.status().state === "failed");
    expect(offsets).toEqual([0, 0, 81]);
    expect(conversations.cursor()).toBe(81);
    expect(worker.status().lastError).toBe("conflict");
  });

  test("persists the actual retry_after deadline and does not retry early", async () => {
    const { store, conversations } = setup();
    input(conversations);
    let sends = 0;
    const before = Date.now();
    const worker = start(
      store,
      transport({
        sendMessage: async () => {
          sends += 1;
          throw new TelegramError("rate_limited", true, 30);
        },
      }),
    );
    await until(() =>
      Boolean(
        store.db.query("SELECT id FROM core_conversation_outbox WHERE status = 'retry'").get(),
      ),
    );
    await worker.stop();
    const row = store.db
      .query<{ next_attempt_at: string }, []>(
        "SELECT next_attempt_at FROM core_conversation_outbox",
      )
      .get();
    expect(Date.parse(row?.next_attempt_at ?? "") - before).toBeGreaterThanOrEqual(30_000);
    expect(sends).toBe(1);
  });
});
