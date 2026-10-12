import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationMessage,
  type ConversationService,
  createConversationService,
  ImageValidationError,
  inspectImageBytes,
  MAX_IMAGE_BYTES,
  openStore,
  type Store,
  type TelegramInput,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=",
  "base64",
);
const model = {
  id: "fictional-vision",
  displayName: "Fictional Vision",
  maxContextTokens: 131072,
  maxOutputTokens: 16384,
  systemRole: true,
  reasoningEffort: false,
  deprecated: false,
  vision: true,
  maxImages: 20,
  reasoning: null,
  pricing: {
    currency: null,
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
    pricingTbd: true,
  },
};

function fixture(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  let clock = new Date("2026-09-13T12:00:00.000Z");
  const conversations = createConversationService(store, { now: () => clock });
  const current = conversations.getSettings();
  if (!current.model)
    conversations.saveSettings({
      ...current,
      expectedVersion: current.version,
      model: model.id,
      modelCapabilities: model,
    });
  return {
    store,
    conversations,
    advance: (ms: number) => {
      clock = new Date(clock.valueOf() + ms);
    },
  };
}

function input(id: number, caption = "", mediaGroupId?: string): TelegramInput {
  return {
    updateId: id,
    messageId: String(id),
    chatId: "123",
    senderId: "123",
    text: caption,
    images: [
      {
        fileId: `file-${id}=`,
        fileUniqueId: `unique-${id}`,
        mimeType: "image/png",
        fileSize: png.length,
      },
    ],
    ...(mediaGroupId ? { mediaGroupId } : {}),
  };
}
function accept(service: ConversationService, message: TelegramInput) {
  return service.acceptTelegramBatch({ nextOffset: message.updateId + 1, inputs: [message] });
}
function download(service: ConversationService, bytes: Uint8Array = png) {
  const attachment = service.claimAttachmentDownload();
  if (!attachment) throw new Error("Missing fixture download.");
  service.saveAttachment(attachment.id, { bytes });
  return attachment;
}
function deliver(service: ConversationService, text = "A confirmed description.") {
  const turn = service.startNextTurn();
  if (!turn) throw new Error("Missing fixture turn.");
  service.completeGeneration(turn.id, { text });
  const delivery = service.claimDelivery();
  if (!delivery) throw new Error("Missing fixture delivery.");
  service.recordDelivery(delivery.id, { status: "sent", messageId: "987" });
  return turn;
}
const imageParts = (messages: ConversationMessage[]) =>
  messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.filter((part) => part.type === "image"),
  );

test("photo acceptance archives immutable bytes before generation and retries reuse its exact reference", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-images-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const first = fixture(path);
  expect(accept(first.conversations, input(1))).toEqual({ accepted: 1 });
  expect(first.conversations.cursor()).toBe(2);
  expect(first.conversations.startNextTurn()).toBeNull();
  expect(first.conversations.recentTurns()[0]?.attachments[0]?.status).toBe("pending");
  const source = new Uint8Array(png);
  const attachment = download(first.conversations, source);
  source.fill(0);
  const turn = first.conversations.startNextTurn();
  if (!turn) throw new Error("Missing fixture turn.");
  expect(imageParts(turn.snapshot.messages)).toEqual([
    {
      type: "image",
      attachmentId: attachment.id,
      mimeType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
    },
  ]);
  expect(JSON.stringify(turn.snapshot)).not.toContain("data:image");
  expect(JSON.stringify(turn.snapshot)).not.toContain(png.toString("base64"));
  expect(first.conversations.getAttachment(attachment.id)?.bytes).toEqual(new Uint8Array(png));
  expect(() =>
    first.store.db
      .query("UPDATE core_conversation_attachments SET original_bytes = ? WHERE id = ?")
      .run(new Uint8Array([1]), attachment.id),
  ).toThrow("immutable");
  first.store.close();
  stores.splice(stores.indexOf(first.store), 1);
  const reopened = fixture(path);
  reopened.conversations.recoverInterrupted();
  expect(reopened.conversations.startNextTurn()?.snapshot).toEqual(turn.snapshot);
  expect(reopened.conversations.claimAttachmentDownload()).toBeNull();
  expect(reopened.conversations.getAttachment(attachment.id)?.bytes).toEqual(new Uint8Array(png));
  expect(accept(reopened.conversations, input(1))).toEqual({ accepted: 0 });
});

