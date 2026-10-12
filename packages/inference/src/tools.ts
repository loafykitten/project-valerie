import { InferenceError, record, safeIdPattern } from "./transport";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const namePattern = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export function prepareTools(tools: ToolDefinition[] | undefined) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 16)
    throw new InferenceError("configuration");
  const names = new Set<string>();
  return tools.map((tool) => {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      !namePattern.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== "string" ||
      tool.description.length > 4096 ||
      record(tool.parameters).type !== "object"
    )
      throw new InferenceError("configuration");
    names.add(tool.name);
    let parameters: Record<string, unknown>;
    try {
      const encoded = JSON.stringify(tool.parameters);
      if (Buffer.byteLength(encoded, "utf8") > 16384) throw new Error();
      parameters = JSON.parse(encoded);
    } catch {
      throw new InferenceError("configuration");
    }
    return {
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters },
    };
  });
}

/** Only syntax is transport-owned. The tool owner validates JSON arguments before execution. */
export function parseToolCalls(
  value: unknown,
  error: "configuration" | "invalid_response",
): ToolCall[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new InferenceError(error);
  const ids = new Set<string>();
  return value.map((item) => {
    const call = record(item);
    const fn = record(call.function);
    if (
      call.type !== "function" ||
      typeof call.id !== "string" ||
      !safeIdPattern.test(call.id) ||
      ids.has(call.id) ||
      typeof fn.name !== "string" ||
      !namePattern.test(fn.name) ||
      typeof fn.arguments !== "string" ||
      Buffer.byteLength(fn.arguments, "utf8") > 8192
    )
      throw new InferenceError(error);
    ids.add(call.id);
    return { id: call.id, name: fn.name, arguments: fn.arguments };
  });
}

export function wireToolCall(call: ToolCall): WireToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}
