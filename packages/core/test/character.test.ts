import { describe, expect, test } from "bun:test";
import { CharacterCardError, parseCharacterCard } from "../src";

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
  "base64",
);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function cardPng(json: string, keyword = "chara"): Buffer {
  const payload = Buffer.from(`${keyword}\0${Buffer.from(json).toString("base64")}`, "utf8");
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write("tEXt", 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  // Some broadly circulated one-pixel fixtures have a bad IDAT CRC; repair the
  // test image's chunk CRC independently so the parser must verify every chunk.
  const validImage = Buffer.from(image);
  for (let offset = 8; offset < validImage.length; ) {
    const length = validImage.readUInt32BE(offset);
    validImage.writeUInt32BE(
      crc32(validImage.subarray(offset + 4, offset + 8 + length)),
      offset + 8 + length,
    );
    offset += length + 12;
  }
  return Buffer.concat([validImage.subarray(0, 33), chunk, validImage.subarray(33)]);
}

describe("lossless character preview", () => {
  test("preserves PNG source, exact authored text, macros, and unknown card fields", () => {
    const authored = "  {{char}} knows {{user}}.\n*gentle smile* 💜\r\n";
    const raw = JSON.stringify(
      {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Val",
          description: authored,
          personality: "",
          extensions: { custom: ["untouched", 42] },
        },
        unknownRoot: { preserve: true },
      },
      null,
      2,
    );
    const bytes = cardPng(raw);
    const parsed = parseCharacterCard(bytes);
    expect(parsed.format).toBe("png");
    expect(parsed.metadataKeyword).toBe("chara");
    expect(Buffer.from(parsed.originalBytes).equals(bytes)).toBe(true);
    expect(parsed.jsonText).toBe(raw);
    expect(parsed.fields.description).toBe(authored);
    expect(parsed.fields.name).toBe("Val");
    expect(parsed.card).toEqual(JSON.parse(raw));
    expect(parsed.sha256).toHaveLength(64);
    bytes[0] = 0;
    expect(parsed.originalBytes[0]).toBe(137);
  });

  test("accepts v3 PNG and legacy raw JSON without importing anything", () => {
    const raw = '{ "name": "", "description": "exact \\n description", "custom": true }';
    const parsed = parseCharacterCard(Buffer.from(raw));
    expect(parsed.format).toBe("json");
    expect(parsed.jsonText).toBe(raw);
    expect(parsed.card.custom).toBe(true);
    const v3 = parseCharacterCard(
      cardPng(JSON.stringify({ spec: "chara_card_v3", data: { description: "v3" } }), "ccv3"),
    );
    expect(v3.metadataKeyword).toBe("ccv3");
    expect(v3.fields.description).toBe("v3");
  });

  test("rejects truncated, corrupted, unrecognized, and oversized input", () => {
    const bytes = cardPng('{"description":"Test"}');
    expect(() => parseCharacterCard(bytes.subarray(0, bytes.length - 2))).toThrow(
      CharacterCardError,
    );
    const corrupt = Buffer.from(bytes);
    corrupt[50] = corrupt.readUInt8(50) ^ 1;
    expect(() => parseCharacterCard(corrupt)).toThrow("checksum");
    expect(() => parseCharacterCard(Buffer.from("not a PNG"))).toThrow(CharacterCardError);
    expect(() => parseCharacterCard(Buffer.from('{"arbitrary":true}'))).toThrow("No recognized");
    expect(() => parseCharacterCard(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow("16 MiB");
  });
});
