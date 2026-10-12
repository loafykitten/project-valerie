import { isRecord } from "../../guards";

/** Transport attribution is evidence metadata, not proof that prose is a current owner fact. */
export interface TelegramSourceMetadata {
  version: 1;
  provenance: "original" | "forwarded" | "unknown";
  /** Telegram entity offsets address UTF-16 code units in the archived input text. */
  quotedRanges: { offset: number; length: number }[];
  /** A quoted earlier reply is separate from the owner's current text. */
  replyQuote: { text: string } | null;
  /** Same-chat Telegram reply target; it does not make the owner's new text a quotation. */
  replyToMessageId?: string;
  incomplete: boolean;
}

/** Validate UTF-16 ranges against full text before persistence. A numeric argument is only
 * an upper bound for reading already-validated metadata without hydrating archived prose. */
export function validateTelegramSourceMetadata(
  value: unknown,
  text: string | number,
): TelegramSourceMetadata | null {
  if (value === undefined || value === null) return null;
  const invalid = () => new TypeError("Telegram source metadata is invalid.");
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !["original", "forwarded", "unknown"].includes(String(value.provenance)) ||
    !Array.isArray(value.quotedRanges) ||
    value.quotedRanges.length > 16 ||
    typeof value.incomplete !== "boolean" ||
    (value.replyToMessageId !== undefined &&
      (typeof value.replyToMessageId !== "string" || !/^\d{1,30}$/.test(value.replyToMessageId))) ||
    (value.replyQuote !== null &&
      (!isRecord(value.replyQuote) ||
        typeof value.replyQuote.text !== "string" ||
        value.replyQuote.text.length > 1024))
  )
    throw invalid();
  const quotedRanges = value.quotedRanges.map((range) => {
    if (
      !isRecord(range) ||
      !Number.isSafeInteger(range.offset) ||
      Number(range.offset) < 0 ||
      !Number.isSafeInteger(range.length) ||
      Number(range.length) < 1 ||
      Number(range.offset) + Number(range.length) > (typeof text === "string" ? text.length : text)
    )
      throw invalid();
    return { offset: Number(range.offset), length: Number(range.length) };
  });
  return {
    version: 1,
    provenance: value.provenance as TelegramSourceMetadata["provenance"],
    quotedRanges,
    replyQuote: value.replyQuote === null ? null : { text: String(value.replyQuote.text) },
    ...(value.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: value.replyToMessageId as string }),
    incomplete: value.incomplete,
  };
}

export function readTelegramSourceMetadata(
  json: string | null,
  text: string | number,
): TelegramSourceMetadata | null {
  if (!json) return null;
  try {
    return validateTelegramSourceMetadata(JSON.parse(json), text);
  } catch {
    return {
      version: 1,
      provenance: "unknown",
      quotedRanges: [],
      replyQuote: null,
      incomplete: true,
    };
  }
}
