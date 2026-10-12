import { type ContextSourceKind, createContextHealthService, type Store } from "@valerie/core";
import {
  type ChatMessage,
  InferenceError,
  type TextCompletion,
  type ToolDefinition,
} from "@valerie/inference";
import { estimateToolContext } from "../tools/loop";

/** Record one actual invocation, before tool-loop cumulative usage replaces its receipt. */
export function measureCompletion(
  store: Store,
  source: { kind: ContextSourceKind; sourceId?: string; attempt: number; catalogRevision?: string },
) {
  const health = createContextHealthService(store);
  // Isolated previews/probes can supply a fixture identity without a persisted turn.
  // Production worker calls always refer to their durable source row.
  const persisted =
    source.sourceId &&
    store.db
      .query(
        source.kind === "conversation"
          ? "SELECT id FROM core_conversation_turns WHERE id=?"
          : "SELECT id FROM core_heartbeat_runs WHERE id=?",
      )
      .get(source.sourceId);
  return async (
    messages: ChatMessage[],
    tools: readonly ToolDefinition[] | undefined,
    invoke: () => Promise<TextCompletion>,
  ): Promise<TextCompletion> => {
    if (!source.sourceId || !persisted) return invoke();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const estimates = {
      estimator: "utf8-byte-upper-bound" as const,
      messageUnits: estimateToolContext(messages),
      toolSchemaUnits: tools
        ? Buffer.byteLength(
            JSON.stringify(
              tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
            ),
            "utf8",
          ) + 512
        : 0,
    };
    const toolCatalog = {
      revision: source.catalogRevision ?? "no-tools",
      schemas:
        tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) ??
        [],
    };
    let completion: TextCompletion;
    try {
      completion = await invoke();
    } catch (error) {
      health.recordRequest({
        ...source,
        attempt: Math.max(1, source.attempt),
        sourceId: source.sourceId,
        startedAt,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        requestId: null,
        finishReason: null,
        failureCode: error instanceof InferenceError ? error.code : "unknown",
        usage: null,
        estimates,
        toolCatalog,
      });
      throw error;
    }
    health.recordRequest({
      ...source,
      attempt: Math.max(1, source.attempt),
      sourceId: source.sourceId,
      startedAt,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      requestId: completion.requestId,
      serviceTier: completion.serviceTier,
      costUsd: completion.costUsd,
      finishReason: completion.finishReason,
      failureCode: null,
      usage: completion.usage,
      estimates,
      toolCatalog,
    });
    return completion;
  };
}
