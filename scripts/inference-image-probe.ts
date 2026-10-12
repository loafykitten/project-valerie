import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  createNeuralwattClient,
  discoverNeuralwattModels,
  InferenceError,
  inferenceTimeoutMs,
} from "../packages/inference/src";
import { printCatalogCheck, printInferenceProbeFailure } from "./probe-support";

/** Self-contained fictional raster; never reads user files, character data, or SQLite. */
function fictionalImage(): Uint8Array {
  const width = 320;
  const height = 160;
  const scanlines = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = y * (width * 3 + 1) + x * 3 + 1;
      const red = (x - 80) ** 2 + (y - 80) ** 2 <= 45 ** 2;
      const blue = x >= 205 && x <= 285 && y >= 40 && y <= 120;
      scanlines[pixel] = blue ? 0 : 255;
      scanlines[pixel + 1] = blue || red ? 0 : 255;
      scanlines[pixel + 2] = red ? 0 : 255;
    }
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(bytes.length + 8);
    result.writeUInt32BE(data.length, 0);
    bytes.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

try {
  const action = process.argv[2] ?? "check";
  if (!["check", "probe"].includes(action)) throw new InferenceError("configuration");
  const apiKey = process.env.NEURALWATT_API_KEY?.trim() ?? "";
  const catalog = await discoverNeuralwattModels({ apiKey });
  const model = catalog.models.find((entry) => entry.id === (process.argv[3] ?? "glm-5.3-flash"));
  if (!model?.vision || !model.maxImages) throw new InferenceError("configuration");
  if (action === "check") {
    printCatalogCheck(catalog, model);
  } else {
    const bytes = fictionalImage();
    const startedAt = Date.now();
    const result = await createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: model,
      timeoutMs: inferenceTimeoutMs(model.id),
    }).complete({
      maxTokens: 4096,
      reasoningEffort: "low",
      messages: [
        {
          role: "system",
          content:
            "You are examining a fictional test image. Describe only what is visible. Do not use tools.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Name each shape's color and shape, ordered from left to right, in one sentence.",
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` },
            },
          ],
        },
      ],
    });
    const describesImage = /red[\s\S]{0,60}circle[\s\S]*blue[\s\S]{0,60}square/i.test(result.text);
    const passed =
      result.complete &&
      describesImage &&
      (!model.id.endsWith("-flex") || result.serviceTier === "flex");
    console.log(
      JSON.stringify(
        {
          status: passed ? "passed" : "failed",
          checkedAt: new Date().toISOString(),
          model: model.id,
          vision: model.vision,
          maxImages: model.maxImages,
          reasoningEffort: "low",
          maxTokens: 4096,
          imageBytes: bytes.byteLength,
          imageSha256: createHash("sha256").update(bytes).digest("hex"),
          elapsedMs: Date.now() - startedAt,
          complete: result.complete,
          finishReason: result.finishReason,
          requestId: result.requestId,
          usage: result.usage,
          costUsd: result.costUsd,
          serviceTier: result.serviceTier,
          describesFictionalImage: describesImage,
          replyCharacters: result.text.length,
          hostedTools: "disabled",
          retried: false,
        },
        null,
        2,
      ),
    );
    if (!passed) process.exitCode = 1;
  }
} catch (error) {
  printInferenceProbeFailure(error);
}
