import { createImageJobService, type ImageJob, type Store } from "@valerie/core";
import type { ImageGenerationBinding, ImageToolInvocation } from "../conversation/inference";
import { createComfyClient } from "./comfy";
import { ImageRequestError, loadImageWorkflow, prepareImageRequest } from "./profile";
import { createImageGenerationWorker } from "./worker";

/** Construct configuration only; the Telegram lifecycle owns starting and stopping the loop. */
export function createImageRuntime(store: Store, env: Record<string, string | undefined>) {
  const baseUrl = env.COMFYUI_BASE_URL?.trim();
  const directory = env.COMFYUI_WORKFLOW_DIR?.trim();
  if (!baseUrl && !directory) return undefined;
  if (!baseUrl || !directory)
    throw new Error("Both ComfyUI URL and private workflow directory are required.");
  const profile = loadImageWorkflow(directory);
  const service = createImageJobService(store);
  const worker = createImageGenerationWorker({ service, client: createComfyClient({ baseUrl }) });
  const invocationFor = (job: ImageJob): ImageToolInvocation => {
    if (!job.invocation) throw new Error("Image request has no stored tool invocation.");
    const completion = job.invocation.completion;
    return {
      call: job.invocation.call,
      completion: {
        requestId: completion?.requestId ?? null,
        costUsd: completion?.costUsd ?? null,
        usage: {
          inputTokens: completion?.usage?.inputTokens ?? null,
          outputTokens: completion?.usage?.outputTokens ?? null,
          cachedInputTokens: completion?.usage?.cachedInputTokens ?? null,
          reasoningTokens: completion?.usage?.reasoningTokens ?? null,
        },
      },
      result: { jobId: job.id, status: job.status },
    };
  };
  const binding: ImageGenerationBinding = {
    getForTurn(turnId) {
      const job = service.getForTurn(turnId);
      return job ? invocationFor(job) : null;
    },
    enqueue({ turnId, args, invocation }) {
      const existing = service.getForTurn(turnId);
      if (existing) return invocationFor(existing);
      try {
        const id = crypto.randomUUID();
        const request = prepareImageRequest(profile, args, { jobId: id });
        return invocationFor(
          service.enqueue({
            id,
            turnId,
            toolCallId: invocation.call.id,
            invocation,
            framing: request.framing,
            sceneTags: request.sceneTags,
            seed: request.seed,
            workflow: request.workflow,
            prompt: request.positivePrompt,
          }),
        );
      } catch (error) {
        if (error instanceof ImageRequestError) throw new TypeError(error.code);
        throw error;
      }
    },
  };
  return { service, binding, run: worker.run };
}