test("album members deduplicate independently, settle durably and become one ordered multimodal turn", () => {
  const { store, conversations, advance } = fixture();
  accept(conversations, input(1, "First caption\n", "album-1"));
  const first = download(conversations);
  advance(500);
  accept(conversations, input(2, "Second caption", "album-1"));
  const second = download(conversations);
  expect(accept(conversations, input(2, "Second caption", "album-1"))).toEqual({ accepted: 0 });
  advance(749);
  expect(conversations.startNextTurn()).toBeNull();
  advance(1);
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing fixture album.");
  expect(turn.inputText).toBe("First caption\n\n\nSecond caption");
  expect(turn.snapshot.messages.at(-1)?.content).toEqual([
    { type: "text", text: "First caption\n" },
    {
      type: "image",
      attachmentId: first.id,
      mimeType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
    },
    { type: "text", text: "Second caption" },
    {
      type: "image",
      attachmentId: second.id,
      mimeType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"),
    },
  ]);
  expect(
    store.db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM core_telegram_inputs")
      .get()?.count,
  ).toBe(2);
  expect(conversations.recentTurns()).toHaveLength(1);
  accept(conversations, input(3, "A late member", "album-1"));
  expect(conversations.recentTurns()).toHaveLength(2);
  expect(conversations.cursor()).toBe(4);
  expect(imageParts(turn.snapshot.messages)).toHaveLength(2);
});

test("album quiet time is capped at three seconds and input count is bounded", () => {
  const { conversations, advance } = fixture();
  for (let id = 1; id <= 7; id++) {
    accept(conversations, input(id, "", "busy-album"));
    download(conversations);
    if (id < 7) advance(490);
  }
  expect(conversations.startNextTurn()).toBeNull();
  advance(60);
  expect(imageParts(conversations.startNextTurn()?.snapshot.messages ?? [])).toHaveLength(7);
});

test("failed downloads cannot be manually retried into a blocked turn and later text continues", () => {
  const { conversations } = fixture();
  accept(conversations, input(1, "A broken image"));
  const pending = conversations.claimAttachmentDownload();
  if (!pending) throw new Error("Missing download.");
  conversations.failAttachmentDownload(pending.id, { code: "invalid_image" });
  const summary = conversations.recentTurns()[0];
  expect(summary).toMatchObject({ status: "failed", canRetry: false });
  expect(() => conversations.retryTurn(pending.turnId)).toThrow("Resend");
  accept(conversations, {
    updateId: 2,
    messageId: "2",
    chatId: "123",
    senderId: "123",
    text: "Continue in text",
  });
  expect(conversations.startNextTurn()?.inputText).toBe("Continue in text");
});

test("download recovery retains the caption, cursor and attachment identity", () => {
  const { conversations, advance } = fixture();
  accept(conversations, input(1, "Keep this caption"));
  const first = conversations.claimAttachmentDownload();
  if (!first) throw new Error("Missing download.");
  conversations.failAttachmentDownload(first.id, {
    code: "network",
    retryAt: "2026-09-13T12:00:01.000Z",
  });
  expect(conversations.recentTurns()[0]?.nextAttemptAt).toBe("2026-09-13T12:00:01.000Z");
  expect(conversations.claimAttachmentDownload()).toBeNull();
  advance(1000);
  expect(conversations.claimAttachmentDownload()?.id).toBe(first.id);
  expect(conversations.recoverInterrupted()).toEqual({
    generations: 0,
    deliveries: 0,
    attachments: 1,
  });
  const retry = download(conversations);
  expect(retry.id).toBe(first.id);
  expect(retry.attempts).toBe(3);
  expect(conversations.cursor()).toBe(2);
  expect(conversations.startNextTurn()?.inputText).toBe("Keep this caption");
});

test("history image token pressure preserves older captions and delivered conversation", () => {
  const { conversations } = fixture();
  accept(conversations, {
    updateId: 1,
    messageId: "1",
    chatId: "123",
    senderId: "123",
    text: "An ongoing all-day topic",
  });
  deliver(conversations, "An earlier confirmed answer");
  accept(conversations, input(2, "A picture related to the topic"));
  download(conversations);
  deliver(conversations, "Its confirmed visual description");
  const current = conversations.getSettings();
  conversations.saveSettings({ ...current, expectedVersion: current.version, historyTokens: 1000 });
  accept(conversations, {
    updateId: 3,
    messageId: "3",
    chatId: "123",
    senderId: "123",
    text: "Continue the topic",
  });
  const snapshot = conversations.startNextTurn()?.snapshot;
  expect(snapshot?.history.includedTurns).toBe(2);
  expect(snapshot?.history.includedImages).toBe(0);
  expect(snapshot?.history.omittedImages).toBe(1);
  expect(imageParts(snapshot?.messages ?? [])).toHaveLength(0);
  expect(JSON.stringify(snapshot?.messages)).toContain(
    "Earlier image omitted from the current request",
  );
  expect(JSON.stringify(snapshot?.messages)).toContain("Its confirmed visual description");
  expect(JSON.stringify(snapshot?.messages)).toContain("An ongoing all-day topic");
});

