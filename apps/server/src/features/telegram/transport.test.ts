import { describe, expect, test } from "bun:test";
import {
  createTelegramTransport,
  MAX_TELEGRAM_IMAGE_BYTES,
  splitTelegramText,
  TelegramError,
} from "./transport";
import { ownerMessageInputs } from "./worker";

const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("Telegram transport", () => {
  test("uploads private PNG bytes and confirms a photo in the originating chat", async () => {
    let form: FormData | undefined;
    const client = createTelegramTransport({
      token: "123:fictional",
      fetch: async (url, init) => {
        expect(url.endsWith("/sendPhoto")).toBe(true);
        expect(init.redirect).toBe("error");
        form = init.body as FormData;
        return json({
          ok: true,
          result: { message_id: 51, chat: { id: 42 }, photo: [{ file_id: "photo" }] },
        });
      },
    });
    expect(
      await client.sendPhoto({
        chatId: "42",
        bytes: new Uint8Array([1, 2, 3]),
        replyToMessageId: "12",
        signal: signal(),
      }),
    ).toEqual({ messageId: "51" });
    expect(form?.get("chat_id")).toBe("42");
    expect(JSON.parse(String(form?.get("reply_parameters")))).toEqual({
      message_id: 12,
      allow_sending_without_reply: true,
    });
    if (!form) throw new Error("Photo upload was not captured.");
    expect(await (form.get("photo") as Blob).arrayBuffer()).toEqual(
      new Uint8Array([1, 2, 3]).buffer,
    );
    expect(form?.has("caption")).toBe(false);
  });

  test("does not treat a text-only, wrong-chat, or lost photo receipt as delivery", async () => {
    for (const result of [
      { message_id: 51, chat: { id: 42 } },
      { message_id: 51, chat: { id: 99 }, photo: [{}] },
    ]) {
      const client = createTelegramTransport({
        token: "123:fictional",
        fetch: async () => json({ ok: true, result }),
      });
      await expect(
        client.sendPhoto({
          chatId: "42",
          bytes: new Uint8Array([1]),
          replyToMessageId: "12",
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: "invalid_response", definitive: false });
    }
  });
  test("polls only message updates and sends exact plain text with a confirmed receipt", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const client = createTelegramTransport({
      token: "123:fictional",
      fetch: async (url, init) => {
        const method = url.split("/").at(-1) ?? "";
        calls.push({ method, body: JSON.parse(String(init.body)) });
        if (method === "getUpdates") return json({ ok: true, result: [{ update_id: 42 }] });
        return json({ ok: true, result: { message_id: 12, chat: { id: 42 } } });
      },
    });
    expect(await client.getUpdates({ offset: 42, timeoutSeconds: 25, signal: signal() })).toEqual([
      { update_id: 42 },
    ]);
    expect(
      await client.sendMessage({ chatId: "42", text: "*smiles* A & B", signal: signal() }),
    ).toEqual({ messageId: "12" });
    expect(calls).toEqual([
      {
        method: "getUpdates",
        body: { offset: 42, limit: 100, timeout: 25, allowed_updates: ["message"] },
      },
      { method: "sendMessage", body: { chat_id: "42", text: "*smiles* A & B" } },
    ]);
  });

  test("checks bot identity and existing webhook without deleting it", async () => {
    const calls: string[] = [];
    const client = createTelegramTransport({
      token: "123:fictional",
      fetch: async (url) => {
        const method = url.split("/").at(-1) ?? "";
        calls.push(method);
        return json({
          ok: true,
          result:
            method === "getMe"
              ? { id: 123, is_bot: true }
              : { url: "https://fictional.example/webhook" },
        });
      },
    });
    expect(await client.inspect(signal())).toEqual({ botId: "123", webhookActive: true });
    expect(calls).toEqual(["getMe", "getWebhookInfo"]);
  });

  test("treats network, server, malformed and mismatched receipts as ambiguous", async () => {
    for (const response of [
      () => {
        throw new Error("secret token URL");
      },
      () => new Response("secret", { status: 503 }),
      () => json({ ok: true, result: {} }),
      () => json({ ok: true, result: { message_id: 2, chat: { id: 999 } } }),
    ]) {
      const client = createTelegramTransport({
        token: "123:fictional",
        fetch: async () => response(),
      });
      try {
        await client.sendMessage({ chatId: "42", text: "Hello", signal: signal() });
        throw new Error("Expected a transport error");
      } catch (error) {
        expect(error).toBeInstanceOf(TelegramError);
        expect((error as TelegramError).definitive).toBe(false);
        expect(String(error)).not.toContain("secret");
      }
    }
  });

  test("only explicit rate limits expose a safe retry delay", async () => {
    const client = createTelegramTransport({
      token: "123:fictional",
      fetch: async () =>
        json(
          { ok: false, error_code: 429, parameters: { retry_after: 7 }, description: "private" },
          429,
        ),
    });
    await expect(
      client.sendMessage({ chatId: "42", text: "Hello", signal: signal() }),
    ).rejects.toMatchObject({ code: "rate_limited", definitive: true, retryAfterSeconds: 7 });
  });

  test("aborts and times out transports that ignore cancellation", async () => {
    const controller = new AbortController();
    const client = createTelegramTransport({
      token: "123:fictional",
      sendTimeoutMs: 10,
      fetch: () => new Promise<Response>(() => {}),
    });
    const pending = client.sendMessage({ chatId: "42", text: "Hello", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled", definitive: false });
    await expect(
      client.sendMessage({ chatId: "42", text: "Hello", signal: signal() }),
    ).rejects.toMatchObject({ code: "deadline", definitive: false });
  });

  test("splits long text exactly without breaking surrogate pairs", () => {
    const text = `${"a".repeat(4095)}😀\n${"*looks over* ".repeat(800)}`;
    const chunks = splitTelegramText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true);
  });

  test("accepts only exact owner private-chat text and ignores edits and bots", () => {
    const message = {
      message_id: 5,
      date: 10,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
      text: "*hello*",
    };
    const inputs = ownerMessageInputs(
      [
        { update_id: 1, message },
        { update_id: 2, message: { ...message, from: { id: 999, is_bot: false } } },
        { update_id: 3, message: { ...message, from: { id: 42, is_bot: true } } },
        { update_id: 4, message: { ...message, chat: { id: 42, type: "group" } } },
        { update_id: 5, message: { ...message, chat: { id: 999, type: "private" } } },
        { update_id: 6 },
        { update_id: 7, message: { ...message, text: undefined } },
      ],
      "42",
    );
    expect(inputs).toEqual([
      {
        updateId: 1,
        messageId: "5",
        chatId: "42",
        senderId: "42",
        text: "*hello*",
        receivedAt: "1970-01-01T00:00:10.000Z",
        sourceMetadata: {
          version: 1,
          provenance: "original",
          quotedRanges: [],
          replyQuote: null,
          incomplete: false,
        },
      },
    ]);
  });

  test("downloads only the validated Telegram file path and returns bytes without its token URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    const client = createTelegramTransport({
      token: "123:fictional",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return url.endsWith("getFile")
          ? json({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: 3 } })
          : new Response(bytes);
      },
    });
    expect(await client.downloadImage({ fileId: "opaque-file=", signal: signal() })).toEqual(bytes);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.telegram.org/bot123:fictional/getFile",
      "https://api.telegram.org/file/bot123:fictional/photos/file_1.jpg",
    ]);
    expect(calls.every(({ init }) => init.redirect === "error")).toBe(true);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ file_id: "opaque-file=" });
  });

  test("rejects absolute, encoded and traversing file paths before download", async () => {
    for (const path of [
      "https://host.example/x",
      "//host.example/x",
      "../private",
      "photos/../private",
      "/etc/passwd",
      "photos/%2e%2e/private",
      "photos/file?token=x",
      "photos\\private",
    ]) {
      let calls = 0;
      const client = createTelegramTransport({
        token: "123:fictional",
        fetch: async () => {
          calls += 1;
          return json({ ok: true, result: { file_path: path } });
        },
      });
      await expect(
        client.downloadImage({ fileId: "photo", signal: signal() }),
      ).rejects.toMatchObject({ code: "invalid_file_path" });
      expect(calls).toBe(1);
    }
  });

  test("enforces declared and streamed download limits", async () => {
    for (const sizeLocation of ["file", "header", "stream"] as const) {
      let calls = 0;
      const client = createTelegramTransport({
        token: "123:fictional",
        fetch: async (url) => {
          calls += 1;
          if (url.endsWith("getFile"))
            return json({
              ok: true,
              result: {
                file_path: "photos/file.jpg",
                ...(sizeLocation === "file" ? { file_size: MAX_TELEGRAM_IMAGE_BYTES + 1 } : {}),
              },
            });
          if (sizeLocation === "header")
            return new Response("", {
              headers: { "content-length": String(MAX_TELEGRAM_IMAGE_BYTES + 1) },
            });
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(MAX_TELEGRAM_IMAGE_BYTES + 1));
                controller.close();
              },
            }),
          );
        },
      });
      await expect(
        client.downloadImage({ fileId: "photo", signal: signal() }),
      ).rejects.toMatchObject({ code: "image_too_large" });
      expect(calls).toBe(sizeLocation === "file" ? 1 : 2);
    }
  });

  test("bounds stalled file downloads and sanitizes network errors", async () => {
    const client = createTelegramTransport({
      token: "123:fictional",
      downloadTimeoutMs: 10,
      fetch: async (url) =>
        url.endsWith("getFile")
          ? json({ ok: true, result: { file_path: "photos/file.jpg" } })
          : new Promise<Response>(() => {}),
    });
    await expect(client.downloadImage({ fileId: "photo", signal: signal() })).rejects.toMatchObject(
      { code: "deadline" },
    );
    const broken = createTelegramTransport({
      token: "123:fictional",
      fetch: async () => {
        throw new Error("private URL and token");
      },
    });
    try {
      await broken.downloadImage({ fileId: "photo", signal: signal() });
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramError);
      expect(String(error)).not.toContain("private");
    }
  });

  test("accepts owner photos and image documents with exact captions and album identity", () => {
    const base = {
      message_id: 5,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
    };
    const photo = {
      file_id: "large",
      file_unique_id: "unique-large",
      width: 1200,
      height: 800,
      file_size: 1000,
    };
    const inputs = ownerMessageInputs(
      [
        {
          update_id: 1,
          message: {
            ...base,
            caption: "*Look* at this",
            media_group_id: "album-1",
            photo: [{ ...photo, file_id: "small", width: 100, height: 100 }, photo],
          },
        },
        {
          update_id: 2,
          message: {
            ...base,
            message_id: 6,
            document: {
              file_id: "png",
              file_unique_id: "unique-png",
              mime_type: "application/octet-stream",
              file_name: "Drawing.png",
            },
          },
        },
        {
          update_id: 3,
          message: {
            ...base,
            message_id: 7,
            document: { file_id: "gif", file_unique_id: "unique-gif", mime_type: "image/gif" },
            caption: "animation",
          },
        },
        {
          update_id: 4,
          message: {
            ...base,
            message_id: 8,
            document: {
              file_id: "huge",
              file_unique_id: "unique-huge",
              mime_type: "image/jpeg",
              file_size: MAX_TELEGRAM_IMAGE_BYTES + 1,
            },
          },
        },
      ],
      "42",
    );
    expect(inputs[0]).toMatchObject({
      text: "*Look* at this",
      mediaGroupId: "album-1",
      images: [{ fileId: "large" }],
    });
    expect(inputs[1]).toMatchObject({
      text: "",
      images: [{ fileId: "png", mimeType: "image/png" }],
    });
    expect(inputs[2]).toMatchObject({
      text: "animation",
      rejectionCode: "unsupported_image_format",
    });
    expect(inputs[3]).toMatchObject({ rejectionCode: "image_too_large" });
    expect(
      ownerMessageInputs(
        [{ update_id: 5, message: { ...base, from: { id: 999, is_bot: false }, photo: [photo] } }],
        "42",
      ),
    ).toEqual([]);
  });

  test("prefers the largest known bounded photo over an unknown-size variant", () => {
    const inputs = ownerMessageInputs(
      [
        {
          update_id: 1,
          message: {
            message_id: 1,
            from: { id: 42, is_bot: false },
            chat: { id: 42, type: "private" },
            photo: [
              {
                file_id: "known-small",
                file_unique_id: "small",
                width: 100,
                height: 100,
                file_size: 100,
              },
              {
                file_id: "known-medium",
                file_unique_id: "medium",
                width: 1000,
                height: 1000,
                file_size: 1000,
              },
              { file_id: "unknown-large", file_unique_id: "large", width: 2000, height: 2000 },
            ],
          },
        },
      ],
      "42",
    );
    expect(inputs[0]?.images?.[0]?.fileId).toBe("known-medium");
  });

  test("preserves unsupported owner album members and captions while ignoring standalone videos", () => {
    const base = {
      message_id: 1,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
    };
    const inputs = ownerMessageInputs(
      [
        {
          update_id: 1,
          message: {
            ...base,
            media_group_id: "mixed-album",
            caption: "  Compare *these*\nplease.  ",
            video: { file_id: "video" },
          },
        },
        {
          update_id: 2,
          message: {
            ...base,
            message_id: 2,
            media_group_id: "mixed-album",
            animation: { file_id: "animation" },
          },
        },
        {
          update_id: 3,
          message: {
            ...base,
            message_id: 3,
            media_group_id: "mixed-album",
            document: { file_id: "pdf", mime_type: "application/pdf" },
            caption: "document",
          },
        },
        {
          update_id: 4,
          message: { ...base, message_id: 4, video: { file_id: "standalone" }, caption: "ignored" },
        },
        {
          update_id: 5,
          message: {
            ...base,
            message_id: 5,
            media_group_id: "a".repeat(201),
            video: { file_id: "invalid-group" },
          },
        },
      ],
      "42",
    );
    expect(
      inputs.map((input) => ({
        text: input.text,
        mediaGroupId: input.mediaGroupId,
        rejectionCode: input.rejectionCode,
        images: input.images,
      })),
    ).toEqual([
      {
        text: "  Compare *these*\nplease.  ",
        mediaGroupId: "mixed-album",
        rejectionCode: "unsupported_album_media",
        images: undefined,
      },
      {
        text: "",
        mediaGroupId: "mixed-album",
        rejectionCode: "unsupported_album_media",
        images: undefined,
      },
      {
        text: "document",
        mediaGroupId: "mixed-album",
        rejectionCode: "unsupported_album_media",
        images: undefined,
      },
    ]);
  });
});
