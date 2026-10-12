import { describe, expect, test } from "bun:test";
import {
  type ChatContentPart,
  type ChatMessage,
  createNeuralwattClient,
  discoverNeuralwattModels,
  estimateMessageTokens,
  INFERENCE_IMAGE_TOKEN_ALLOWANCE,
  MAX_INFERENCE_IMAGE_BYTES,
  type NeuralwattModel,
} from "./index";

// Fictional one-pixel PNG; these tests validate transport boundaries, not image decoding.
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const part = (url = png): ChatContentPart => ({ type: "image_url", image_url: { url } });
const model: NeuralwattModel = {
  id: "fictional-vision",
  displayName: "Fictional Vision",
  maxContextTokens: 262144,
  maxOutputTokens: 8192,
  vision: true,
  maxImages: 20,
  systemRole: true,
  reasoningEffort: false,
  deprecated: false,
  reasoning: null,
  pricing: {
    currency: "USD",
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
    pricingTbd: true,
  },
};
const apiKey = "fictional-secret";
const response = () =>
  Response.json({
    choices: [{ message: { content: "A fictional shape." }, finish_reason: "stop" }],
  });
const input = (parts: ChatContentPart[]): ChatMessage[] => [{ role: "user", content: parts }];

function filledPng(bytes: number): string {
  const image = Buffer.alloc(bytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  return `data:image/png;base64,${image.toString("base64")}`;
}

describe("Neuralwatt private image transport", () => {
  test("discovers vision and image count only from authenticated model metadata", async () => {
    const catalog = await discoverNeuralwattModels({
      apiKey,
      transport: async () =>
        Response.json(
          {
            scope: "customer",
            data: [
              {
                id: "vision",
                metadata: { capabilities: { vision: true }, limits: { max_images: 20 } },
              },
              {
                id: "text",
                metadata: { capabilities: { vision: false }, limits: { max_images: 20 } },
              },
              {
                id: "unknown",
                metadata: { capabilities: { vision: true }, limits: { max_images: null } },
              },
            ],
          },
          { headers: { "x-models-scope": "customer" } },
        ),
    });
    expect(catalog.models.map(({ vision, maxImages }) => ({ vision, maxImages }))).toEqual([
      { vision: true, maxImages: 20 },
      { vision: false, maxImages: null },
      { vision: true, maxImages: null },
    ]);
  });

  test("preserves caption/image order and strips unexpected nested provider fields", async () => {
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: model,
      transport: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.messages).toEqual([
          { role: "system", content: "Fictional system prompt." },
          { role: "user", content: [{ type: "text", text: "What is pictured?" }, part()] },
          { role: "system", content: "Fictional post-history instruction." },
        ]);
        expect(body.tools).toBeUndefined();
        expect(new Headers(init.headers).get("X-NW-Tools-Opt-Out")).toBe("true");
        return response();
      },
    });
    const extra = {
      type: "image_url" as const,
      image_url: { url: png, detail: "high", provider_key: apiKey },
      tool_calls: ["untrusted"],
    };
    const result = await client.complete({
      messages: [
        { role: "system", content: "Fictional system prompt." },
        { role: "user", content: [{ type: "text", text: "What is pictured?" }, extra] },
        { role: "system", content: "Fictional post-history instruction." },
      ],
    });
    expect(result.complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  test("images without caption work and MIME signature validation accepts JPEG/PNG/WebP", async () => {
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: model,
      transport: async () => response(),
    });
    const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224]).toString("base64")}`;
    const webp = `data:image/webp;base64,${Buffer.from("RIFF0000WEBP").toString("base64")}`;
    for (const url of [png, jpeg, webp])
      expect((await client.complete({ messages: input([part(url)]) })).complete).toBe(true);
  });

  test("blocks URLs, unsupported formats, mislabeled bytes and malformed base64 before transport", async () => {
    let calls = 0;
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: model,
      transport: async () => {
        calls++;
        return response();
      },
    });
    for (const url of [
      "https://example.invalid/image.png",
      "http://127.0.0.1/image",
      "file:///private/image.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/gif;base64,R0lGODlh",
      png.replace("image/png", "image/jpeg"),
      "data:image/png;base64,",
      "data:image/png;base64,!!!!",
      "data:image/png;base64,iVBORw0KGgo",
      "data:image/png;base64,iVBORw0KGgo=\n",
      "data:image/png;base64,iVBORw0KGgp=",
      "data:image/png;base64,=VBORw0KGgo=",
    ])
      await expect(client.complete({ messages: input([part(url)]) })).rejects.toMatchObject({
        code: "configuration",
      });
    expect(calls).toBe(0);
  });

  test("requires a pinned vision model with a known image count and user message role", async () => {
    let calls = 0;
    for (const capabilities of [
      undefined,
      { ...model, vision: false },
      { ...model, maxImages: null },
    ]) {
      const client = createNeuralwattClient({
        apiKey,
        model: model.id,
        capabilities,
        transport: async () => {
          calls++;
          return response();
        },
      });
      await expect(client.complete({ messages: input([part()]) })).rejects.toMatchObject({
        code: "configuration",
      });
    }
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: model,
      transport: async () => {
        calls++;
        return response();
      },
    });
    for (const role of ["system", "assistant"] as const)
      await expect(
        client.complete({ messages: [{ role, content: [part()] }] }),
      ).rejects.toMatchObject({ code: "configuration" });
    expect(calls).toBe(0);
  });

  test("caps image counts across all messages against both local and provider limits", async () => {
    for (const [providerLimit, count] of [
      [2, 3],
      [25, 21],
    ]) {
      const client = createNeuralwattClient({
        apiKey,
        model: model.id,
        capabilities: { ...model, maxImages: providerLimit ?? 0 },
        transport: async () => {
          throw new Error("Transport must not run");
        },
      });
      await expect(
        client.complete({
          messages: Array.from({ length: count ?? 0 }, () => ({ role: "user", content: [part()] })),
        }),
      ).rejects.toMatchObject({ code: "configuration" });
    }
  });

  test("caps per-image bytes, aggregate decoded bytes, and actual serialized request size", async () => {
    let calls = 0;
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: { ...model, maxContextTokens: 1048560 },
      transport: async () => {
        calls++;
        return response();
      },
    });
    await expect(
      client.complete({ messages: input([part(filledPng(MAX_INFERENCE_IMAGE_BYTES + 1))]) }),
    ).rejects.toMatchObject({ code: "configuration" });
    const fiveMiB = part(filledPng(MAX_INFERENCE_IMAGE_BYTES));
    await expect(
      client.complete({ messages: input([fiveMiB, fiveMiB, fiveMiB, fiveMiB]) }),
    ).rejects.toMatchObject({ code: "configuration" });
    // Control characters grow six-fold in JSON even though raw text stays within 1 MiB.
    await expect(
      client.complete({
        messages: input([
          { type: "text", text: "\u0001".repeat(1024 * 1024) },
          fiveMiB,
          fiveMiB,
          fiveMiB,
        ]),
      }),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(calls).toBe(0);
  });

  test("image context uses fixed allowance instead of counting base64 as text", () => {
    const tiny = estimateMessageTokens(input([part()]));
    const large = estimateMessageTokens(input([part(filledPng(100000))]));
    expect(tiny).toBe(128 + 16 + INFERENCE_IMAGE_TOKEN_ALLOWANCE);
    expect(large).toBe(tiny);
    expect(estimateMessageTokens(input([{ type: "text", text: "caption" }, part()]))).toBe(
      tiny + 3,
    );
  });

  test("preserves the existing text limit for multipart text and rejects malformed parts", async () => {
    const client = createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: model,
      transport: async () => {
        throw new Error("Transport must not run");
      },
    });
    const malformed = [
      { type: "audio", input_audio: "unexpected" },
    ] as unknown as ChatContentPart[];
    for (const parts of [
      [],
      malformed,
      [{ type: "text" as const, text: "x".repeat(1024 * 1024 + 1) }],
    ])
      await expect(client.complete({ messages: input(parts) })).rejects.toMatchObject({
        code: "configuration",
      });
  });
});
