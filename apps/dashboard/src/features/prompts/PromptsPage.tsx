import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, errorMessage } from "../../app/api";
import { Badge, EmptyState, ErrorNotice, formattedTime } from "../../components/ui";
import { reconcileDrafts } from "./drafts";
import { type DropPosition, movePrompt } from "./order";
import { PromptHistory } from "./PromptHistory";
import { PromptList } from "./PromptList";
import { PromptPreview } from "./PromptPreview";
import { type Draft, draftFromPrompt, type Prompt, type PromptCatalog } from "./types";

export function PromptsPage({
  api,
  onDirtyChange,
}: {
  api: Api;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveState, setSaveState] = useState<
    Record<string, { message: string; error?: boolean; conflict?: boolean }>
  >({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderNeedsReload, setOrderNeedsReload] = useState(false);
  const [orderFeedback, setOrderFeedback] = useState<{ message: string; error?: boolean } | null>(
    null,
  );
  const [tab, setTab] = useState<"edit" | "history">("edit");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [reloadCount, setReloadCount] = useState(0);
  const catalog = useRef<PromptCatalog | null>(null);
  const catalogLoading = useRef(true);
  const orderConfirmed = useRef(false);
  // The ref closes the gap before React renders disabled controls after a click/drop.
  const mutation = useRef<"content" | "order" | null>(null);

  const applyCatalog = useCallback((next: PromptCatalog) => {
    catalog.current = next;
    setPrompts(next.prompts);
    setSelectedId((current) =>
      next.prompts.some((item) => item.id === current) ? current : (next.prompts[0]?.id ?? ""),
    );
    setDrafts((current) => reconcileDrafts(next.prompts, current));
  }, []);

  const reloadPrompts = useCallback(() => {
    if (mutation.current || catalogLoading.current) return;
    catalogLoading.current = true;
    setLoading(true);
    setReloadCount((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual reloads refresh saved versions without clearing dirty drafts.
  useEffect(() => {
    // Fast Refresh may rerun effects during a save. Its older GET must not replace the PUT result.
    if (mutation.current) return;
    const controller = new AbortController();
    catalogLoading.current = true;
    setLoading(true);
    setLoadError("");
    api<PromptCatalog>("/prompts", { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        applyCatalog(next);
        orderConfirmed.current = true;
        setOrderNeedsReload(false);
        setOrderFeedback((current) => (current ? { message: "Current order loaded." } : null));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          catalogLoading.current = false;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [api, reloadCount, applyCatalog]);

  const hasDirtyDrafts = Object.values(drafts).some((draft) => draft.content !== draft.baseContent);
  useEffect(() => {
    onDirtyChange(hasDirtyDrafts || savingOrder || savingId !== null);
  }, [hasDirtyDrafts, savingOrder, savingId, onDirtyChange]);

  const removedDrafts = Object.entries(drafts).filter(
    ([id, draft]) =>
      !prompts.some((prompt) => prompt.id === id) && draft.content !== draft.baseContent,
  );

  const selected = prompts.find((prompt) => prompt.id === selectedId);
  const draft = drafts[selectedId];
  const dirty = draft !== undefined && draft.content !== draft.baseContent;
  const feedback = saveState[selectedId];
  const busy = loading || savingId !== null || savingOrder;

  const move = async (movingId: string, targetId: string, position: DropPosition) => {
    const current = catalog.current;
    if (!current || catalogLoading.current || mutation.current || !orderConfirmed.current) return;
    const ids = movePrompt(current.prompts, movingId, targetId, position);
    if (!ids) {
      setOrderFeedback({ message: "This section is already in that position." });
      return;
    }

    mutation.current = "order";
    setSavingOrder(true);
    setOrderFeedback({ message: "Saving order…" });
    try {
      const next = await api<PromptCatalog>("/prompts/order", {
        method: "PUT",
        body: JSON.stringify({ ids, expectedOrderVersion: current.orderVersion }),
      });
      applyCatalog(next);
      setOrderFeedback({ message: "Order saved. Applies to the next request." });
      setSavedCount((count) => count + 1);
    } catch (error) {
      // A lost response may still have committed. Read the server before another attempt.
      orderConfirmed.current = false;
      setOrderNeedsReload(true);
      setOrderFeedback({
        message:
          error instanceof ApiError && error.status === 409
            ? "The prompt order changed in another tab. Reload the current order before moving sections again. Your unsaved text is kept."
            : `Could not confirm the saved order. ${errorMessage(error)} Reload before moving sections again. Your unsaved text is kept.`,
        error: true,
      });
    } finally {
      mutation.current = null;
      setSavingOrder(false);
    }
  };

  const updateDraft = (content: string) => {
    setDrafts((current) => {
      const existing = current[selectedId];
      return existing ? { ...current, [selectedId]: { ...existing, content } } : current;
    });
    setSaveState((current) => {
      if (current[selectedId]?.error) return current;
      const next = { ...current };
      delete next[selectedId];
      return next;
    });
  };

  const save = useCallback(async () => {
    if (!selected || !draft || !dirty || mutation.current || catalogLoading.current) return;
    const id = selected.id;
    const content = draft.content;
    mutation.current = "content";
    setSavingId(id);
    setSaveState((current) => ({ ...current, [id]: { message: "Saving…" } }));
    try {
      const { prompt } = await api<{ prompt: Prompt }>(`/prompts/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ content, expectedVersion: draft.baseVersion }),
      });
      if (catalog.current) {
        catalog.current = {
          ...catalog.current,
          prompts: catalog.current.prompts.map((item) => (item.id === id ? prompt : item)),
        };
      }
      setPrompts((current) => current.map((item) => (item.id === id ? prompt : item)));
      setDrafts((current) => ({
        ...current,
        [id]: {
          content: current[id]?.content ?? content,
          baseContent: prompt.content,
          baseVersion: prompt.version,
        },
      }));
      setSaveState((current) => ({
        ...current,
        [id]: { message: `Version ${prompt.version} saved. Ready for the next request.` },
      }));
      setSavedCount((count) => count + 1);
    } catch (error) {
      setSaveState((current) => ({
        ...current,
        [id]: {
          message: errorMessage(error),
          error: true,
          conflict: error instanceof ApiError && error.status === 409,
        },
      }));
    } finally {
      mutation.current = null;
      setSavingId(null);
    }
  }, [api, selected, draft, dirty]);

  const resetDraft = () => {
    if (!selected || !dirty || !window.confirm("Discard your unsaved changes to this prompt?"))
      return;
    setDrafts((current) => ({ ...current, [selectedId]: draftFromPrompt(selected) }));
    setSaveState((current) => ({
      ...current,
      [selectedId]: { message: "Draft reset to the loaded saved version." },
    }));
  };

  const useRevision = (content: string) => {
    if (!selected) return;
    if (dirty && !window.confirm("Replace your unsaved changes with this saved version?")) return;
    setDrafts((current) => ({
      ...current,
      [selectedId]: { ...draftFromPrompt(selected), content },
    }));
    setSaveState((current) => ({
      ...current,
      [selectedId]: {
        message: "Saved version opened as a draft. Save when you’re ready to apply it.",
      },
    }));
    setTab("edit");
  };

  const resolveConflict = () => {
    if (
      !selected ||
      !window.confirm(
        `Keep your draft and prepare to replace saved version ${selected.version}? You will still need to save it.`,
      )
    )
      return;
    setDrafts((current) => {
      const existing = current[selectedId];
      return existing
        ? {
            ...current,
            [selectedId]: { ...draftFromPrompt(selected), content: existing.content },
          }
        : current;
    });
    setSaveState((current) => ({
      ...current,
      [selectedId]: { message: `Your draft is ready to save over version ${selected.version}.` },
    }));
  };

  return (
    <section className="page" aria-labelledby="prompts-title">
      <div className="page-heading">
        <div>
          <h1 id="prompts-title">Prompts</h1>
          <p className="page-description">
            Edit Valerie’s character and channel instructions. Saved changes apply to the next
            request.
          </p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => setPreviewOpen((open) => !open)}
          aria-expanded={previewOpen}
        >
          {previewOpen ? "Hide channel preview" : "Preview by channel"}
          <span aria-hidden="true">↗</span>
        </button>
      </div>

      {loadError && (
        <ErrorNotice message={loadError}>
          <button type="button" className="text-button" onClick={reloadPrompts} disabled={busy}>
            Retry loading prompts
          </button>
        </ErrorNotice>
      )}
      {loading && prompts.length === 0 && (
        <div className="panel panel-padding muted" role="status">
          Loading prompts…
        </div>
      )}
      {!loading && !loadError && prompts.length === 0 && (
        <div className="panel">
          <EmptyState title="No prompts found">
            <p>The service has not created any prompt sections.</p>
          </EmptyState>
        </div>
      )}

      {removedDrafts.map(([id, removedDraft]) => (
        <div className="panel panel-padding" key={id} role="alert">
          <h2>Unsaved text from a removed section</h2>
          <p>
            This section was removed. Copy any text you want to keep before discarding this draft.
          </p>
          <textarea
            className="prompt-reading"
            aria-label="Unsaved draft from a removed prompt section"
            readOnly
            value={removedDraft.content}
          />
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              if (!window.confirm("Discard this unsaved draft from the removed section?")) return;
              setDrafts((current) => {
                const next = { ...current };
                delete next[id];
                return next;
              });
            }}
          >
            Discard draft
          </button>
        </div>
      ))}

      {prompts.length > 0 && (
        <div className="prompt-workspace">
          <aside className="panel prompt-library" aria-label="Prompt sections">
            <div className="library-heading">
              <h2>Sections</h2>
              <span>{prompts.length.toString().padStart(2, "0")}</span>
            </div>
            <div className="library-order-help">
              <p id="prompt-order-help">
                Drag sections into order, or use the arrow buttons. Applicable system sections are
                sent from top to bottom. Post-History Instructions stays last, after the
                conversation history.
              </p>
              {orderFeedback && (
                <p
                  className={orderFeedback.error ? "order-feedback is-error" : "order-feedback"}
                  role={orderFeedback.error ? "alert" : "status"}
                >
                  {orderFeedback.message}
                </p>
              )}
              {orderNeedsReload && (
                <button
                  type="button"
                  className="text-button"
                  onClick={reloadPrompts}
                  disabled={busy}
                >
                  {loading ? "Reloading…" : "Reload current order"}
                </button>
              )}
            </div>
            <PromptList
              prompts={prompts}
              drafts={drafts}
              selectedId={selectedId}
              disabled={busy || orderNeedsReload || Boolean(loadError)}
              onSelect={(id) => {
                setSelectedId(id);
                setTab("edit");
                const editor = document.getElementById("prompt-editor");
                editor?.scrollTo({ top: 0 });
                if (window.matchMedia("(max-width: 960px)").matches) {
                  editor?.scrollIntoView({ block: "start" });
                }
              }}
              onMove={(movingId, targetId, position) => void move(movingId, targetId, position)}
            />
            <div className="library-footer">
              <span className="status-dot status-dot--success" aria-hidden="true" />
              <span>Saved changes apply to the next request.</span>
            </div>
          </aside>

          {selected && draft && (
            <article
              id="prompt-editor"
              className="panel prompt-editor"
              aria-labelledby="editor-title"
            >
              <div className="editor-heading">
                <div>
                  <p className="eyebrow">Prompt section</p>
                  <h2 id="editor-title">{selected.title}</h2>
                  <p>{selected.purpose}</p>
                </div>
                <Badge tone={dirty ? "warning" : "neutral"}>
                  {dirty ? "Unsaved draft" : `Version ${selected.version}`}
                </Badge>
              </div>
              <div className="editor-tabs">
                <fieldset className="segmented">
                  <legend className="sr-only">Editor view</legend>
                  <button
                    type="button"
                    className={tab === "edit" ? "is-active" : ""}
                    onClick={() => setTab("edit")}
                    aria-pressed={tab === "edit"}
                  >
                    Edit prompt
                  </button>
                  <button
                    type="button"
                    className={tab === "history" ? "is-active" : ""}
                    onClick={() => setTab("history")}
                    aria-pressed={tab === "history"}
                  >
                    Version history
                  </button>
                </fieldset>
                <span className="editor-timestamp">Saved {formattedTime(selected.updatedAt)}</span>
              </div>
              {tab === "edit" ? (
                <>
                  <label className="sr-only" htmlFor="prompt-content">
                    {selected.title} content
                  </label>
                  <textarea
                    id="prompt-content"
                    className="prompt-textarea"
                    value={draft.content}
                    onChange={(event) => updateDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                        event.preventDefault();
                        void save();
                      }
                    }}
                    placeholder="Enter prompt text…"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-describedby="prompt-preservation"
                  />
                  <div className="editor-metadata">
                    <span id="prompt-preservation">Your text is saved as entered.</span>
                    <span>{draft.content.length.toLocaleString()} characters</span>
                  </div>
                  {feedback?.error && (
                    <div className="editor-feedback">
                      <ErrorNotice message={feedback.message}>
                        {feedback.conflict && (
                          <>
                            <p>
                              Open version history to review the current saved text. Reloading the
                              prompts preserves your draft.
                            </p>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => {
                                reloadPrompts();
                                setTab("history");
                              }}
                              disabled={busy}
                            >
                              Review current version
                            </button>
                            {selected.version > draft.baseVersion && (
                              <div>
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={resolveConflict}
                                >
                                  Keep my draft over version {selected.version}
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </ErrorNotice>
                    </div>
                  )}
                  <div className="editor-footer">
                    <p role="status" aria-live="polite">
                      {feedback && !feedback.error
                        ? feedback.message
                        : dirty
                          ? "Changes are kept in this tab until you save."
                          : "All changes saved."}
                    </p>
                    <div className="button-group">
                      <button
                        type="button"
                        className="button button--quiet"
                        onClick={resetDraft}
                        disabled={!dirty || savingId === selectedId}
                      >
                        Reset draft
                      </button>
                      <button
                        type="button"
                        className="button button--primary"
                        onClick={() => void save()}
                        disabled={!dirty || busy}
                      >
                        {savingId === selectedId ? "Saving…" : "Save prompt"}
                        <span aria-hidden="true">↗</span>
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <PromptHistory api={api} prompt={selected} onUseRevision={useRevision} />
              )}
            </article>
          )}
        </div>
      )}
      {previewOpen && (
        <PromptPreview api={api} revision={savedCount} onClose={() => setPreviewOpen(false)} />
      )}
      <p className="page-footnote">
        Text and voice have separate channel instructions. Shared character sections keep Valerie
        consistent across them.
      </p>
    </section>
  );
}
