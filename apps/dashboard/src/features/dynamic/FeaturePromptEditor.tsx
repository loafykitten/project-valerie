import { useEffect, useRef, useState } from "react";
import { type Api, ApiError, errorMessage } from "../../app/api";
import { Badge, ErrorNotice, formattedTime } from "../../components/ui";
import { PromptHistory } from "../prompts/PromptHistory";
import { type Draft, draftFromPrompt, type Prompt, type PromptCatalog } from "../prompts/types";

export function FeaturePromptEditor({
  api,
  visible,
  onDirtyChange,
  promptId,
  title,
  description,
}: {
  api: Api;
  promptId: string;
  title: string;
  description: string;
  visible: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<"edit" | "history">("edit");
  const writing = useRef(false);
  const reading = useRef(false);
  const dirty = draft !== null && draft.content !== draft.baseContent;
  const conflict = draft !== null && prompt !== null && draft.baseVersion !== prompt.version;
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh updates the saved revision while preserving an unsaved draft.
  useEffect(() => {
    if (!visible || writing.current) return;
    const controller = new AbortController();
    reading.current = true;
    setLoading(true);
    setError("");
    api<PromptCatalog>("/prompts", { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const current = result.prompts.find((item) => item.id === promptId);
        if (!current) {
          setError(
            `The ${title} prompt is unavailable. Refresh after the service update finishes.`,
          );
          return;
        }
        setPrompt(current);
        setDraft((previous) =>
          previous && previous.content !== previous.baseContent
            ? previous
            : draftFromPrompt(current),
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          reading.current = false;
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      reading.current = false;
    };
  }, [api, visible, refresh, promptId, title]);

  async function save() {
    if (!prompt || !draft || !dirty || conflict || writing.current || reading.current) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { prompt: saved } = await api<{ prompt: Prompt }>(
        `/prompts/${encodeURIComponent(promptId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ content: draft.content, expectedVersion: draft.baseVersion }),
        },
      );
      setPrompt(saved);
      setDraft(draftFromPrompt(saved));
      setNotice(`Version ${saved.version} saved. Applies to the next conversation.`);
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) setRefresh((value) => value + 1);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  return (
    <article className="panel dynamic-prompt" aria-labelledby={`dynamic-prompt-${promptId}-title`}>
      <div className="dynamic-panel">
        <div className="dynamic-heading">
          <div>
            <p className="eyebrow">Feature prompt</p>
            <h2 id={`dynamic-prompt-${promptId}-title`}>{title}</h2>
          </div>
          {prompt && (
            <Badge tone={dirty ? "warning" : "neutral"}>
              {dirty ? "Unsaved draft" : `Version ${prompt.version}`}
            </Badge>
          )}
        </div>
        <p className="dynamic-intro">{description}</p>
        {error && <ErrorNotice message={error} />}
        {notice && (
          <p className="dynamic-feedback" role="status">
            {notice}
          </p>
        )}
        <div className="dynamic-heading">
          <fieldset className="segmented" disabled={!prompt || loading || busy}>
            <legend className="sr-only">{title} prompt view</legend>
            <button
              type="button"
              className={tab === "edit" ? "is-active" : ""}
              aria-pressed={tab === "edit"}
              onClick={() => setTab("edit")}
            >
              Edit prompt
            </button>
            <button
              type="button"
              className={tab === "history" ? "is-active" : ""}
              aria-pressed={tab === "history"}
              onClick={() => setTab("history")}
            >
              Version history
            </button>
          </fieldset>
          <button
            type="button"
            className="text-button"
            disabled={loading || busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh saved prompt
          </button>
        </div>
      </div>
      {!prompt || !draft ? (
        <p className="panel-padding muted">{loading ? "Loading prompt…" : "Prompt unavailable."}</p>
      ) : tab === "history" ? (
        <PromptHistory
          api={api}
          prompt={prompt}
          idPrefix={promptId}
          onUseRevision={(content) => {
            if (dirty && !window.confirm("Replace your unsaved prompt with this saved version?"))
              return;
            setDraft({ ...draftFromPrompt(prompt), content });
            setTab("edit");
            setNotice("Saved version opened as a draft. Save it to apply.");
          }}
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="sr-only" htmlFor={`dynamic-prompt-${promptId}-content`}>
            {title} prompt content
          </label>
          <textarea
            id={`dynamic-prompt-${promptId}-content`}
            className="prompt-textarea"
            value={draft.content}
            disabled={busy}
            onChange={(event) => {
              setDraft({ ...draft, content: event.target.value });
              setNotice("");
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "s") {
                event.preventDefault();
                void save();
              }
            }}
          />
          <div className="dynamic-panel">
            {conflict && (
              <div className="notice dynamic-conflict" role="status">
                <p>A newer version was saved elsewhere. Your draft is kept.</p>
                <details>
                  <summary>Read saved version {prompt.version}</summary>
                  <pre className="dynamic-saved-version">{prompt.content}</pre>
                </details>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setDraft({ ...draftFromPrompt(prompt), content: draft.content });
                    setError("");
                    setNotice("Your draft is ready to save over the latest version.");
                  }}
                >
                  Keep my draft over the latest version
                </button>
              </div>
            )}
            <div className="dynamic-actions">
              <button
                type="submit"
                className="button button--primary"
                disabled={busy || loading || !dirty || conflict}
              >
                {busy ? "Saving…" : "Save prompt"}
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy || loading || !dirty}
                onClick={() => {
                  if (!window.confirm("Discard the unsaved changes to this prompt?")) return;
                  setDraft(draftFromPrompt(prompt));
                  setError("");
                  setNotice("");
                }}
              >
                Use saved prompt
              </button>
              <span className="muted dynamic-prompt-time">
                Saved {formattedTime(prompt.updatedAt)}
              </span>
            </div>
          </div>
        </form>
      )}
    </article>
  );
}
