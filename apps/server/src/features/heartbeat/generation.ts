import {
  createHeartbeatContextService,
  HEARTBEAT_SILENT_MARKER,
  type HeartbeatSnapshot,
  type Store,
} from "@valerie/core";
import {
  createNeuralwattClient,
  estimateMessageTokens,
  InferenceError,
  inferenceTimeoutMs,
  type NeuralwattModel,
  type ReasoningEffort,
  type TextCompletion,
  type Transport,
} from "@valerie/inference";
import { measureCompletion } from "../context-health/measure";
import { isStructuredCompanionOutput } from "../conversation/output";

export type { HeartbeatSnapshot } from "@valerie/core";

export type HeartbeatGeneration =
  | { decision: "speak"; text: string; completion: TextCompletion }
  | { decision: "silent" | "rejected"; reason: string; completion: TextCompletion };

const comparable = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

function duplicate(text: string, previous: readonly string[]): boolean {
  const candidate = comparable(text);
  return previous.some((earlier) => {
    const normalized = comparable(earlier);
    if (candidate === normalized) return true;
    // Catch near-verbatim longer repetitions without treating shared endearments
    // or a common warm opening as duplicates on their own.
    const trigrams = (value: string) => {
      const words = value.split(" ");
      return new Set(words.slice(2).map((_, index) => words.slice(index, index + 3).join(" ")));
    };
    const current = trigrams(candidate);
    const old = trigrams(normalized);
    if (current.size < 10 || old.size < 10) return false;
    const common = [...current].filter((phrase) => old.has(phrase)).length;
    return common / current.size >= 0.9 && common / old.size >= 0.9;
  });
}

/** Retain the provider receipt for silence and invalid output as well as useful speech. */
export function validateHeartbeatCompletion(
  snapshot: HeartbeatSnapshot,
  completion: TextCompletion,
): HeartbeatGeneration {
  const rejected = (reason: string): HeartbeatGeneration => ({
    decision: "rejected",
    reason,
    completion,
  });
  if (!completion.complete || completion.finishReason !== "stop" || completion.toolCalls?.length)
    return rejected("incomplete_output");
  const text = completion.text;
  if (text === HEARTBEAT_SILENT_MARKER)
    return { decision: "silent", reason: "model_silence", completion };
  if (
    !text.trim() ||
    /\[\[?\s*HEARTBEAT|HEARTBEAT[_-]SILEN(?:T|CE)?/iu.test(text) ||
    /\bHEARTBEAT\s+SILENT\b/u.test(text) ||
    isStructuredCompanionOutput(text)
  )
    return rejected("invalid_decision");
  // UTF-16 length is conservative for Telegram's character ceiling, including emoji.
  // Never repair, slice or reword an authored message after generation.
  if (text.length > snapshot.maxMessageChars) return rejected("message_too_long");
  if (
    duplicate(text, [
      ...snapshot.recentHeartbeats.map((entry) => entry.text),
      ...snapshot.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ])
  )
    return rejected("duplicate_message");
  return { decision: "speak", text, completion };
}

export function createHeartbeatGenerator(options: {
  store: Store;
  apiKey: string;
  now?: () => Date;
  transport?: Transport;
}) {
  const context = createHeartbeatContextService(options.store, { now: options.now });
  return {
    capture: context.capture,
    async generate(
      snapshot: HeartbeatSnapshot,
      signal: AbortSignal,
      runId?: string,
    ): Promise<HeartbeatGeneration> {
      if (
        snapshot.kind !== "heartbeat" ||
        snapshot.responseFormat !== "text-or-silent-v1" ||
        !snapshot.settings.modelCapabilities ||
        !Number.isSafeInteger(snapshot.maxMessageChars) ||
        snapshot.maxMessageChars < 1 ||
        snapshot.maxMessageChars > 4096 ||
        estimateMessageTokens(snapshot.messages) + snapshot.settings.maxOutputTokens + 2048 >
          Math.min(
            snapshot.settings.contextTokens,
            snapshot.settings.modelContextTokens,
            snapshot.settings.modelCapabilities.maxContextTokens ?? 0,
          )
      )
        throw new InferenceError("configuration");
      const client = createNeuralwattClient({
        apiKey: options.apiKey,
        model: snapshot.settings.model,
        timeoutMs: inferenceTimeoutMs(snapshot.settings.model),
        capabilities: snapshot.settings.modelCapabilities as NeuralwattModel,
        transport: options.transport,
      });
      const measure = measureCompletion(options.store, {
        kind: "heartbeat",
        sourceId: runId,
        attempt: 1,
      });
      const completion = await measure(snapshot.messages, undefined, () =>
        client.complete({
          messages: snapshot.messages,
          // A short visible message still needs the configured reasoning allowance.
          // Keep the pinned model, effort and full completion budget, including reasoning.
          maxTokens: snapshot.settings.maxOutputTokens,
          temperature: snapshot.settings.temperature,
          reasoningEffort: snapshot.settings.reasoningEffort as ReasoningEffort | null,
          signal,
        }),
      );
      if (signal.aborted) return { decision: "rejected", reason: "cancelled", completion };
      return validateHeartbeatCompletion(snapshot, completion);
    },
  };
}
