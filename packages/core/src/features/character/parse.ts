import { createHash } from "node:crypto";
import { isRecord } from "../../guards";

const maxSourceBytes = 16 * 1024 * 1024;
const maxMetadataBytes = 1024 * 1024;
const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const stringFields = [
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
] as const;

export type CharacterCardFields = Partial<Record<(typeof stringFields)[number], string>>;

export interface CharacterCardPreview {
  format: "png" | "json";
  metadataKeyword: "ccv3" | "chara" | null;
  /** Copy of the complete source. Persist these bytes before any explicit import. */
  originalBytes: Uint8Array;
  sha256: string;
  /** Exact decoded JSON text, including its formatting and unknown fields. */
  jsonText: string;
  /** Complete decoded object. No macros, names, or unknown fields are rewritten. */
  card: Record<string, unknown>;
  /** A convenience view only. These fields are not automatically mapped to prompts. */
  fields: CharacterCardFields;
}

export class CharacterCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterCardError";
  }
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  // biome-ignore lint/style/noNonNullAssertion: The 256-entry CRC table is indexed by one byte.
  for (const value of bytes) crc = crcTable[(crc ^ value) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeMetadata(bytes: Uint8Array): string {
  // The text inside chara/ccv3 tEXt is base64-encoded UTF-8 JSON.
  if (bytes.length > Math.ceil(maxMetadataBytes / 3) * 4 + 4096) {
    throw new CharacterCardError("Character metadata exceeds the 1 MiB limit.");
  }
  const encoded = decoder.decode(bytes).replace(/[\t\r\n ]/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new CharacterCardError("Character metadata is not valid base64.");
  }
  const decoded = Buffer.from(encoded, "base64");
  // Buffer's decoder is permissive, so compare a canonical round trip as well.
  if (decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new CharacterCardError("Character metadata is not valid base64.");
  }
  if (decoded.length > maxMetadataBytes)
    throw new CharacterCardError("Character metadata exceeds the 1 MiB limit.");
  return decoder.decode(decoded);
}

function readPng(bytes: Uint8Array): { keyword: "ccv3" | "chara"; jsonText: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadata = new Map<"ccv3" | "chara", Uint8Array>();
  let offset = pngSignature.length;
  let first = true;
  let sawImage = false;
  let sawEnd = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new CharacterCardError("PNG contains a truncated chunk.");
    const length = view.getUint32(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) throw new CharacterCardError("PNG contains a truncated chunk.");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, dataStart));
    if (!/^[A-Za-z]{4}$/.test(type))
      throw new CharacterCardError("PNG contains an invalid chunk type.");
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== view.getUint32(dataEnd)) {
      throw new CharacterCardError(`PNG ${type} chunk failed its checksum.`);
    }
    if (first) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        view.getUint32(dataStart) === 0 ||
        view.getUint32(dataStart + 4) === 0
      ) {
        throw new CharacterCardError("PNG must begin with a valid IHDR chunk.");
      }
      first = false;
    } else if (type === "IHDR") {
      throw new CharacterCardError("PNG contains more than one IHDR chunk.");
    }
    if (type === "IDAT") sawImage = true;
    if (type === "tEXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      const separator = data.indexOf(0);
      if (separator > 0 && separator <= 79) {
        const keyword = String.fromCharCode(...data.subarray(0, separator));
        if (keyword === "chara" || keyword === "ccv3") {
          if (metadata.has(keyword))
            throw new CharacterCardError(`PNG contains ambiguous duplicate ${keyword} metadata.`);
          metadata.set(keyword, data.subarray(separator + 1));
        }
      }
    }
    offset = chunkEnd;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length)
        throw new CharacterCardError("PNG has invalid data after its end marker.");
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || !sawImage)
    throw new CharacterCardError("PNG is missing image data or its end marker.");
  // v3 takes precedence when an export carries both v2 and v3 metadata.
  const keyword = metadata.has("ccv3") ? "ccv3" : "chara";
  const payload = metadata.get(keyword);
  if (!payload) throw new CharacterCardError("PNG has no chara or ccv3 character metadata.");
  return { keyword, jsonText: decodeMetadata(payload) };
}

/** Parse only: this function cannot mutate prompts or other durable state. */
export function parseCharacterCard(source: Uint8Array): CharacterCardPreview {
  if (!(source instanceof Uint8Array) || source.length === 0 || source.length > maxSourceBytes) {
    throw new CharacterCardError(
      "Provide a nonempty character PNG or JSON file of at most 16 MiB.",
    );
  }
  try {
    const originalBytes = new Uint8Array(source);
    const isPng = pngSignature.every((value, index) => originalBytes[index] === value);
    let jsonText: string;
    let metadataKeyword: CharacterCardPreview["metadataKeyword"] = null;
    if (isPng) {
      const metadata = readPng(originalBytes);
      jsonText = metadata.jsonText;
      metadataKeyword = metadata.keyword;
    } else {
      if (originalBytes.length > maxMetadataBytes)
        throw new CharacterCardError("Character JSON exceeds the 1 MiB limit.");
      jsonText = decoder.decode(originalBytes);
    }
    const card: unknown = JSON.parse(jsonText);
    if (!isRecord(card)) throw new CharacterCardError("Character JSON must contain an object.");
    let data = card;
    if (card.spec !== undefined) {
      if (card.spec !== "chara_card_v2" && card.spec !== "chara_card_v3") {
        throw new CharacterCardError(
          `Unsupported character card specification: ${String(card.spec)}.`,
        );
      }
      if (!isRecord(card.data))
        throw new CharacterCardError("Character card data must contain an object.");
      data = card.data;
    }
    const fields: CharacterCardFields = {};
    for (const field of stringFields) {
      const value = data[field];
      if (value !== undefined) {
        if (typeof value !== "string")
          throw new CharacterCardError(`Character field '${field}' must be text.`);
        fields[field] = value;
      }
    }
    if (Object.keys(fields).length === 0)
      throw new CharacterCardError("No recognized character text fields were found.");
    return {
      format: isPng ? "png" : "json",
      metadataKeyword,
      originalBytes,
      sha256: createHash("sha256").update(originalBytes).digest("hex"),
      jsonText,
      card,
      fields,
    };
  } catch (error) {
    if (error instanceof CharacterCardError) throw error;
    throw new CharacterCardError(
      error instanceof SyntaxError
        ? "Character metadata is not valid JSON."
        : "Character metadata is not valid UTF-8 text.",
    );
  }
}
