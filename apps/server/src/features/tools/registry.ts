import {
  DynamicConflictError,
  DynamicPermissionError,
  DynamicValidationError,
  MemoryConflictError,
  MemoryCursorError,
  MemoryDuplicateError,
  MemorySaveValidationError,
  type Store,
} from "@valerie/core";
import type { TextCompletion, ToolCall, ToolDefinition } from "@valerie/inference";

export type ToolEffect = "read" | "local_write" | "external_write";
export type ToolTurnKind = "user" | "reminder" | "interval" | "heartbeat" | "reflection";
export interface ToolContext {
  turnId: string;
  operationKey: string;
  signal: AbortSignal;
  call?: ToolCall;
  completion?: Pick<TextCompletion, "usage" | "requestId" | "costUsd">;
  turnKind?: ToolTurnKind;
  authorizedExternalWrite?: boolean;
  outputBudgetBytes?: number;
}
export interface RegisteredTool extends ToolDefinition {
  effect: ToolEffect;
  allowedTurnKinds: readonly ToolTurnKind[];
  timeoutMs: number;
  maxOutputBytes: number;
  outputSchema: Record<string, unknown>;
  /** Fixed repair guidance; never echo unvalidated input or provider prose. */
  argumentHelp?: string;
  execute(input: Record<string, unknown>, context: ToolContext): unknown;
}
export interface ToolOutcome {
  status: "succeeded" | "rejected" | "failed";
  result?: unknown;
  code?: string;
  field?: string;
  reason?: string;
  message?: string;
  existingMemory?: { id: string; version: number };
}

export class ToolRejectionError extends Error {
  constructor(readonly code: "one_image_per_turn" | "permission_denied") {
    super(code);
  }
}

class ToolFailureError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Small intentionally limited JSON Schema subset; unsupported schemas fail closed. */
export function validateToolInput(value: unknown, schema: Record<string, unknown>): boolean {
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.includes(value))) return false;
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const fields = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required ?? []) as string[];
      if (required.some((key) => !Object.hasOwn(fields, key))) return false;
      return Object.entries(fields).every(([key, field]) => {
        const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
        return property ? validateToolInput(field, property) : schema.additionalProperties === true;
      });
    }
    case "string":
      return (
        typeof value === "string" &&
        value.length >= Number(schema.minLength ?? 0) &&
        value.length <= Number(schema.maxLength ?? 8192)
      );
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= Number(schema.minimum ?? Number.MIN_SAFE_INTEGER) &&
        value <= Number(schema.maximum ?? Number.MAX_SAFE_INTEGER)
      );
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= Number(schema.minItems ?? 0) &&
        value.length <= Number(schema.maxItems ?? 20) &&
        value.every((item) => validateToolInput(item, schema.items as Record<string, unknown>))
      );
    default:
      return false;
  }
}

const failure = (code: string): ToolOutcome => ({ status: "failed", code });
const safeError = (error: unknown): ToolOutcome => {
  if (error instanceof DynamicPermissionError)
    return { status: "rejected", code: "permission_denied" };
  if (error instanceof DynamicConflictError)
    return {
      status: "rejected",
      code: "invalid_arguments",
      field: "expectedVersion",
      reason: "focus_conflict",
      message: "Growth Focus changed. Read its current version before updating.",
    };
  if (error instanceof DynamicValidationError)
    return {
      status: "rejected",
      code: "invalid_arguments",
      field: error.field,
      reason: error.reason,
      message: error.message,
    };
  // Exception messages can contain source prose, paths or provider responses.
  if (error instanceof ToolRejectionError) return { status: "rejected", code: error.code };
  if (error instanceof ToolFailureError) return failure(error.code);
  if (error instanceof MemoryCursorError)
    return {
      status: "rejected",
      code: "invalid_arguments",
      field: "cursor",
      reason: "stale_cursor",
      message: error.message,
    };
  if (error instanceof MemoryDuplicateError)
    return {
      status: "rejected",
      code: "invalid_arguments",
      field: "id",
      reason: "duplicate_memory",
      message: "This summary is already saved. Read the existing memory before updating it.",
      existingMemory: { id: error.recordId, version: error.recordVersion },
    };
  if (error instanceof MemoryConflictError)
    return {
      status: "rejected",
      code: "invalid_arguments",
      field: "expectedVersion",
      reason: "memory_conflict",
      message: "Memory changed. Read its current version before retrying.",
    };
  if (error instanceof MemorySaveValidationError)
    return {
      status: "rejected",
      code: "invalid_arguments",
      field: error.field,
      reason: error.reason,
      message: error.message,
    };
  if (error instanceof TypeError || error instanceof SyntaxError)
    return { status: "rejected", code: "invalid_arguments" };
  return failure("tool_failed");
};

