import { record } from "../../json";

export interface TelegramUpdate {
  update_id: number;
  message?: unknown;
}

export const MAX_TELEGRAM_IMAGE_BYTES = 5 * 1024 * 1024;

export interface TelegramTransport {
  inspect(signal: AbortSignal): Promise<{ botId: string; webhookActive: boolean }>;
  getUpdates(input: {
    offset: number;
    timeoutSeconds: number;
    signal: AbortSignal;
  }): Promise<TelegramUpdate[]>;
  downloadImage(input: { fileId: string; signal: AbortSignal }): Promise<Uint8Array>;
  sendMessage(input: {
    chatId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ messageId: string }>;
  editMessageText?(input: {
    chatId: string;
    messageId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ messageId: string; unchanged: boolean }>;
  sendPhoto?(input: {
    chatId: string;
    bytes: Uint8Array;
    replyToMessageId: string;
    signal: AbortSignal;
  }): Promise<{ messageId: string }>;
}

export class TelegramError extends Error {
  constructor(
    public readonly code:
      | "configuration"
      | "network"
      | "deadline"
      | "cancelled"
      | "rate_limited"
      | "unauthorized"
      | "conflict"
      | "rejected"
      | "server"
      | "invalid_response"
      | "image_too_large"
      | "invalid_file_path",
    /** Only an explicit rejection proves that Telegram did not send the message. */
    public readonly definitive = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram request failed: ${code}.`);
    this.name = "TelegramError";
  }
}

/** Bound even an injected transport that does not implement cancellation correctly. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new TelegramError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new TelegramError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw new TelegramError("invalid_response");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof TelegramError) throw error;
    throw new TelegramError("invalid_response");
  } finally {
    reader.releaseLock();
  }
}

async function boundedImage(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (
    lengthHeader !== null &&
    (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > MAX_TELEGRAM_IMAGE_BYTES)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new TelegramError("image_too_large", true);
  }
  if (!response.body) throw new TelegramError("invalid_response", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_TELEGRAM_IMAGE_BYTES) throw new TelegramError("image_too_large", true);
      chunks.push(value);
    }
    if (!length) throw new TelegramError("invalid_response", true);
    return Buffer.concat(chunks);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Telegram paths are data, never origins, absolute paths or encoded URL syntax. */
function validFilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}

export function createTelegramTransport(options: {
  token: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sendTimeoutMs?: number;
  downloadTimeoutMs?: number;
}): TelegramTransport & Required<Pick<TelegramTransport, "sendPhoto" | "editMessageText">> {
  const sendTimeoutMs = options.sendTimeoutMs ?? 20_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 20_000;
  if (
    !/^\d+:[A-Za-z0-9_-]+$/.test(options.token) ||
    !Number.isInteger(sendTimeoutMs) ||
    sendTimeoutMs < 1 ||
    sendTimeoutMs > 30_000 ||
    !Number.isInteger(downloadTimeoutMs) ||
    downloadTimeoutMs < 1 ||
    downloadTimeoutMs > 30_000
  ) {
    throw new TelegramError("configuration", true);
  }
  const transport = options.fetch ?? fetch;
  const unchangedEdit = Symbol("telegram_edit_already_matches");

  async function request(
    method:
      | "getUpdates"
      | "sendMessage"
      | "sendPhoto"
      | "getMe"
      | "getWebhookInfo"
      | "getFile"
      | "editMessageText",
    body: Record<string, unknown> | FormData,
    parentSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<unknown> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([parentSignal, deadline]);
    try {
      signal.throwIfAborted();
      const response = await abortable(
        transport(`https://api.telegram.org/bot${options.token}/${method}`, {
          method: "POST",
          redirect: "error",
          headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
          body: body instanceof FormData ? body : JSON.stringify(body),
          signal,
        }),
        signal,
      );
      // A server/proxy failure may follow a successful send. Never infer rejection.
      if (response.status >= 500) {
        void response.body?.cancel().catch(() => {});
        throw new TelegramError("server");
      }
      const data = record(await boundedJson(response, signal));
      if (data.ok !== true) {
        const code = data.error_code;
        if (data.ok !== false || !Number.isInteger(code)) {
          throw new TelegramError("invalid_response");
        }
        // Retrying the same edit cannot create another message. Telegram's exact
        // rejection establishes that its current text already equals this request.
        if (
          method === "editMessageText" &&
          response.status === 400 &&
          code === 400 &&
          typeof data.description === "string" &&
          /^Bad Request: message is not modified(?:$|:)/.test(data.description)
        )
          return unchangedEdit;
        if (code === 429) {
          const retryAfter = record(data.parameters).retry_after;
          throw new TelegramError(
            "rate_limited",
            true,
            typeof retryAfter === "number" &&
              Number.isSafeInteger(retryAfter) &&
              retryAfter >= 1 &&
              retryAfter <= 86_400
              ? retryAfter
              : undefined,
          );
        }
        if (code === 401 || code === 403) throw new TelegramError("unauthorized", true);
        if (code === 409) throw new TelegramError("conflict", true);
        if (typeof code === "number" && code >= 400 && code < 500) {
          throw new TelegramError("rejected", true);
        }
        throw new TelegramError("server");
      }
      if (!response.ok) throw new TelegramError("invalid_response");
      return data.result;
    } catch (error) {
      if (parentSignal.aborted) throw new TelegramError("cancelled");
      if (deadline.aborted) throw new TelegramError("deadline");
      if (error instanceof TelegramError) throw error;
      // Never retain raw errors: fetch errors can include the token-bearing URL.
      throw new TelegramError("network");
    }
  }

  return {
    async editMessageText(input) {
      if (
        !/^[1-9]\d*$/.test(input.chatId) ||
        !/^[1-9]\d*$/.test(input.messageId) ||
        !Number.isSafeInteger(Number(input.messageId)) ||
        !input.text.trim() ||
        input.text.length > 4096 ||
        /[\uD800-\uDFFF]/u.test(input.text)
      )
        throw new TelegramError("configuration", true);
      const response = await request(
        "editMessageText",
        {
          chat_id: input.chatId,
          message_id: Number(input.messageId),
          text: input.text,
        },
        input.signal,
        sendTimeoutMs,
      );
      if (response === unchangedEdit) return { messageId: input.messageId, unchanged: true };
      const result = record(response);
      if (
        String(result.message_id) !== input.messageId ||
        String(record(result.chat).id) !== input.chatId ||
        result.text !== input.text
      )
        throw new TelegramError("invalid_response");
      return { messageId: input.messageId, unchanged: false };
    },
    async inspect(signal) {
      const bot = record(await request("getMe", {}, signal, 15_000));
      if (
        typeof bot.id !== "number" ||
        !Number.isSafeInteger(bot.id) ||
        bot.id < 1 ||
        bot.is_bot !== true ||
        String(bot.id) !== options.token.split(":")[0]
      ) {
        throw new TelegramError("invalid_response");
      }
      const webhook = record(await request("getWebhookInfo", {}, signal, 15_000));
      if (typeof webhook.url !== "string") throw new TelegramError("invalid_response");
      return { botId: String(bot.id), webhookActive: Boolean(webhook.url) };
    },
    async getUpdates(input) {
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isInteger(input.timeoutSeconds) ||
        input.timeoutSeconds < 1 ||
        input.timeoutSeconds > 30
      ) {
        throw new TelegramError("configuration", true);
      }
      const result = await request(
        "getUpdates",
        {
          offset: input.offset,
          limit: 100,
          timeout: input.timeoutSeconds,
          allowed_updates: ["message"],
        },
        input.signal,
        (input.timeoutSeconds + 5) * 1000,
      );
      if (
        !Array.isArray(result) ||
        result.length > 100 ||
        result.some((item) => {
          const id = record(item).update_id;
          return typeof id !== "number" || !Number.isSafeInteger(id) || id < 0;
        })
      ) {
        throw new TelegramError("invalid_response");
      }
      return result as TelegramUpdate[];
    },
    async downloadImage(input) {
      if (!input.fileId || input.fileId.length > 1024 || /[\s\p{Cc}]/u.test(input.fileId))
        throw new TelegramError("configuration", true);
      const deadline = AbortSignal.timeout(downloadTimeoutMs);
      const signal = AbortSignal.any([input.signal, deadline]);
      try {
        signal.throwIfAborted();
        const file = record(
          await request("getFile", { file_id: input.fileId }, signal, downloadTimeoutMs),
        );
        if (!validFilePath(file.file_path)) throw new TelegramError("invalid_file_path", true);
        if (
          file.file_size !== undefined &&
          (typeof file.file_size !== "number" ||
            !Number.isSafeInteger(file.file_size) ||
            file.file_size < 1 ||
            file.file_size > MAX_TELEGRAM_IMAGE_BYTES)
        ) {
          throw new TelegramError("image_too_large", true);
        }
        const response = await abortable(
          transport(`https://api.telegram.org/file/bot${options.token}/${file.file_path}`, {
            method: "GET",
            redirect: "error",
            signal,
          }),
          signal,
        );
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          // Downloading has no delivery side effect. A retry obtains a fresh getFile URL.
          if (response.status === 429) {
            const retry = response.headers.get("retry-after");
            throw new TelegramError(
              "rate_limited",
              true,
              retry !== null && /^\d+$/.test(retry) && Number(retry) <= 86400
                ? Number(retry)
                : undefined,
            );
          }
          throw new TelegramError(
            response.status >= 500 ? "server" : "rejected",
            response.status < 500,
          );
        }
        return await boundedImage(response, signal);
      } catch (error) {
        if (input.signal.aborted) throw new TelegramError("cancelled");
        if (deadline.aborted) throw new TelegramError("deadline");
        if (error instanceof TelegramError) throw error;
        throw new TelegramError("network");
      }
    },
    async sendPhoto(input) {
      if (!/^[1-9]\d*$/.test(input.chatId) || !/^[1-9]\d*$/.test(input.replyToMessageId))
        throw new TelegramError("configuration", true);
      if (!input.bytes.length || input.bytes.length > MAX_TELEGRAM_IMAGE_BYTES)
        throw new TelegramError("image_too_large", true);
      const body = new FormData();
      body.set("chat_id", input.chatId);
      body.set(
        "photo",
        new Blob([new Uint8Array(input.bytes)], { type: "image/png" }),
        "valerie.png",
      );
      body.set(
        "reply_parameters",
        JSON.stringify({
          message_id: Number(input.replyToMessageId),
          allow_sending_without_reply: true,
        }),
      );
      const result = record(await request("sendPhoto", body, input.signal, sendTimeoutMs));
      if (
        typeof result.message_id !== "number" ||
        !Number.isSafeInteger(result.message_id) ||
        result.message_id < 1 ||
        String(record(result.chat).id) !== input.chatId ||
        !Array.isArray(result.photo) ||
        result.photo.length === 0
      )
        throw new TelegramError("invalid_response");
      return { messageId: String(result.message_id) };
    },
    async sendMessage(input) {
      if (!/^\d+$/.test(input.chatId) || !input.text.trim() || input.text.length > 4096) {
        throw new TelegramError("configuration", true);
      }
      const result = record(
        await request(
          "sendMessage",
          { chat_id: input.chatId, text: input.text },
          input.signal,
          sendTimeoutMs,
        ),
      );
      if (
        typeof result.message_id !== "number" ||
        !Number.isSafeInteger(result.message_id) ||
        result.message_id < 1 ||
        String(record(result.chat).id) !== input.chatId
      ) {
        throw new TelegramError("invalid_response");
      }
      return { messageId: String(result.message_id) };
    },
  };
}

/** Keep authored text exact; prefer paragraph/word boundaries and keep surrogate pairs intact. */
export function splitTelegramText(text: string): string[] {
  if (!text.trim()) throw new TelegramError("configuration", true);
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 4096) {
    let end = 4096;
    const prefix = remaining.slice(0, end);
    const boundary = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
    if (boundary > 2048) end = boundary + 1;
    const last = remaining.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  if (chunks.some((chunk) => !chunk.trim())) throw new TelegramError("configuration", true);
  return chunks;
}
