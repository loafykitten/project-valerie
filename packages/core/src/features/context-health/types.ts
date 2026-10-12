import type { ConversationToolCatalog } from "../tools/catalog";

export type ContextSourceKind = "conversation" | "heartbeat";

export interface ContextTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}

/** Conservative application units, never a provider tokenizer measurement. */
export interface ContextRequestEstimates {
  estimator: "utf8-byte-upper-bound";
  messageUnits: number;
  toolSchemaUnits: number;
}

export const contextFailureCodes = [
  "configuration",
  "network",
  "deadline",
  "cancelled",
  "provider",
  "authentication",
  "rate_limited",
  "context_overflow",
  "invalid_response",
  "catalog_scope",
  "unknown",
] as const;

export type ContextFailureCode = (typeof contextFailureCodes)[number];

export interface ContextRequestInput {
  serviceTier?: "flex" | "standard" | null;
  costUsd?: number | null;
  /** Retained privately for exact per-invocation tool-contract evidence; omitted from default exports. */
  toolCatalog?: ConversationToolCatalog;
  kind: ContextSourceKind;
  sourceId: string;
  attempt: number;
  startedAt: string;
  elapsedMs: number;
  requestId: string | null;
  finishReason: "stop" | "length" | "tool_calls" | null;
  failureCode: ContextFailureCode | null;
  usage: Partial<ContextTokenUsage> | null;
  estimates: ContextRequestEstimates;
}

export interface ContextRequestRecord extends ContextTokenUsage {
  serviceTier?: "flex" | "standard" | null;
  costUsd?: number | null;
  id: string;
  /** Recorded client invocation; failures may occur before provider dispatch. */
  origin: "recorded" | "legacy_tool_round" | "reconstructed_final" | "legacy_single_request";
  /** Automatic attempt counter; a manual retry can start again at 1. */
  attempt: number | null;
  startedAt: string | null;
  elapsedMs: number | null;
  requestId: string | null;
  finishReason: "stop" | "length" | "tool_calls" | null;
  failureCode: ContextFailureCode | null;
  estimates: ContextRequestEstimates | null;
}

export const contextOmissionReasons = [
  "age_window",
  "size_budget",
  "unconfirmed_exchange",
  "row_limit",
  "media_limit",
  "source_unavailable",
  "unclassified",
] as const;

export type ContextOmissionReason = (typeof contextOmissionReasons)[number];

export type ContextSignal =
  | "history_size_budget"
  | "fixed_context_budget"
  | "core_memory_budget"
  | "tool_context_budget"
  | "provider_context_refusal"
  | "output_budget_exhausted";

export interface ContextBudget {
  contextUnits: number;
  outputReserveUnits: number;
  safetyReserveUnits: number;
  toolReserveUnits: number;
  requiredUnits: number;
}

export interface ContextSourceReport {
  id: string;
  kind: ContextSourceKind;
  occurredAt: string;
  status: string;
  model: string | null;
  reasoningEffort: string | null;
  settingsVersion: number | null;
  capabilityCheckedAt: string | null;
  modelContextTokens: number | null;
  applicationContextUnits: number | null;
  outputReserveTokens: number | null;
  promptOrderVersion: number | null;
  promptVersions: Record<string, number>;
  memorySettingsVersion: number | null;
  contextBudget: ContextBudget | null;
  estimates: {
    estimator: "utf8-byte-upper-bound";
    promptTextUnits: number | null;
    promptSections: { id: string; version: number; textUnits: number }[];
    memoryUnits: number | null;
    coreMemoryUnits: number | null;
    retrievedMemoryUnits: number | null;
    memoryTopicUnits: number | null;
    currentInputUnits: number | null;
    currentInputImageUnits: number | null;
    historyImageUnits: number | null;
  };
  history: {
    since: string | null;
    estimatedUnits: number | null;
    budgetUnits: number | null;
    includedTurns: number | null;
    includedOwnerMessages: number | null;
    includedAssistantMessages: number | null;
    includedImages: number | null;
    omittedImages: number | null;
    truncated: boolean | null;
    omissionReasons: ContextOmissionReason[];
  };
  requests: ContextRequestRecord[];
  /** A total across calls, never the size of a single context window. */
  cumulativeUsage: ContextTokenUsage;
  cumulativeUsageBasis: "recorded_requests" | "legacy_turn_result" | "unavailable";
  peakInputTokens: number | null;
  signals: ContextSignal[];
  caveats: string[];
}

export interface ContextHealthReport {
  generatedAt: string;
  qualityThreshold: { status: "uncalibrated"; inputTokens: null };
  notificationDelivery: "not_implemented" | "enabled" | "disabled";
  notices: {
    id: string;
    status: "pending" | "sending" | "retry" | "sent" | "failed" | "unknown" | "cancelled";
    category: "context" | "output";
    active: boolean;
    attempts: number;
    createdAt: string;
    deliveredAt: string | null;
  }[];
  summary: {
    sources: number;
    requests: number;
    largestInputTokens: number | null;
    pressureSources: number;
    outputExhaustedSources: number;
  };
  sources: ContextSourceReport[];
  limitations: string[];
}
