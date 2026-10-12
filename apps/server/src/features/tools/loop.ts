import { createActivityService, type Store } from "@valerie/core";
import {
  type ChatMessage,
  INFERENCE_IMAGE_TOKEN_ALLOWANCE,
  InferenceError,
  type TextCompletion,
  wireToolCall,
} from "@valerie/inference";
import { createToolJournal } from "./journal";
import { createToolRegistry, type RegisteredTool, type ToolOutcome } from "./registry";

const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CALLS = 12;
/** Context kept free for the final no-more-tools instruction and the model's reply. */
const FINAL_RESERVE = 2048;
/** Per-call allowance for each tool result message still to be appended. */
const RESULT_RESERVE = 256;

/** Match core's conservative UTF8-byte allowance instead of treating chars as exact tokens. */
export function estimateToolContext(messages: readonly ChatMessage[]): number {
  return (
    128 +
    messages.reduce(
      (total, message) =>
        total +
        32 +
        (message.tool_calls ? Buffer.byteLength(JSON.stringify(message.tool_calls), "utf8") : 0) +
        (typeof message.content === "string"
          ? Buffer.byteLength(message.content, "utf8")
          : message.content.reduce(
              (sum, part) =>
                sum +
                (part.type === "text"
                  ? Buffer.byteLength(part.text, "utf8")
                  : INFERENCE_IMAGE_TOKEN_ALLOWANCE),
              0,
            )),
      0,
    )
  );
}

export function sumToolUsage(
  first: Pick<TextCompletion, "usage" | "costUsd" | "serviceTier">,
  next: TextCompletion,
): TextCompletion {
  const sum = (a: number | null | undefined, b: number | null | undefined) =>
    a == null || b == null ? null : a + b;
  return {
    ...next,
    usage: {
      inputTokens: sum(first.usage.inputTokens, next.usage.inputTokens),
      outputTokens: sum(first.usage.outputTokens, next.usage.outputTokens),
      cachedInputTokens: sum(first.usage.cachedInputTokens, next.usage.cachedInputTokens),
      reasoningTokens: sum(first.usage.reasoningTokens, next.usage.reasoningTokens),
    },
    costUsd: sum(first.costUsd, next.costUsd),
    serviceTier:
      first.serviceTier && first.serviceTier === next.serviceTier ? next.serviceTier : null,
  };
}

