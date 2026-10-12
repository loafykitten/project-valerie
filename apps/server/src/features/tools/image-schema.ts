import type { ToolDefinition } from "@valerie/inference";

export const imageTool: ToolDefinition = {
  name: "generate_image",
  description:
    "Queue one picture of yourself for Ember when her current message asks you to create or send an image. Choose selfie for upper-body framing or full_body for a full-body picture. Choose clothing, expression, setting, pose and lighting tags; your established appearance, distinctive hair markings and glasses are preserved automatically. The picture is generated in the background and delivered in this conversation later. A queued result does not mean the image was sent.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      framing: { type: "string", enum: ["selfie", "full_body"] },
      scene_tags: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: { type: "string", minLength: 1, maxLength: 80 },
        description:
          'A JSON array of separate plain English phrase strings, for example ["blue cardigan", "warm smile", "garden", "soft daylight"]. Never use a comma-separated string. Include only clothing, expression, setting and lighting. Omit ALL identity attributes, hair, eyes, ears, glasses, age and body shape; these are already protected by the workflow. No prompt weights, model names or technical syntax. Selfies already use upper-body framing; avoid full body, standing, barefoot and conflicting outfit defaults.',
      },
    },
    required: ["framing", "scene_tags"],
  },
};