test("history retains at most four images while keeping older text exchanges", () => {
  const { conversations } = fixture();
  for (let id = 1; id <= 6; id++) {
    accept(conversations, input(id, `Caption ${id}`));
    download(conversations);
    deliver(conversations);
  }
  accept(conversations, {
    updateId: 7,
    messageId: "7",
    chatId: "123",
    senderId: "123",
    text: "Remember this topic",
  });
  const snapshot = conversations.startNextTurn()?.snapshot;
  expect(snapshot?.history.includedTurns).toBe(6);
  expect(snapshot?.history.includedImages).toBe(4);
  expect(snapshot?.history.omittedImages).toBe(2);
  expect(imageParts(snapshot?.messages ?? [])).toHaveLength(4);
});

test("unsupported inputs are acknowledged without download, and old models cannot pretend to see images", () => {
  const { conversations } = fixture();
  accept(conversations, { ...input(1), rejectionCode: "unsupported_image_format" });
  expect(conversations.cursor()).toBe(2);
  expect(conversations.claimAttachmentDownload()).toBeNull();
  expect(conversations.recentTurns()[0]).toMatchObject({
    status: "failed",
    failureCode: "unsupported_image_format",
    canRetry: false,
  });
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    modelCapabilities: { ...model, vision: undefined, maxImages: undefined },
  });
  accept(conversations, input(2));
  download(conversations);
  expect(conversations.startNextTurn()).toBeNull();
  expect(conversations.recentTurns()[0]).toMatchObject({
    status: "failed",
    failureCode: "model_images_unsupported",
    canRetry: true,
  });
});

test("a later rejected album member cannot make an in-flight download stop the worker", () => {
  const { conversations, advance } = fixture();
  accept(conversations, input(1, "", "mixed-album"));
  const pending = conversations.claimAttachmentDownload();
  if (!pending) throw new Error("Missing download.");
  accept(conversations, {
    ...input(2, "", "mixed-album"),
    rejectionCode: "unsupported_image_format",
  });
  conversations.saveAttachment(pending.id, { bytes: png });
  expect(conversations.recentTurns()[0]?.status).toBe("queued");
  expect(conversations.getAttachment(pending.id)?.bytes).toEqual(new Uint8Array(png));
  expect(conversations.startNextTurn()).toBeNull();
  advance(750);
  const turn = conversations.startNextTurn();
  expect(imageParts(turn?.snapshot.messages ?? [])).toHaveLength(1);
  expect(JSON.stringify(turn?.snapshot.messages)).toContain("Album media omitted");
});

test.each([false, true])(
  "mixed albums retain unsupported captions in either arrival order: unsupported first %s",
  (unsupportedFirst) => {
    const { conversations, advance } = fixture();
    const unsupported = (id: number): TelegramInput => ({
      updateId: id,
      messageId: String(id),
      chatId: "123",
      senderId: "123",
      text: "Exact video caption.\n",
      mediaGroupId: "mixed-video",
      rejectionCode: "unsupported_album_media",
    });
    const messages = unsupportedFirst
      ? [unsupported(1), input(2, "A supported photo", "mixed-video")]
      : [input(1, "A supported photo", "mixed-video"), unsupported(2)];
    for (const message of messages) accept(conversations, message);
    expect(conversations.recentTurns()).toHaveLength(1);
    download(conversations);
    expect(conversations.startNextTurn()).toBeNull();
    advance(750);
    const turn = conversations.startNextTurn();
    if (!turn) throw new Error("Missing partial album.");
    expect(imageParts(turn.snapshot.messages)).toHaveLength(1);
    expect(turn.inputText).toContain("Exact video caption.\n");
    const parts = turn.snapshot.messages.at(-1)?.content;
    expect(Array.isArray(parts)).toBe(true);
    if (!Array.isArray(parts)) throw new Error("Missing album parts.");
    const unsupportedCaptionIndex = parts.findIndex(
      (part) => part.type === "text" && part.text === "Exact video caption.\n",
    );
    expect(parts[unsupportedCaptionIndex + 1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Album media omitted from the current request"),
    });
    conversations.failGeneration(turn.id, { code: "provider" });
    expect(conversations.recentTurns()[0]?.canRetry).toBe(true);
    conversations.retryTurn(turn.id);
    expect(conversations.startNextTurn()?.snapshot).toEqual(turn.snapshot);
    expect(conversations.claimAttachmentDownload()).toBeNull();
  },
);

