export class InferenceError extends Error {
  constructor(
    public readonly code:
      | "configuration"
      | "network"
      | "deadline"
      | "cancelled"
      | "provider"
      | "authentication"
      | "rate_limited"
      | "context_overflow"
      | "invalid_response"
      | "catalog_scope",
    public readonly retryable = false,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Inference request failed: ${code}.`);
    this.name = "InferenceError";
  }
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;
const ENDPOINT = "https://api.neuralwatt.com/v1";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 45_000;
/** Shared shape for provider identifiers: model aliases, request IDs and tool call IDs. */
export const safeIdPattern = /^[a-zA-Z0-9_.:/-]{1,200}$/;

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function positiveTokenCount(value: unknown): number | null {
  const count = tokenCount(value);
  return count !== null && count > 0 ? count : null;
}

function requestId(response: Response): string | null {
  const id = response.headers.get("x-request-id");
  return id && safeIdPattern.test(id) ? id : null;
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header)
    ? Number(header)
    : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : undefined;
}

/** Enforce the total deadline even when a test transport or body ignores its signal. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new InferenceError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new InferenceError("invalid_response");
      chunks.push(value);
    }
  } finally {
    // Cleanup must not let a misbehaving upstream body extend the deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InferenceError("invalid_response");
  }
}

export interface RequestOptions {
  apiKey: string;
  timeoutMs?: number;
  transport?: Transport;
}

export function validateOptions(options: RequestOptions): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof options.apiKey !== "string" ||
    !options.apiKey.trim() ||
    /[\r\n]/.test(options.apiKey) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  ) {
    throw new InferenceError("configuration");
  }
}

export async function request(
  path: "/models" | "/chat/completions",
  options: RequestOptions,
  input: {
    body?: Record<string, unknown>;
    signal?: AbortSignal;
    readBody?: (response: Response, signal: AbortSignal) => Promise<unknown>;
  },
) {
  validateOptions(options);
  const encodedBody = input.body ? JSON.stringify(input.body) : undefined;
  if (encodedBody && Buffer.byteLength(encodedBody, "utf8") > MAX_REQUEST_BYTES)
    throw new InferenceError("configuration");
  const deadlineController = new AbortController();
  const timer = setTimeout(
    () => deadlineController.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const deadline = deadlineController.signal;
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  try {
    signal.throwIfAborted();
    const pending = (options.transport ?? fetch)(`${ENDPOINT}${path}`, {
      method: input.body ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "X-NW-Tools-Opt-Out": "true",
      },
      ...(encodedBody ? { body: encodedBody } : {}),
    });
    void pending.then(
      (response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    const response = await abortable(pending, signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new InferenceError(
        response.status === 401 || response.status === 403
          ? "authentication"
          : response.status === 429
            ? "rate_limited"
            : response.status === 413
              ? "context_overflow"
              : "provider",
        response.status === 429 || response.status >= 500,
        response.status,
        response.status === 429 ? retryAfter(response) : undefined,
      );
    }
    const body = record(await (input.readBody ?? boundedJson)(response, signal));
    return {
      body,
      requestId: requestId(response),
      scope: response.headers.get("x-models-scope"),
      serviceTier: response.headers.get("x-nw-service-tier"),
    };
  } catch (error) {
    if (input.signal?.aborted) throw new InferenceError("cancelled");
    if (deadline.aborted) throw new InferenceError("deadline", true);
    if (error instanceof InferenceError) throw error;
    throw new InferenceError("network", true);
  } finally {
    clearTimeout(timer);
  }
}
