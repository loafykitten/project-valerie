import type { TelegramSourceMetadata } from "@valerie/core";
import { record } from "../../json";

/** Keep bounded attribution flags and quote ranges, never forwarding identities or arbitrary metadata. */
export function telegramSourceMetadata(
  message: Record<string, unknown>,
  text: string,
  imageMessage: boolean,
): TelegramSourceMetadata {
  const forwarded =
    message.forward_origin != null ||
    message.is_automatic_forward === true ||
    ["forward_date", "forward_from", "forward_from_chat", "forward_sender_name"].some(
      (key) => message[key] != null,
    );
  const rawEntities = imageMessage ? message.caption_entities : message.entities;
  let incomplete = rawEntities != null && !Array.isArray(rawEntities);
  const quotedRanges: TelegramSourceMetadata["quotedRanges"] = [];
  if (Array.isArray(rawEntities)) {
    if (rawEntities.length > 128) incomplete = true;
    for (const raw of rawEntities.slice(0, 128)) {
      const entity = record(raw);
      if (entity.type !== "blockquote" && entity.type !== "expandable_blockquote") continue;
      if (
        !Number.isSafeInteger(entity.offset) ||
        Number(entity.offset) < 0 ||
        !Number.isSafeInteger(entity.length) ||
        Number(entity.length) < 1 ||
        Number(entity.offset) + Number(entity.length) > text.length ||
        quotedRanges.length === 16
      ) {
        incomplete = true;
        continue;
      }
      quotedRanges.push({ offset: Number(entity.offset), length: Number(entity.length) });
    }
  }
  let replyQuote: TelegramSourceMetadata["replyQuote"] = null;
  const reply = record(message.reply_to_message);
  const currentChat = record(message.chat);
  const replyChat = record(reply.chat);
  const replyToMessageId =
    Number.isSafeInteger(reply.message_id) &&
    Number(reply.message_id) > 0 &&
    (replyChat.id === undefined || replyChat.id === currentChat.id)
      ? String(reply.message_id)
      : undefined;
  if (message.quote != null) {
    const quote = record(message.quote);
    if (typeof quote.text === "string") {
      replyQuote = { text: quote.text.slice(0, 1024) };
      if (quote.text.length > 1024) incomplete = true;
    } else incomplete = true;
  }
  return {
    version: 1,
    provenance: forwarded ? "forwarded" : "original",
    quotedRanges,
    replyQuote,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    incomplete,
  };
}