test("one failed image download keeps another readable album image and pins its omission for retries", () => {
  const { conversations, advance } = fixture();
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    modelCapabilities: { ...model, maxImages: 1 },
  });
  accept(conversations, input(1, "Failed download caption", "partly-readable"));
  accept(conversations, input(2, "Readable image caption", "partly-readable"));
  const unavailable = conversations.claimAttachmentDownload();
  if (!unavailable) throw new Error("Missing unavailable image.");
  conversations.failAttachmentDownload(unavailable.id, { code: "invalid_image" });
  expect(conversations.recentTurns()[0]?.status).toBe("queued");
  download(conversations);
  advance(750);
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing readable partial album.");
  expect(imageParts(turn.snapshot.messages)).toHaveLength(1);
  expect(JSON.stringify(turn.snapshot.messages)).toContain("Failed download caption");
  expect(JSON.stringify(turn.snapshot.messages)).toContain(
    "Album image omitted from the current request because its download failed",
  );
  conversations.failGeneration(turn.id, { code: "provider" });
  expect(conversations.recentTurns()[0]?.canRetry).toBe(true);
  conversations.retryTurn(turn.id);
  expect(conversations.startNextTurn()?.snapshot).toEqual(turn.snapshot);
  expect(conversations.claimAttachmentDownload()).toBeNull();
});

test("an album containing only unsupported media settles to failure and cannot become caption-only inference", () => {
  const { conversations, advance } = fixture();
  accept(conversations, {
    updateId: 1,
    messageId: "1",
    chatId: "123",
    senderId: "123",
    text: "Video-only caption",
    mediaGroupId: "unsupported-only",
    rejectionCode: "unsupported_album_media",
  });
  expect(conversations.recentTurns()[0]?.status).toBe("queued");
  expect(conversations.startNextTurn()).toBeNull();
  advance(750);
  expect(conversations.startNextTurn()).toBeNull();
  const turn = conversations.recentTurns()[0];
  if (!turn) throw new Error("Missing unsupported album.");
  expect(turn).toMatchObject({ status: "failed", canRetry: false, settingsVersion: null });
  expect(() => conversations.retryTurn(turn.id)).toThrow("Resend a supported image");
});

test("valid long Telegram album identifiers cannot poison the durable inbox", () => {
  const { conversations, advance } = fixture();
  accept(conversations, input(1, "Long identifier", "7".repeat(150)));
  download(conversations);
  advance(750);
  expect(imageParts(conversations.startNextTurn()?.snapshot.messages ?? [])).toHaveLength(1);
  expect(conversations.cursor()).toBe(2);
});

test("rejected images without download descriptors can never become caption-only inference retries", () => {
  const { conversations } = fixture();
  for (const [index, caption] of ["What is in this image?", ""].entries()) {
    accept(conversations, {
      updateId: index + 1,
      messageId: String(index + 1),
      chatId: "123",
      senderId: "123",
      text: caption,
      rejectionCode: "unsupported_image_format",
    });
    const turn = conversations.recentTurns()[0];
    if (!turn) throw new Error("Missing rejected input.");
    expect(turn).toMatchObject({ status: "failed", canRetry: false, attachments: [] });
    expect(() => conversations.retryTurn(turn.id)).toThrow("Resend a supported image");
    expect(conversations.startNextTurn()).toBeNull();
  }
  expect(conversations.cursor()).toBe(3);
});

test("image header inspection enforces type, byte and dimension bounds without trusting declared MIME", () => {
  expect(inspectImageBytes(png)).toEqual({ mimeType: "image/png", width: 1, height: 1 });
  expect(() => inspectImageBytes(new Uint8Array(MAX_IMAGE_BYTES + 1))).toThrow("image_too_large");
  expect(() => inspectImageBytes(new Uint8Array(Buffer.from("<svg></svg>")))).toThrow(
    ImageValidationError,
  );
  expect(() => inspectImageBytes(png.subarray(0, 20))).toThrow("invalid_image");
  const tooWide = new Uint8Array(png);
  new DataView(tooWide.buffer).setUint32(16, 8193);
  expect(() => inspectImageBytes(tooWide)).toThrow("image_dimensions_exceeded");
  const jpeg = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0, 2, 0, 3, 1, 255, 217]);
  expect(inspectImageBytes(jpeg)).toEqual({ mimeType: "image/jpeg", width: 3, height: 2 });
  const webp = new Uint8Array(30);
  webp.set(Buffer.from("RIFF"), 0);
  webp.set(Buffer.from("WEBPVP8 "), 8);
  new DataView(webp.buffer).setUint32(4, 22, true);
  webp.set([157, 1, 42, 3, 0, 2, 0], 23);
  expect(inspectImageBytes(webp)).toEqual({ mimeType: "image/webp", width: 3, height: 2 });
});
