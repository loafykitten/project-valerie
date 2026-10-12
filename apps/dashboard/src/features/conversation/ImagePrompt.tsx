import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";

type ImagePromptDetails = {
  positivePrompt: string;
  negativePrompt: string | null;
  faceGuidance: string | null;
  faceNegativePrompt: string | null;
  framing: "selfie" | "full_body";
  sceneTags: string[];
  seed: number;
};

export function ImagePrompt({ api, jobId }: { api: Api; jobId: string }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<ImagePromptDetails | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the same immutable job.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    setPrompt(null);
    api<ImagePromptDetails>(`/conversation/image-jobs/${encodeURIComponent(jobId)}/prompt`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setPrompt(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [api, jobId, open, retry]);

  return (
    <details className="image-prompt" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Image prompt</summary>
      {open && (
        <div className="image-prompt-content">
          <p className="muted">
            The saved prompt for this image. Later prompt edits do not change it.
          </p>
          {error ? (
            <ErrorNotice message={error}>
              <button
                type="button"
                className="text-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Try again
              </button>
            </ErrorNotice>
          ) : !prompt ? (
            <p className="muted" role="status">
              Loading image prompt…
            </p>
          ) : (
            <>
              <p className="muted">
                {prompt.framing === "selfie" ? "Selfie" : "Full body"} · Seed {prompt.seed}
              </p>
              <dl>
                <dt>Scene tags chosen by Valerie</dt>
                <dd>{prompt.sceneTags.join(", ")}</dd>
                <dt>Positive prompt</dt>
                <dd>{prompt.positivePrompt}</dd>
                {prompt.negativePrompt && (
                  <>
                    <dt>Negative prompt</dt>
                    <dd>{prompt.negativePrompt}</dd>
                  </>
                )}
                {prompt.faceGuidance && (
                  <>
                    <dt>Additional face guidance</dt>
                    <dd>{prompt.faceGuidance}</dd>
                  </>
                )}
                {prompt.faceNegativePrompt && (
                  <>
                    <dt>Additional face negative prompt</dt>
                    <dd>{prompt.faceNegativePrompt}</dd>
                  </>
                )}
              </dl>
            </>
          )}
        </div>
      )}
    </details>
  );
}
