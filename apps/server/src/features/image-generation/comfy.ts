import { inspectImageBytes, MAX_IMAGE_BYTES } from "@valerie/core";
import { record } from "../../json";
import type { ComfyGraph } from "./profile";

export interface ComfyImageDescriptor {
  filename: string;
  subfolder: string;
  type: "output";
}
export type ComfyInspection =
  | { status: "pending" | "missing" }
  | { status: "failed"; code: string }
  | { status: "succeeded"; image: ComfyImageDescriptor };
export interface ComfyClient {
  submit(
    workflow: ComfyGraph,
    promptId: string,
    signal: AbortSignal,
  ): Promise<{ status: "queued" | "rejected" | "unknown"; promptId?: string; code?: string }>;
  inspect(promptId: string, signal: AbortSignal): Promise<ComfyInspection>;
  download(image: ComfyImageDescriptor, signal: AbortSignal): Promise<Uint8Array>;
}

export class ComfyError extends Error {
  constructor(
    readonly code:
      | "configuration"
      | "network"
      | "deadline"
      | "cancelled"
      | "server"
      | "invalid_response"
      | "image_too_large"
      | "invalid_image",
  ) {
    super(`ComfyUI request failed: ${code}.`);
    this.name = "ComfyError";
  }
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function descriptor(value: unknown): ComfyImageDescriptor {
  const item = record(value);
  if (
    typeof item.filename !== "string" ||
    item.filename.length > 255 ||
    !/^[A-Za-z0-9_. -]+\.png$/i.test(item.filename) ||
    typeof item.subfolder !== "string" ||
    item.subfolder.length > 512 ||
    (item.subfolder !== "" && !/^[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)*$/.test(item.subfolder)) ||
    item.subfolder.split("/").some((part) => part === "." || part === "..") ||
    item.type !== "output"
  ) {
    throw new ComfyError("invalid_response");
  }
  return { filename: item.filename, subfolder: item.subfolder, type: "output" };
}

/** Bound injected transports too: cancellation is part of this adapter's contract. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ComfyError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function bytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new ComfyError(limit === MAX_IMAGE_BYTES ? "image_too_large" : "invalid_response");
  }
  if (!response.body) throw new ComfyError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new ComfyError(limit === MAX_IMAGE_BYTES ? "image_too_large" : "invalid_response");
      chunks.push(value);
    }
    if (!size) throw new ComfyError("invalid_response");
    return Buffer.concat(chunks);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createComfyClient(options: {
  baseUrl: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
}): ComfyClient {
  const timeoutMs = options.requestTimeoutMs ?? 20_000;
  let base: URL;
  try {
    base = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      throw new Error();
    }
  } catch {
    throw new ComfyError("configuration");
  }
  const transport = options.fetch ?? fetch;
  const clientId = crypto.randomUUID();
  async function request<T>(
    path: string,
    parentSignal: AbortSignal,
    body: unknown | undefined,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([parentSignal, deadline]);
    try {
      signal.throwIfAborted();
      const response = await abortable(
        transport(new URL(path, base).toString(), {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          ...(body === undefined
            ? {}
            : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
          signal,
        }),
        signal,
      );
      return await consume(response, signal);
    } catch (error) {
      if (parentSignal.aborted) throw new ComfyError("cancelled");
      if (deadline.aborted) throw new ComfyError("deadline");
      if (error instanceof ComfyError) throw error;
      throw new ComfyError("network");
    }
  }
  async function json(response: Response, signal: AbortSignal) {
    try {
      return record(
        JSON.parse(Buffer.from(await bytes(response, 2 * 1024 * 1024, signal)).toString("utf8")),
      );
    } catch (error) {
      if (error instanceof ComfyError) throw error;
      throw new ComfyError("invalid_response");
    }
  }
  async function get(path: string, signal: AbortSignal) {
    return request(path, signal, undefined, async (response, requestSignal) => {
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ComfyError("server");
      }
      return json(response, requestSignal);
    });
  }
  return {
    async submit(workflow, promptId, signal) {
      if (!validId(promptId)) throw new ComfyError("configuration");
      return request(
        "/prompt",
        signal,
        { prompt: workflow, prompt_id: promptId, client_id: clientId },
        async (response, requestSignal) => {
          const data = await json(response, requestSignal);
          const returnedId = validId(data.prompt_id) ? data.prompt_id : undefined;
          const hasNodeErrors = Object.keys(record(data.node_errors)).length > 0;
          // Only an explicit validation rejection proves the graph never entered the queue.
          if (response.status === 400 && !returnedId && (data.error || hasNodeErrors))
            return { status: "rejected", code: "workflow_rejected" };
          if (!response.ok || data.error || hasNodeErrors || !returnedId)
            return {
              status: "unknown",
              ...(returnedId ? { promptId: returnedId } : {}),
              code: hasNodeErrors ? "workflow_node_errors" : "submission_uncertain",
            };
          return { status: "queued", promptId: returnedId };
        },
      );
    },
    async inspect(promptId, signal) {
      if (!validId(promptId)) throw new ComfyError("configuration");
      const history = await get(`/history/${promptId}`, signal);
      const entry = record(history[promptId]);
      if (Object.keys(entry).length > 0) {
        const status = record(entry.status);
        if (status.status_str === "error") return { status: "failed", code: "render_failed" };
        if (status.completed === true) {
          if (status.status_str !== "success") return { status: "failed", code: "render_failed" };
          const images = record(record(entry.outputs)["8"]).images;
          if (!Array.isArray(images) || images.length !== 1)
            return { status: "failed", code: "missing_final_image" };
          return { status: "succeeded", image: descriptor(images[0]) };
        }
        return { status: "pending" };
      }
      // Empty history may mean queued, running, or lost after a server restart.
      const queue = await get("/queue", signal);
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending))
        throw new ComfyError("invalid_response");
      const entries = [...queue.queue_running, ...queue.queue_pending];
      return {
        status: entries.some((entry) => Array.isArray(entry) && entry[1] === promptId)
          ? "pending"
          : "missing",
      };
    },
    async download(image, signal) {
      const valid = descriptor(image);
      const query = new URLSearchParams({ ...valid });
      return request(`/view?${query}`, signal, undefined, async (response, requestSignal) => {
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new ComfyError("server");
        }
        const result = await bytes(response, MAX_IMAGE_BYTES, requestSignal);
        try {
          if (inspectImageBytes(result).mimeType !== "image/png")
            throw new ComfyError("invalid_image");
        } catch {
          throw new ComfyError("invalid_image");
        }
        return result;
      });
    },
  };
}
