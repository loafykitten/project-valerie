export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CONTEXT_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CURRENT_IMAGES = 10;
export const MAX_HISTORY_IMAGES = 4;
export const MAX_CONTEXT_IMAGES = 20;
/** A planning allowance until Neuralwatt exposes its image token calculation. */
export const IMAGE_TOKEN_ALLOWANCE = 8192;
export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export class ImageValidationError extends Error {
  constructor(
    readonly code:
      | "invalid_image"
      | "unsupported_image_format"
      | "image_too_large"
      | "image_dimensions_exceeded",
  ) {
    super(`Image validation failed: ${code}.`);
    this.name = "ImageValidationError";
  }
}

export interface ImageMetadata {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

/** Inspect bounded headers without decoding attacker-controlled image pixels. */
export function inspectImageBytes(bytes: Uint8Array): ImageMetadata {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0)
    throw new ImageValidationError("invalid_image");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageValidationError("image_too_large");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, text: string) =>
    offset + text.length <= bytes.length &&
    Array.from(text).every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  let metadata: ImageMetadata | undefined;
  if (bytes[0] === 137 && ascii(1, "PNG\r\n\x1a\n")) {
    if (bytes.length < 33 || data.getUint32(8) !== 13 || !ascii(12, "IHDR"))
      throw new ImageValidationError("invalid_image");
    metadata = { mimeType: "image/png", width: data.getUint32(16), height: data.getUint32(20) };
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    if (bytes.length < 4 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
      throw new ImageValidationError("invalid_image");
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) throw new ImageValidationError("invalid_image");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = data.getUint16(offset);
      if (length < 2 || offset + length > bytes.length)
        throw new ImageValidationError("invalid_image");
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) throw new ImageValidationError("invalid_image");
        metadata = {
          mimeType: "image/jpeg",
          width: data.getUint16(offset + 5),
          height: data.getUint16(offset + 3),
        };
        break;
      }
      offset += length;
    }
  } else if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (bytes.length < 30 || data.getUint32(4, true) + 8 !== bytes.length)
      throw new ImageValidationError("invalid_image");
    if (ascii(12, "VP8X")) {
      if (data.getUint32(16, true) !== 10) throw new ImageValidationError("invalid_image");
      if ((bytes[20] ?? 0) & 2) throw new ImageValidationError("unsupported_image_format");
      const uint24 = (offset: number) =>
        (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256 + (bytes[offset + 2] ?? 0) * 65536;
      metadata = { mimeType: "image/webp", width: uint24(24) + 1, height: uint24(27) + 1 };
    } else if (ascii(12, "VP8L") && bytes[20] === 47) {
      const dimensions = data.getUint32(21, true);
      metadata = {
        mimeType: "image/webp",
        width: (dimensions & 0x3fff) + 1,
        height: ((dimensions >>> 14) & 0x3fff) + 1,
      };
    } else if (ascii(12, "VP8 ") && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      metadata = {
        mimeType: "image/webp",
        width: data.getUint16(26, true) & 0x3fff,
        height: data.getUint16(28, true) & 0x3fff,
      };
    }
  } else {
    throw new ImageValidationError("unsupported_image_format");
  }
  if (!metadata || metadata.width < 1 || metadata.height < 1)
    throw new ImageValidationError("invalid_image");
  if (
    metadata.width > 8192 ||
    metadata.height > 8192 ||
    metadata.width * metadata.height > 32_000_000
  )
    throw new ImageValidationError("image_dimensions_exceeded");
  return metadata;
}
