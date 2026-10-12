import type { NeuralwattModel } from "./models";
import { parseToolCalls, type WireToolCall, wireToolCall } from "./tools";
import { InferenceError, safeIdPattern } from "./transport";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

export const MAX_INFERENCE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INFERENCE_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_INFERENCE_IMAGES = 20;
// A budgeting allowance, not an exact image tokenizer or a charge estimate.
export const INFERENCE_IMAGE_TOKEN_ALLOWANCE = 8192;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_CONTENT_PARTS = 40;

function imageBytes(url: unknown): number {
  if (typeof url !== "string" || url.length > Math.ceil(MAX_INFERENCE_IMAGE_BYTES / 3) * 4 + 40)
    throw new InferenceError("configuration");
  const prefix = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(url);
  if (!prefix) throw new InferenceError("configuration");
  const encoded = url.slice(prefix[0].length);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (
    !encoded.length ||
    encoded.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(encoded) ||
    (padding > 0 ? encoded.indexOf("=") !== encoded.length - padding : encoded.includes("=")) ||
    (encoded.length / 4) * 3 - padding > MAX_INFERENCE_IMAGE_BYTES
  )
    throw new InferenceError("configuration");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new InferenceError("configuration");
  const signatureMatches =
    (prefix[1] === "image/png" &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (prefix[1] === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (prefix[1] === "image/webp" &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP");
  if (!signatureMatches) throw new InferenceError("configuration");
  return bytes.byteLength;
}

/** Validate and copy only allowlisted fields; URLs must contain private image bytes. */
export function prepareMessages(
  messages: ChatMessage[],
  model: NeuralwattModel | null,
): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 2000)
    throw new InferenceError("configuration");
  let textBytes = 0;
  let imageCount = 0;
  let totalImageBytes = 0;
  const pendingCalls = new Set<string>();
  const seenCalls = new Set<string>();
  const text = (content: string): string => {
    if (typeof content !== "string") throw new InferenceError("configuration");
    textBytes += Buffer.byteLength(content, "utf8");
    if (textBytes > MAX_TEXT_BYTES) throw new InferenceError("configuration");
    return content;
  };
  const prepared = messages.map((message): ChatMessage => {
    if (!message || !["system", "user", "assistant", "tool"].includes(message.role))
      throw new InferenceError("configuration");
    if (message.role === "tool") {
      if (
        !model?.tools ||
        typeof message.tool_call_id !== "string" ||
        !safeIdPattern.test(message.tool_call_id) ||
        !pendingCalls.delete(message.tool_call_id) ||
        typeof message.content !== "string" ||
        message.tool_calls !== undefined
      )
        throw new InferenceError("configuration");
      return { role: "tool", content: text(message.content), tool_call_id: message.tool_call_id };
    }
    if (pendingCalls.size || message.tool_call_id !== undefined)
      throw new InferenceError("configuration");
    if (message.tool_calls !== undefined) {
      if (!model?.tools || message.role !== "assistant" || typeof message.content !== "string")
        throw new InferenceError("configuration");
      const calls = parseToolCalls(message.tool_calls, "configuration");
      for (const call of calls) {
        if (seenCalls.has(call.id)) throw new InferenceError("configuration");
        seenCalls.add(call.id);
        pendingCalls.add(call.id);
        text(call.arguments);
      }
      return {
        role: "assistant",
        content: text(message.content),
        tool_calls: calls.map(wireToolCall),
      };
    }
    if (typeof message.content === "string")
      return { role: message.role, content: text(message.content) };
    if (
      !Array.isArray(message.content) ||
      message.content.length === 0 ||
      message.content.length > MAX_CONTENT_PARTS
    )
      throw new InferenceError("configuration");
    const content = message.content.map((part): ChatContentPart => {
      if (part?.type === "text") return { type: "text", text: text(part.text) };
      if (
        part?.type !== "image_url" ||
        message.role !== "user" ||
        !model?.vision ||
        !model.maxImages
      )
        throw new InferenceError("configuration");
      imageCount++;
      if (imageCount > Math.min(MAX_INFERENCE_IMAGES, model.maxImages))
        throw new InferenceError("configuration");
      const bytes = imageBytes(part.image_url?.url);
      totalImageBytes += bytes;
      if (totalImageBytes > MAX_INFERENCE_TOTAL_IMAGE_BYTES)
        throw new InferenceError("configuration");
      return { type: "image_url", image_url: { url: part.image_url.url } };
    });
    return { role: message.role, content };
  });
  if (pendingCalls.size) throw new InferenceError("configuration");
  return prepared;
}

/** Conservative byte-based heuristic for prose and JSON; not a tokenizer. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

/** Text heuristic plus a fixed per-image allowance; never count base64 as prose. */
export function estimateMessageTokens(messages: readonly ChatMessage[]): number {
  return (
    128 +
    messages.reduce((sum, message) => {
      const content =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      return (
        sum +
        16 +
        (message.tool_calls ? estimateTextTokens(JSON.stringify(message.tool_calls)) : 0) +
        content.reduce(
          (tokens, part) =>
            tokens +
            (part.type === "text"
              ? estimateTextTokens(part.text)
              : INFERENCE_IMAGE_TOKEN_ALLOWANCE),
          0,
        )
      );
    }, 0)
  );
}
