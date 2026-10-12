import type { ConversationSnapshot, ImageJob, Store } from "@valerie/core";
import { InferenceError, type Transport } from "@valerie/inference";
import { createConversationGenerator } from "../conversation/inference";

/** Reuse the requesting turn's authored voice while stating the actual terminal outcome. */
export function createImageFailureGenerator(options: {
  store: Store;
  apiKey: string;
  transport?: Transport;
}) {
  const generate = createConversationGenerator(options);
  return async (snapshot: ConversationSnapshot, job: ImageJob, signal: AbortSignal) => {
    if (job.status !== "failed" && job.status !== "unknown")
      throw new InferenceError("configuration");
    return generate(
      {
        ...snapshot,
        imageGenerationEnabled: false,
        settings: {
          ...snapshot.settings,
          maxOutputTokens: Math.min(snapshot.settings.maxOutputTokens, 2048),
        },
        messages: [
          ...snapshot.messages,
          {
            role: "system",
            content: `Application update for the image requested in this turn: ${JSON.stringify({ status: job.status, stage: job.assetId ? "Telegram delivery" : "image generation", code: job.failureCode })}. Write one brief message to Ember in your own character voice about this outcome. If status is unknown, say you could not confirm the outcome, not that it definitely failed. Otherwise explain that the picture could not be generated or sent. Do not claim the image was delivered, promise an automatic retry, expose technical codes, or invent a cause. Do not call tools. Keep the message under 1000 characters.`,
          },
        ],
      },
      signal,
    );
  };
}