export function createToolRegistry(store: Store, definitions: RegisteredTool[]) {
  const tools = new Map<string, RegisteredTool>();
  for (const definition of definitions) {
    if (
      tools.has(definition.name) ||
      definition.timeoutMs <= 0 ||
      definition.maxOutputBytes < 256 ||
      definition.maxOutputBytes > 32768 ||
      (definition.argumentHelp !== undefined && Buffer.byteLength(definition.argumentHelp) > 1000)
    )
      throw new TypeError("Invalid tool definition.");
    tools.set(definition.name, definition);
  }
  return {
    schemas: definitions.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
    async execute(
      call: ToolCall,
      context: ToolContext,
      commit: (outcome: ToolOutcome, effect: ToolEffect | "rejected") => void,
    ): Promise<ToolOutcome> {
      const tool = tools.get(call.name);
      const reject = (code: string, message?: string) => {
        const outcome: ToolOutcome = { status: "rejected", code, ...(message ? { message } : {}) };
        commit(outcome, "rejected");
        return outcome;
      };
      if (!tool?.allowedTurnKinds.includes(context.turnKind ?? "user"))
        return reject("unavailable_tool");
      if (tool.effect === "external_write" && !context.authorizedExternalWrite)
        return reject("permission_denied");
      if (context.signal.aborted) return reject("cancelled");
      let input: unknown;
      try {
        input = JSON.parse(call.arguments);
      } catch {
        return reject("invalid_arguments");
      }
      if (!validateToolInput(input, tool.parameters))
        return reject("invalid_arguments", tool.argumentHelp);
      const bounded = (value: unknown): ToolOutcome => {
        if (!validateToolInput(value, tool.outputSchema)) return failure("invalid_output");
        const result: ToolOutcome = { status: "succeeded", result: value };
        try {
          if (
            Buffer.byteLength(JSON.stringify(result), "utf8") >
            Math.min(tool.maxOutputBytes, context.outputBudgetBytes ?? tool.maxOutputBytes)
          )
            return failure("output_limit");
        } catch {
          return failure("invalid_output");
        }
        return result;
      };
      // All current mutations enqueue or write SQLite synchronously. Their result and
      // outcome commit in the same transaction, leaving no replay gap after a crash.
      if (tool.effect !== "read") {
        try {
          return store.db
            .transaction(() => {
              const started = performance.now();
              const value = tool.execute(input as Record<string, unknown>, context);
              if (value instanceof Promise) throw new TypeError("Mutations must be synchronous.");
              if (performance.now() - started > tool.timeoutMs || context.signal.aborted)
                throw new ToolFailureError(context.signal.aborted ? "cancelled" : "tool_timeout");
              const outcome = bounded(value);
              if (outcome.status !== "succeeded")
                throw new ToolFailureError(outcome.code ?? "invalid_output");
              commit(outcome, tool.effect);
              return outcome;
            })
            .immediate();
        } catch (error) {
          const outcome = safeError(error);
          commit(outcome, outcome.status === "rejected" ? "rejected" : tool.effect);
          return outcome;
        }
      }
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), tool.timeoutMs);
      const signal = AbortSignal.any([context.signal, timeout.signal]);
      let abortListener: (() => void) | undefined;
      try {
        const aborted = new Promise<ToolOutcome>((resolve) => {
          abortListener = () =>
            resolve(failure(context.signal.aborted ? "cancelled" : "tool_timeout"));
          signal.addEventListener("abort", abortListener, { once: true });
          if (signal.aborted) abortListener();
        });
        const execution = Promise.resolve()
          .then(() => {
            if (signal.aborted) throw new Error("Cancelled.");
            const started = performance.now();
            const result = tool.execute(input as Record<string, unknown>, { ...context, signal });
            if (performance.now() - started > tool.timeoutMs)
              throw new ToolFailureError("tool_timeout");
            return result;
          })
          .then(bounded)
          .catch(safeError);
        const outcome = await Promise.race([execution, aborted]);
        commit(outcome, tool.effect);
        return outcome;
      } finally {
        clearTimeout(timer);
        if (abortListener) signal.removeEventListener("abort", abortListener);
      }
    },
  };
}