export async function runConversationTools(options: {
  store: Store;
  turnId: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  tools: RegisteredTool[];
  contextTokens: number;
  maxOutputTokens: number;
  complete: (messages: ChatMessage[], tools?: RegisteredTool[]) => Promise<TextCompletion>;
}): Promise<TextCompletion> {
  const { store, turnId, signal, messages } = options;
  const registry = createToolRegistry(store, options.tools);
  const journal = createToolJournal(store, turnId);
  const schemaTokens = Buffer.byteLength(JSON.stringify(registry.schemas), "utf8") + 512;
  let cumulative: TextCompletion | null = null;
  let callCount = 0;
  let invalidRounds = 0;
  let stopReason = "tool_budget";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) throw new InferenceError("cancelled");
    let response = journal.readRound(round);
    if (!response) {
      // Reserve a compact final instruction/result before starting another provider round.
      if (
        estimateToolContext(messages) + schemaTokens + options.maxOutputTokens + FINAL_RESERVE >
        options.contextTokens
      ) {
        stopReason = "context_budget";
        break;
      }
      response = await options.complete(messages, options.tools);
      if (!response.toolCalls) return cumulative ? sumToolUsage(cumulative, response) : response;
      journal.saveRound(round, response);
    }
    cumulative = cumulative ? sumToolUsage(cumulative, response) : response;
    const calls = response.toolCalls;
    if (!calls) throw new InferenceError("configuration");
    // Providers sometimes repeat IDs across requests. Stable local IDs keep each
    // assistant/result pair unambiguous while original IDs stay in the journal.
    const wireCalls = calls.map((call, index) => ({ ...call, id: `valerie.r${round}.c${index}` }));
    if (
      estimateToolContext(messages) +
        Buffer.byteLength(JSON.stringify(wireCalls.map(wireToolCall)), "utf8") +
        options.maxOutputTokens +
        FINAL_RESERVE +
        calls.length * RESULT_RESERVE >
      options.contextTokens
    ) {
      // Preserve the exact proposal and its rejection privately. It was never accepted
      // or executed, so no committed tool pair is removed from the model transcript.
      for (const [index, call] of calls.entries()) {
        if (!journal.readOutcome(round, index))
          journal.saveOutcome(
            round,
            index,
            call.name,
            { status: "rejected", code: "context_budget" },
            "rejected",
          );
      }
      messages.push({
        role: "system",
        content:
          "The latest proposed tool round was rejected before any action ran because its arguments were too large. No work from that proposal was performed. Explain the incomplete request honestly using prior confirmed outcomes.",
      });
      stopReason = "context_budget";
      break;
    }
    messages.push({ role: "assistant", content: "", tool_calls: wireCalls.map(wireToolCall) });
    let invalid = false;
    let unavailable = false;
    for (const [index, call] of calls.entries()) {
      let outcome = journal.readOutcome(round, index);
      const commit = (result: ToolOutcome, effect: Parameters<typeof journal.saveOutcome>[4]) =>
        journal.saveOutcome(round, index, call.name, result, effect);
      if (!outcome) {
        if (callCount >= MAX_TOOL_CALLS) {
          outcome = { status: "rejected", code: "tool_budget" };
          commit(outcome, "rejected");
        } else {
          outcome = await registry.execute(
            call,
            {
              turnId,
              operationKey: `${turnId}:${round}:${index}`,
              signal,
              call,
              completion: cumulative,
              outputBudgetBytes: Math.max(
                256,
                options.contextTokens -
                  options.maxOutputTokens -
                  estimateToolContext(messages) -
                  FINAL_RESERVE -
                  (calls.length - index) * RESULT_RESERVE,
              ),
            },
            commit,
          );
        }
      }
      callCount++;
      invalid ||= outcome.status === "rejected" && outcome.code === "invalid_arguments";
      unavailable ||= outcome.status === "rejected" && outcome.code !== "invalid_arguments";
      messages.push({
        role: "tool",
        tool_call_id: wireCalls[index]?.id,
        content: JSON.stringify(outcome),
      });
    }
    if (signal.aborted) throw new InferenceError("cancelled");
    if (invalid) invalidRounds++;
    if (invalidRounds >= 2 || unavailable || callCount >= MAX_TOOL_CALLS) {
      stopReason =
        invalidRounds >= 2
          ? "argument_repair_limit"
          : unavailable
            ? "unavailable_action"
            : "tool_budget";
      break;
    }
    if (invalid)
      messages.push({
        role: "system",
        content: "You have one correction attempt remaining for the rejected tool call.",
      });
  }
  messages.push({
    role: "system",
    content: `No more tools this turn (${stopReason}). Reply in your own character voice using only the outcomes above. If work is incomplete, briefly explain what remains without exposing internal budgets or tools. A memory save succeeded only when its result confirms it. An image job queued, submitting, running, recovery, ready or sending is still pending; say it will take a moment and do not claim it has been sent. Only sent confirms delivery. Do not promise rejected or failed actions.`,
  });
  if (stopReason === "context_budget")
    createActivityService(store).append({
      kind: "context.tool_budget",
      summary: "Tool continuation stopped because its context allowance was full.",
      status: "failed",
      metadata: { turnId },
    });
  if (estimateToolContext(messages) + options.maxOutputTokens > options.contextTokens)
    throw new InferenceError("configuration");
  const final = await options.complete(messages);
  return cumulative ? sumToolUsage(cumulative, final) : final;
}
