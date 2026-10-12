import {
  type ChatMessage,
  estimateMessageTokens,
  estimateTextTokens,
  prepareMessages,
} from "./messages";
import type { NeuralwattModel, ReasoningEffort } from "./models";
import { readCompletionStream } from "./streaming";
import { parseToolCalls, prepareTools, type ToolCall, type ToolDefinition } from "./tools";
import {
  DEFAULT_TIMEOUT_MS,
  InferenceError,
  type RequestOptions,
  record,
  request,
  safeIdPattern,
  tokenCount,
  validateOptions,
} from "./transport";

export interface CompletionSettings {
  maxTokens: number;
  temperature?: number | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface TextCompletion {
  text: string;
  finishReason: "stop" | "length" | "tool_calls";
  complete: boolean;
  toolCalls?: ToolCall[];
  requestId: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens?: number | null;
    reasoningTokens?: number | null;
  };
  costUsd: number | null;
  /** Actual provider receipt; missing metadata is unknown, never inferred from the alias. */
  serviceTier?: "flex" | "standard" | null;
}

/** Flex aliases are served through the streaming, longer-deadline path. */
function isFlex(model: string): boolean {
  return model.endsWith("-flex");
}

export function inferenceTimeoutMs(model: string, standardMs = 120_000): number {
  return isFlex(model) ? 300_000 : standardMs;
}

function validateSettings(settings: CompletionSettings): void {
  if (
    !Number.isInteger(settings.maxTokens) ||
    settings.maxTokens < 1 ||
    settings.maxTokens > 32768 ||
    (settings.temperature != null &&
      (!Number.isFinite(settings.temperature) ||
        settings.temperature < 0 ||
        settings.temperature > 2))
  ) {
    throw new InferenceError("configuration");
  }
}

/** Check an exact alias's published reasoning behavior, not merely accepted spelling. */
export function validateInferenceSettings(
  model: NeuralwattModel,
  settings: CompletionSettings,
): void {
  validateSettings(settings);
  if (
    !model.systemRole ||
    model.deprecated ||
    model.maxContextTokens === null ||
    settings.maxTokens >= model.maxContextTokens ||
    (model.maxOutputTokens !== null && settings.maxTokens > model.maxOutputTokens)
  )
    throw new InferenceError("configuration");
  if (settings.reasoningEffort != null) {
    const reasoning = model.reasoning;
    const effective =
      reasoning?.effortAliases[settings.reasoningEffort] ?? settings.reasoningEffort;
    if (
      !model.reasoningEffort ||
      !reasoning?.acceptedEfforts.includes(settings.reasoningEffort) ||
      !reasoning.supportedEfforts.includes(effective) ||
      (reasoning.mandatory && effective === "none")
    )
      throw new InferenceError("configuration");
  }
}

/** Pins the selected alias and catalog snapshot for the whole turn. No paid retries. */
export function createNeuralwattClient(
  options: RequestOptions & { model: string; capabilities?: NeuralwattModel },
) {
  options = {
    ...options,
    timeoutMs: options.timeoutMs ?? inferenceTimeoutMs(options.model, DEFAULT_TIMEOUT_MS),
  };
  validateOptions(options);
  if (!safeIdPattern.test(options.model)) throw new InferenceError("configuration");
  const stream = isFlex(options.model);
  const model = options.capabilities ? structuredClone(options.capabilities) : null;
  if (model && model.id !== options.model) throw new InferenceError("configuration");
  return {
    async complete(input: {
      messages: ChatMessage[];
      maxTokens?: number;
      temperature?: number | null;
      reasoningEffort?: ReasoningEffort | null;
      signal?: AbortSignal;
      tools?: ToolDefinition[];
    }): Promise<TextCompletion> {
      const settings: CompletionSettings = {
        maxTokens: input.maxTokens ?? 2048,
        temperature: input.temperature,
        reasoningEffort: input.reasoningEffort,
      };
      if (model) validateInferenceSettings(model, settings);
      else {
        validateSettings(settings);
        if (settings.reasoningEffort != null) throw new InferenceError("configuration");
      }
      const messages = prepareMessages(input.messages, model);
      const tools = prepareTools(input.tools);
      if (tools && !model?.tools) throw new InferenceError("configuration");
      const toolTokens = tools ? estimateTextTokens(JSON.stringify(tools)) : 0;
      if (
        model?.maxContextTokens != null &&
        estimateMessageTokens(messages) + toolTokens + settings.maxTokens > model.maxContextTokens
      )
        throw new InferenceError("configuration");
      const result = await request("/chat/completions", options, {
        signal: input.signal,
        ...(stream ? { readBody: readCompletionStream } : {}),
        body: {
          model: options.model,
          messages,
          max_tokens: settings.maxTokens,
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          ...(tools ? { tools, tool_choice: "auto" } : {}),
          ...(settings.temperature != null ? { temperature: settings.temperature } : {}),
          ...(settings.reasoningEffort != null
            ? { reasoning_effort: settings.reasoningEffort }
            : {}),
        },
      });
      const first = record(Array.isArray(result.body.choices) ? result.body.choices[0] : undefined);
      const message = record(first.message);
      const reason = first.finish_reason;
      const toolCalls =
        reason === "tool_calls" && tools
          ? parseToolCalls(message.tool_calls, "invalid_response")
          : undefined;
      if (
        (reason !== "stop" && reason !== "length" && !(reason === "tool_calls" && toolCalls)) ||
        (message.role !== undefined && message.role !== "assistant") ||
        (!toolCalls &&
          message.tool_calls !== undefined &&
          message.tool_calls !== null &&
          (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) ||
        toolCalls?.some((call) => !tools?.some((tool) => tool.function.name === call.name)) ||
        (typeof message.content !== "string" &&
          !((reason === "length" || toolCalls) && message.content === null))
      )
        throw new InferenceError("invalid_response");
      const text = typeof message.content === "string" ? message.content : "";
      if (reason === "stop" && !text.trim()) throw new InferenceError("invalid_response");
      const usage = record(result.body.usage);
      const bodyTier = result.body.service_tier;
      const headerTier = result.serviceTier;
      const knownTier = (value: unknown) => value === "flex" || value === "standard";
      if (knownTier(bodyTier) && knownTier(headerTier) && bodyTier !== headerTier)
        throw new InferenceError("invalid_response");
      const serviceTier = knownTier(bodyTier)
        ? bodyTier
        : knownTier(headerTier)
          ? headerTier
          : null;
      const cost = record(result.body.cost).request_cost_usd;
      return {
        text,
        finishReason: reason,
        complete: reason === "stop",
        ...(toolCalls ? { toolCalls } : {}),
        requestId: result.requestId,
        usage: {
          inputTokens: tokenCount(usage.prompt_tokens),
          outputTokens: tokenCount(usage.completion_tokens),
          cachedInputTokens: tokenCount(record(usage.prompt_tokens_details).cached_tokens),
          reasoningTokens: tokenCount(record(usage.completion_tokens_details).reasoning_tokens),
        },
        costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
        serviceTier,
      };
    },
  };
}
