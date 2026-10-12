import type { ImageJobService } from "@valerie/core";
import { delay } from "../../delay";
import { type ComfyClient, ComfyError } from "./comfy";
import type { ComfyGraph } from "./profile";

/** Run under the process runtime's Telegram lease, independently of conversational inference. */
export function createImageGenerationWorker(options: {
  service: ImageJobService;
  client: ComfyClient;
  pollMs?: number;
  now?: () => number;
}) {
  const { service, client } = options;
  const pollMs = options.pollMs ?? 3000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 10_000)
    throw new ComfyError("configuration");
  let busy = false;
  let fenced = false;

  function active(signal: AbortSignal, assertActive: () => void): boolean {
    if (fenced || signal.aborted) return false;
    try {
      assertActive();
    } catch {
      // Losing the lifecycle lease permanently fences this worker, even if a custom
      // assertion does not abort its signal. A successor alone may update durable work.
      fenced = true;
      return false;
    }
    return !signal.aborted;
  }

  async function tick(signal: AbortSignal, assertActive: () => void = () => {}): Promise<boolean> {
    if (busy || !active(signal, assertActive)) return false;
    busy = true;
    try {
      let job = service.nextPendingRender();
      if (!job) return false;
      if (job.status === "queued") {
        if (!active(signal, assertActive)) return false;
        job = service.claimRender();
        if (!job) return false;
        // The persisted submitting state is committed BEFORE the non-idempotent request.
        // A crash at this boundary deliberately prefers an unknown outcome to a duplicate.
        try {
          if (!active(signal, assertActive)) return true;
          const result = await client.submit(job.workflow as ComfyGraph, job.promptId, signal);
          if (!active(signal, assertActive)) return true;
          if (result.promptId) service.markSubmitted(job.id, result.promptId);
          if (result.status === "rejected")
            service.fail(job.id, result.code ?? "workflow_rejected");
          else if (result.status === "unknown")
            service.markRecovery(job.id, result.code ?? "submission_uncertain");
          else if (!result.promptId) service.markRecovery(job.id, "submission_uncertain");
        } catch (error) {
          if (!active(signal, assertActive)) return true;
          service.markRecovery(
            job.id,
            error instanceof ComfyError ? error.code : "submission_uncertain",
          );
        }
        return true;
      }
      if (!job.deadlineAt || Date.parse(job.deadlineAt) <= now()) {
        if (!active(signal, assertActive)) return true;
        service.fail(job.id, "render_deadline", { unknown: true });
        return true;
      }
      const deadline = AbortSignal.timeout(Math.max(1, Date.parse(job.deadlineAt) - now()));
      const requestSignal = AbortSignal.any([signal, deadline]);
      try {
        if (!active(signal, assertActive)) return true;
        const result = await client.inspect(job.submittedPromptId ?? job.promptId, requestSignal);
        if (!active(signal, assertActive)) return true;
        if (result.status === "failed") service.fail(job.id, result.code);
        else if (result.status === "succeeded") {
          // Correlate the artifact with the pinned SaveImage prefix as well as the API ID.
          // Even an unexpected returned prompt ID cannot attach another request's picture.
          if (
            result.image.subfolder !== `Valerie/App/${job.id}` ||
            !result.image.filename.startsWith("Refined_")
          ) {
            service.fail(job.id, "output_mismatch", { unknown: true });
            return true;
          }
          if (!active(signal, assertActive)) return true;
          const image = await client.download(result.image, requestSignal);
          if (active(signal, assertActive)) service.saveImage(job.id, image);
        } else if (result.status === "missing") {
          service.markRecovery(job.id, "render_not_found");
        }
      } catch (error) {
        if (!active(signal, assertActive)) return true;
        if (deadline.aborted) service.fail(job.id, "render_deadline", { unknown: true });
        else if (
          error instanceof ComfyError &&
          ["invalid_image", "image_too_large"].includes(error.code)
        )
          service.fail(job.id, error.code);
        else
          service.markRecovery(
            job.id,
            error instanceof ComfyError ? error.code : "render_poll_failed",
          );
      }
      return true;
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    async run(signal: AbortSignal, assertActive: () => void = () => {}): Promise<void> {
      while (!signal.aborted && !fenced) {
        await tick(signal, assertActive);
        if (!active(signal, assertActive)) return;
        await delay(pollMs, signal);
      }
    },
  };
}
