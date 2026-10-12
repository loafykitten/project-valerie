import { abortable, InferenceError, record } from "./transport";

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_CHARS = 256 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

/** Assemble a bounded completion. No partial text or tool arguments escape this reader. */
export async function readCompletionStream(response: Response, signal: AbortSignal) {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    void response.body?.cancel().catch(() => undefined);
    throw new InferenceError("invalid_response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let scanIndex = 0;
  let data: string[] = [];
  let eventChars = 0;
  let eventType = "";
  let bytes = 0;
  let textBytes = 0;
  const text: string[] = [];
  let reason: string | null = null;
  let done = false;
  let usage: unknown;
  let cost: unknown;
  let tier: string | undefined;
  const calls = new Map<
    number,
    { id: string; type: string; function: { name: string; arguments: string } }
  >();
  const invalid = () => new InferenceError("invalid_response");
  const json = (value: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
      return record(parsed);
    } catch {
      throw invalid();
    }
  };
  function dispatch() {
    if (eventType === "error") throw new InferenceError("provider");
    eventType = "";
    eventChars = 0;
    if (!data.length) return;
    const payload = data.join("\n");
    data = [];
    if (payload === "[DONE]") {
      if (!reason) throw invalid();
      done = true;
      return;
    }
    const chunk = json(payload);
    if (chunk.error != null) throw new InferenceError("provider");
    if (chunk.service_tier === "flex" || chunk.service_tier === "standard") {
      if (tier && tier !== chunk.service_tier) throw invalid();
      tier = chunk.service_tier;
    }
    if (chunk.usage != null) usage = chunk.usage;
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw invalid();
    if (!chunk.choices.length) return;
    const choice = record(chunk.choices[0]);
    if (choice.index !== 0 || reason !== null) throw invalid();
    const delta = record(choice.delta);
    if (delta.role !== undefined && delta.role !== "assistant") throw invalid();
    if (delta.content != null) {
      if (typeof delta.content !== "string") throw invalid();
      textBytes += Buffer.byteLength(delta.content, "utf8");
      if (textBytes > MAX_TEXT_BYTES) throw invalid();
      text.push(delta.content);
    }
    // Reasoning is deliberately discarded, including during a long pre-answer stream.
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 4) throw invalid();
      for (const item of delta.tool_calls) {
        const part = record(item);
        if (!Number.isInteger(part.index) || Number(part.index) < 0 || Number(part.index) > 3)
          throw invalid();
        const index = part.index as number;
        const call = calls.get(index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (part.type !== undefined && part.type !== "function") throw invalid();
        if (part.id !== undefined) {
          if (typeof part.id !== "string") throw invalid();
          call.id += part.id;
        }
        const fn = record(part.function);
        for (const key of ["name", "arguments"] as const) {
          if (fn[key] !== undefined) {
            if (typeof fn[key] !== "string") throw invalid();
            call.function[key] += fn[key];
          }
        }
        if (
          call.id.length > 200 ||
          call.function.name.length > 64 ||
          Buffer.byteLength(call.function.arguments, "utf8") > 8192
        )
          throw invalid();
        calls.set(index, call);
      }
    }
    if (choice.finish_reason != null) {
      if (
        typeof choice.finish_reason !== "string" ||
        !["stop", "length", "tool_calls"].includes(choice.finish_reason)
      )
        throw invalid();
      reason = choice.finish_reason;
    }
  }
  function line(value: string) {
    if (!value) return dispatch();
    if (value.startsWith(": cost ")) {
      cost = json(value.slice(7));
      return;
    }
    // Keepalives and unsupported accounting comments are not conversation content.
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") {
      eventChars += content.length + 1;
      if (eventChars > MAX_EVENT_CHARS) throw invalid();
      data.push(content);
    } else if (field === "event") eventType = content;
  }
  try {
    while (!done) {
      const next = await abortable(reader.read(), signal);
      if (next.done) {
        // A final CR is a complete line ending; otherwise EOF cannot replace DONE.
        if (buffer.endsWith("\r")) line(buffer.slice(0, -1));
        if (!done) throw invalid();
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw invalid();
      try {
        buffer += decoder.decode(next.value, { stream: true });
      } catch {
        throw invalid();
      }
      let start = 0;
      let index = scanIndex;
      for (; index < buffer.length && !done; index++) {
        const char = buffer[index];
        if (char !== "\r" && char !== "\n") continue;
        if (char === "\r" && index === buffer.length - 1) break;
        line(buffer.slice(start, index));
        if (char === "\r" && buffer[index + 1] === "\n") index++;
        start = index + 1;
      }
      buffer = buffer.slice(start);
      scanIndex = index - start;
      if (buffer.length > MAX_EVENT_CHARS) throw invalid();
    }
    const ordered = [...calls.entries()].sort(([a], [b]) => a - b);
    if (ordered.some(([index], position) => index !== position)) throw invalid();
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: text.join(""),
            ...(calls.size ? { tool_calls: ordered.map(([, call]) => call) } : {}),
          },
          finish_reason: reason,
        },
      ],
      usage,
      cost,
      service_tier: tier,
    };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
