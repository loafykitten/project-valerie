import { parseImageWorkflow } from "./profile";

/** Entirely fictional graph/profile; private supplied character assets remain outside Git. */
export function fictionalWorkflow() {
  return parseImageWorkflow(
    {
      prompt: {
        "1": {
          class_type: "CheckpointLoaderSimple",
          inputs: { ckpt_name: "fictional.safetensors" },
        },
        "2": { class_type: "LoraLoader", inputs: { strength_model: 1, strength_clip: 0 } },
        "3": { class_type: "CLIPTextEncode", inputs: { text: "full body, old outfit, old shoes" } },
        "4": { class_type: "CLIPTextEncode", inputs: { text: "fictional negative prompt" } },
        "5": {
          class_type: "EmptyLatentImage",
          inputs: { width: 1024, height: 1344, batch_size: 1 },
        },
        "6": { class_type: "KSampler", inputs: { seed: 1, cfg: 5, steps: 25 } },
        "8": { class_type: "SaveImage", inputs: { filename_prefix: "Final", images: ["11", 0] } },
        "11": {
          class_type: "FaceDetailer",
          inputs: {
            seed: 9,
            denoise: 0.25,
            positive: ["3", 0],
            wildcard: "[CONCAT] fictional guidance",
          },
        },
        "17": { class_type: "SaveImage", inputs: { filename_prefix: "Original" } },
      },
    },
    {
      identity_tags: ["fictional adult", "round figure", "gray hair", "round glasses"],
      style_tags: ["best quality"],
      framing_profiles: {
        selfie: {
          tags: ["upper body", "looking at viewer", "full head in frame", "ears in frame"],
          width: 1024,
          height: 1344,
        },
        full_body: { tags: ["full body"], width: 1024, height: 1344 },
      },
    },
  );
}

export const imageJobId = "00000000-0000-4000-8000-000000000001";
export const testPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhSkAAAAASUVORK5CYII=",
  "base64",
);
