import type { DynamicSettings, GrowthFocus, GrowthFocusState } from "@valerie/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, EmptyState, ErrorNotice, formattedTime } from "../../components/ui";
import { AgreementsPage } from "./AgreementsPage";
import { ContextHealthPanel } from "./ContextHealthPanel";
import { DailyDetailsPage } from "./DailyDetailsPage";
import { FeaturePrompts } from "./FeaturePrompts";
import { FocusEditor } from "./FocusEditor";
import { FocusNotes, FocusSources } from "./FocusNotes";
import { FocusPermissions } from "./FocusPermissions";
import {
  type FocusDraft,
  focusChanged,
  focusDate,
  focusDraft,
  focusDraftError,
  focusFields,
  focusStatus,
} from "./presentation";
import { RemindersPage } from "./RemindersPage";
import "./dynamic.css";

type DynamicState = {
  settings: DynamicSettings;
  current: GrowthFocus | null;
  history: GrowthFocus[];
};
type Editor = { draft: FocusDraft; base: FocusDraft };

export function DynamicDetailsPage({
  api,
  visible,
  onDirtyChange,
}: {
  api: Api;
  visible: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [state, setState] = useState<DynamicState | null>(null);
  const [selected, setSelected] = useState<GrowthFocus | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [tab, setTab] = useState<"focus" | "daily" | "agreements" | "reminders" | "prompts">(
    "focus",
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [noteDirty, setNoteDirty] = useState(false);
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const [dailyDirty, setDailyDirty] = useState(false);
  const [agreementsDirty, setAgreementsDirty] = useState(false);
  const [remindersDirty, setRemindersDirty] = useState(false);
  const writing = useRef(false);
  const reading = useRef(false);
  const activeRead = useRef<AbortController | null>(null);
  const selectionInitialized = useRef(false);
  const editorDirty = editor !== null && focusChanged(editor.draft, editor.base);
  const requestRefresh = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => {
    onDirtyChange(
      editorDirty ||
        noteDirty ||
        permissionsDirty ||
        promptDirty ||
        dailyDirty ||
        agreementsDirty ||
        remindersDirty ||
        busy,
    );
  }, [
    editorDirty,
    noteDirty,
    permissionsDirty,
    promptDirty,
    dailyDirty,
    agreementsDirty,
    remindersDirty,
    busy,
    onDirtyChange,
  ]);

  const acceptState = useCallback((next: DynamicState) => {
    setState((previous) =>
      previous && previous.settings.version > next.settings.version
        ? { ...next, settings: previous.settings }
        : next,
    );
    setSelected((previous) => {
      if (!selectionInitialized.current) {
        selectionInitialized.current = true;
        return next.current;
      }
      if (!previous) return next.current;
      return next.current?.id === previous.id
        ? next.current
        : (next.history.find((focus) => focus.id === previous.id) ?? previous);
    });
    setLoadError("");
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Polling and manual refresh keep saved state current without replacing drafts.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    activeRead.current = controller;
    async function load() {
      if (reading.current || writing.current) return;
      reading.current = true;
      setLoading(true);
      try {
        const next = await api<DynamicState>("/dynamic", { signal: controller.signal });
        if (!controller.signal.aborted && !writing.current) acceptState(next);
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause));
      } finally {
        reading.current = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      controller.abort();
      activeRead.current = null;
      reading.current = false;
      window.clearInterval(timer);
    };
  }, [api, visible, refresh, acceptState]);

  function acceptFocus(focus: GrowthFocus) {
    setState((previous) =>
      previous
        ? {
            ...previous,
            current:
              focus.state !== "archived"
                ? focus
                : previous.current?.id === focus.id
                  ? null
                  : previous.current,
            history: [focus, ...previous.history.filter((item) => item.id !== focus.id)].slice(
              0,
              20,
            ),
          }
        : previous,
    );
    setSelected(focus);
  }

  function startEditor(focus: GrowthFocus | null) {
    if (!focus && noteDirty) {
      setError("Copy or discard the open note before starting another focus.");
      return;
    }
    if (editorDirty && !window.confirm("Discard the unsaved focus changes?")) return;
    const next = focusDraft(focus);
    setEditor({ draft: next, base: next });
    setEditorError("");
    setError("");
    setNotice("");
  }

  async function saveFocus() {
    if (!editor || writing.current) return;
    if (!editor.draft.id && noteDirty) {
      setEditorError("Copy or discard the open note before starting another focus.");
      return;
    }
    const invalid = focusDraftError(editor.draft);
    if (invalid) {
      setEditorError(invalid);
      return;
    }
    if (!editor.draft.id && state?.current) {
      setEditorError(
        "A current focus already exists. Archive it before starting another; your new draft is kept.",
      );
      return;
    }
    writing.current = true;
    activeRead.current?.abort();
    reading.current = false;
    setBusy(true);
    setEditorError("");
    setNotice("");
    try {
      const path = editor.draft.id
        ? `/dynamic/focus/${encodeURIComponent(editor.draft.id)}`
        : "/dynamic/focus";
      const { focus } = await api<{ focus: GrowthFocus }>(path, {
        method: editor.draft.id ? "PUT" : "POST",
        body: JSON.stringify({
          ...focusFields(editor.draft),
          ...(editor.draft.id ? { expectedVersion: editor.draft.baseVersion } : {}),
        }),
      });
      acceptFocus(focus);
      setEditor(null);
      setNotice("Focus saved. Valerie will have the current focus for your next conversation.");
    } catch (cause) {
      setEditorError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      setRefresh((value) => value + 1);
    }
  }

  async function changeState(next: GrowthFocusState) {
    if (!selected || writing.current) return;
    if (next === "archived" && (noteDirty || editorDirty)) {
      setError("Save or discard the open draft before archiving this focus.");
      return;
    }
    if (
      next === "archived" &&
      !window.confirm(
        "Archive this focus? It will remain available in the history, and you can choose a new focus.",
      )
    )
      return;
    writing.current = true;
    activeRead.current?.abort();
    reading.current = false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { focus } = await api<{ focus: GrowthFocus }>(
        `/dynamic/focus/${encodeURIComponent(selected.id)}/state`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: selected.version, state: next }),
        },
      );
      acceptFocus(focus);
      setNotice(
        next === "archived"
          ? "Focus archived. Your notes are kept."
          : next === "paused"
            ? "Focus paused. Your notes are kept, and it can be resumed when you want."
            : "Focus resumed.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      setRefresh((value) => value + 1);
    }
  }

  function selectFocus(focus: GrowthFocus) {
    if (focus.id === selected?.id) return;
    if (
      (editorDirty || noteDirty) &&
      !window.confirm("Discard the unsaved focus or note draft before opening another focus?")
    )
      return;
    setEditor(null);
    setSelected(focus);
    setError("");
    setNotice("");
  }

  const latestEdited = editor?.draft.id
    ? (state?.history.find((focus) => focus.id === editor.draft.id) ??
      (selected?.id === editor.draft.id ? selected : null))
    : null;
  const status = selected ? focusStatus(selected) : null;
  return (
    <section className="page dynamic-page" aria-labelledby="dynamic-title">
      <div className="page-heading">
        <div>
          <h1 id="dynamic-title">Dynamic Details</h1>
          <p className="page-description">
            Your current focus, daily rhythm, and what you’re learning along the way.
          </p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          disabled={loading || busy}
          onClick={requestRefresh}
        >
          {loading ? "Refreshing…" : "Refresh details"}
        </button>
      </div>
      <fieldset className="segmented dynamic-tabs">
        <legend className="sr-only">Dynamic Details view</legend>
        <button
          type="button"
          className={tab === "focus" ? "is-active" : ""}
          aria-pressed={tab === "focus"}
          onClick={() => setTab("focus")}
        >
          Growth Focus
        </button>
        <button
          type="button"
          className={tab === "daily" ? "is-active" : ""}
          aria-pressed={tab === "daily"}
          onClick={() => setTab("daily")}
        >
          Daily Details{dailyDirty ? " •" : ""}
        </button>
        <button
          type="button"
          className={tab === "agreements" ? "is-active" : ""}
          aria-pressed={tab === "agreements"}
          onClick={() => setTab("agreements")}
        >
          Habits &amp; Rules{agreementsDirty ? " •" : ""}
        </button>
        <button
          type="button"
          className={tab === "reminders" ? "is-active" : ""}
          aria-pressed={tab === "reminders"}
          onClick={() => setTab("reminders")}
        >
          Reminders{remindersDirty ? " •" : ""}
        </button>
        <button
          type="button"
          className={tab === "prompts" ? "is-active" : ""}
          aria-pressed={tab === "prompts"}
          onClick={() => setTab("prompts")}
        >
          Prompts{promptDirty ? " •" : ""}
        </button>
      </fieldset>
      <div hidden={tab !== "focus"}>
        {loadError && <ErrorNotice message={loadError} />}
        {error && <ErrorNotice message={error} />}
        {notice && (
          <div className="notice dynamic-feedback" role="status">
            <p>{notice}</p>
          </div>
        )}
        {!state ? (
          <div className="panel dynamic-panel">
            <p className="muted">
              {loading ? "Loading Dynamic Details…" : "Dynamic Details are unavailable."}
            </p>
          </div>
        ) : (
          <>
            {state.current && selected?.id !== state.current.id && (
              <button
                type="button"
                className="text-button dynamic-current-link"
                onClick={() => selectFocus(state.current as GrowthFocus)}
              >
                ← Back to current focus: {state.current.title}
              </button>
            )}
            <div className="dynamic-columns">
              <div>
                {editor ? (
                  <FocusEditor
                    draft={editor.draft}
                    latest={latestEdited}
                    dirty={editorDirty}
                    busy={busy}
                    error={editorError}
                    onChange={(patch) =>
                      setEditor((previous) =>
                        previous
                          ? { ...previous, draft: { ...previous.draft, ...patch } }
                          : previous,
                      )
                    }
                    onSave={() => void saveFocus()}
                    onClose={() => {
                      if (!editorDirty || window.confirm("Discard these unsaved focus changes?"))
                        setEditor(null);
                    }}
                    onUseSaved={() => {
                      if (
                        latestEdited &&
                        window.confirm("Discard the draft and use the saved focus?")
                      ) {
                        const next = focusDraft(latestEdited);
                        setEditor({ draft: next, base: next });
                        setEditorError("");
                      }
                    }}
                    onKeepDraft={() => {
                      if (latestEdited)
                        setEditor((previous) =>
                          previous
                            ? {
                                base: focusDraft(latestEdited),
                                draft: { ...previous.draft, baseVersion: latestEdited.version },
                              }
                            : previous,
                        );
                      setEditorError("");
                    }}
                  />
                ) : selected && status ? (
                  <article
                    className="panel dynamic-panel dynamic-focus"
                    aria-labelledby="current-focus-title"
                  >
                    <div className="dynamic-heading">
                      <p className="eyebrow">
                        {selected.state === "archived" ? "Previous focus" : "Current focus"}
                      </p>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </div>
                    <h2 id="current-focus-title">{selected.title}</h2>
                    <p className="dynamic-reason">{selected.reason}</p>
                    <dl className="dynamic-focus-dates">
                      <div>
                        <dt>Start</dt>
                        <dd>{focusDate(selected.startDate)}</dd>
                      </div>
                      <div>
                        <dt>Review together</dt>
                        <dd>{focusDate(selected.reviewDate)}</dd>
                      </div>
                    </dl>
                    {selected.reviewDue && selected.state === "active" && (
                      <p className="dynamic-review-note">
                        A chance to continue, adjust or change focus. Nothing here means you should
                        be finished.
                      </p>
                    )}
                    {selected.state === "paused" && (
                      <p className="dynamic-review-note">
                        Paused. This focus is kept here and is not used as active guidance.
                      </p>
                    )}
                    {selected.practices.length > 0 && (
                      <div className="dynamic-focus-list">
                        <h3>Helpful practices</h3>
                        <ul>
                          {selected.practices.map((item, index) => (
                            <li key={index.toString()}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {selected.indicators.length > 0 && (
                      <div className="dynamic-focus-list">
                        <h3>Signs of progress</h3>
                        <ul>
                          {selected.indicators.map((item, index) => (
                            <li key={index.toString()}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="dynamic-note-author">
                      Saved by {selected.authoredBy === "owner" ? "you" : "Valerie"} ·{" "}
                      {formattedTime(selected.updatedAt)}
                    </p>
                    {selected.sources.length > 0 && (
                      <FocusSources api={api} sources={selected.sources} />
                    )}
                    {selected.stateSources.length > 0 && (
                      <FocusSources
                        api={api}
                        sources={selected.stateSources}
                        label="Status context"
                      />
                    )}
                    {selected.state !== "archived" && (
                      <div className="dynamic-actions dynamic-save">
                        <button
                          type="button"
                          className="button button--secondary"
                          disabled={busy}
                          onClick={() => startEditor(selected)}
                        >
                          Edit focus
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void changeState(selected.state === "paused" ? "active" : "paused")
                          }
                        >
                          {selected.state === "paused" ? "Resume" : "Pause"}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => void changeState("archived")}
                        >
                          Archive
                        </button>
                      </div>
                    )}
                  </article>
                ) : (
                  <div className="panel dynamic-panel">
                    <EmptyState title="No focus chosen yet">
                      <p>
                        Choose one area to give a little extra care and attention. Valerie can help
                        you think it through.
                      </p>
                      <button
                        type="button"
                        className="button button--primary"
                        onClick={() => startEditor(null)}
                      >
                        Choose a focus
                      </button>
                    </EmptyState>
                  </div>
                )}
                {!state.current && selected?.state === "archived" && !editor && (
                  <button
                    type="button"
                    className="button button--primary dynamic-new-focus"
                    onClick={() => startEditor(null)}
                  >
                    Choose a new focus
                  </button>
                )}
              </div>
              <div className="dynamic-sidebar">
                <FocusPermissions
                  api={api}
                  settings={state.settings}
                  onSaved={(settings) =>
                    setState((previous) => (previous ? { ...previous, settings } : previous))
                  }
                  onDirtyChange={setPermissionsDirty}
                  onRefresh={requestRefresh}
                />
                {state.history.length > 0 && (
                  <article className="panel dynamic-panel">
                    <h2>Focus history</h2>
                    <ol className="dynamic-focus-history">
                      {state.history.map((focus) => (
                        <li key={focus.id}>
                          <button
                            type="button"
                            className={selected?.id === focus.id ? "is-selected" : ""}
                            aria-pressed={selected?.id === focus.id}
                            onClick={() => selectFocus(focus)}
                          >
                            <span>{focus.title}</span>
                            <small>
                              {focusStatus(focus).label} · {focusDate(focus.startDate)}
                            </small>
                          </button>
                        </li>
                      ))}
                    </ol>
                    <p className="dynamic-field-hint">
                      Most recent {state.history.length}{" "}
                      {state.history.length === 1 ? "focus" : "focuses"}.
                    </p>
                  </article>
                )}
              </div>
            </div>
            {selected && (
              <FocusNotes
                key={selected.id}
                api={api}
                focus={selected}
                visible={visible && tab === "focus"}
                onDirtyChange={setNoteDirty}
                onFocusRefresh={requestRefresh}
              />
            )}
          </>
        )}
        <ContextHealthPanel api={api} visible={visible && tab === "focus"} />
      </div>
      <div hidden={tab !== "daily"}>
        <DailyDetailsPage
          api={api}
          visible={visible && tab === "daily"}
          onDirtyChange={setDailyDirty}
          onOpenAgreements={() => setTab("agreements")}
          refreshKey={refresh}
        />
      </div>
      <div hidden={tab !== "agreements"}>
        <AgreementsPage
          api={api}
          visible={visible && tab === "agreements"}
          refreshKey={refresh}
          onDirtyChange={setAgreementsDirty}
          onOpenDaily={() => setTab("daily")}
          onOpenReminders={() => setTab("reminders")}
        />
      </div>
      <div hidden={tab !== "reminders"}>
        <RemindersPage
          api={api}
          visible={visible && tab === "reminders"}
          refreshKey={refresh}
          onDirtyChange={setRemindersDirty}
        />
      </div>
      <div hidden={tab !== "prompts"}>
        <FeaturePrompts
          api={api}
          visible={visible && tab === "prompts"}
          onDirtyChange={setPromptDirty}
        />
      </div>
    </section>
  );
}
