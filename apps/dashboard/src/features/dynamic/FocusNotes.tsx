import type { DynamicPage, DynamicProgressNote, DynamicSource, GrowthFocus } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, ApiError, errorMessage } from "../../app/api";
import { Badge, ErrorNotice, formattedTime } from "../../components/ui";
import { ConversationSource } from "../memory/ConversationSource";

export function FocusSources({
  api,
  sources,
  label = "Original context",
}: {
  api: Api;
  sources: DynamicSource[];
  label?: string;
}) {
  return (
    <details className="dynamic-sources">
      <summary>{label}</summary>
      {sources.map((source) => (
        <div key={`${source.type}:${source.id}`}>
          {source.type === "conversation" ? (
            <ConversationSource api={api} id={source.id} />
          ) : (
            <p className="muted">
              Entered by you in the dashboard · {formattedTime(source.observedAt)}
            </p>
          )}
        </div>
      ))}
    </details>
  );
}

export function FocusNotes({
  api,
  focus,
  visible,
  onDirtyChange,
  onFocusRefresh,
}: {
  api: Api;
  focus: GrowthFocus;
  visible: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onFocusRefresh: () => void;
}) {
  const [notes, setNotes] = useState<DynamicProgressNote[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [body, setBody] = useState("");
  const [baseVersion, setBaseVersion] = useState(focus.version);
  const [correction, setCorrection] = useState<DynamicProgressNote | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const writing = useRef(false);
  const reading = useRef(false);
  const pageRequest = useRef<AbortController | null>(null);
  const dirty = body.length > 0 || correction !== null;
  const conflict = dirty && focus.version !== baseVersion;
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A manual refresh reloads the first page and leaves the note draft intact.
  useEffect(() => {
    if (!visible || writing.current) return;
    const controller = new AbortController();
    reading.current = true;
    setLoading(true);
    setLoadError("");
    api<DynamicPage<DynamicProgressNote>>(
      `/dynamic/focus/${encodeURIComponent(focus.id)}/notes?limit=20`,
      {
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setNotes(result.items);
        setNextCursor(result.nextCursor);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          reading.current = false;
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      pageRequest.current?.abort();
      reading.current = false;
    };
  }, [api, focus.id, visible, refresh]);

  async function loadMore() {
    if (!nextCursor || reading.current || writing.current) return;
    const controller = new AbortController();
    pageRequest.current = controller;
    reading.current = true;
    setLoading(true);
    setLoadError("");
    try {
      const result = await api<DynamicPage<DynamicProgressNote>>(
        `/dynamic/focus/${encodeURIComponent(focus.id)}/notes?limit=20&cursor=${encodeURIComponent(nextCursor)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setNotes((previous) => [
        ...previous,
        ...result.items.filter((note) => !previous.some((item) => item.id === note.id)),
      ]);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (!controller.signal.aborted) setLoadError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) {
        reading.current = false;
        setLoading(false);
      }
    }
  }

  async function save() {
    if (writing.current || reading.current || !body.trim() || conflict || unconfirmed) return;
    if (new TextEncoder().encode(body.trim()).byteLength > 1200) {
      setError("Please shorten this note before saving.");
      return;
    }
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { note } = await api<{ note: DynamicProgressNote }>(
        `/dynamic/focus/${encodeURIComponent(focus.id)}/notes`,
        {
          method: "POST",
          body: JSON.stringify({
            body: body.trim(),
            kind: "owner_report",
            expectedFocusVersion: baseVersion,
            ...(correction ? { supersedesNoteId: correction.id } : {}),
          }),
        },
      );
      setNotes((previous) => [
        note,
        ...previous.map((item) =>
          item.id === note.supersedesNoteId ? { ...item, superseded: true } : item,
        ),
      ]);
      setBody("");
      setCorrection(null);
      setBaseVersion(focus.version);
      setNotice(
        note.supersedesNoteId
          ? "Correction saved. The original note remains in the history."
          : "Note saved.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) onFocusRefresh();
      else if (!(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500)
        setUnconfirmed(true);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  return (
    <article className="panel dynamic-panel dynamic-notes" aria-labelledby="focus-notes-title">
      <div className="dynamic-heading">
        <div>
          <h2 id="focus-notes-title">Progress notes</h2>
          <p className="dynamic-intro">
            What helped, what was difficult, and things worth remembering.
          </p>
        </div>
        <button
          type="button"
          className="text-button"
          disabled={busy || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh notes
        </button>
      </div>
      {(focus.state !== "archived" || dirty) && (
        <form
          className="dynamic-note-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {error && <ErrorNotice message={error} />}
          {notice && (
            <p className="dynamic-feedback" role="status">
              {notice}
            </p>
          )}
          {focus.state === "archived" && (
            <p className="dynamic-review-note" role="status">
              This focus was archived while your draft was open. Your text is kept here so you can
              copy it.
            </p>
          )}
          {correction && (
            <div className="dynamic-correction">
              <span className="eyebrow">Correcting a note</span>
              <blockquote>{correction.body}</blockquote>
              <p className="muted">
                The correction is a new report from you. The original stays in the history.
              </p>
            </div>
          )}
          <label className="dynamic-field">
            <span>{correction ? "Your correction" : "Add a note from you"}</span>
            <textarea
              aria-label={correction ? "Your correction" : "Add a note from you"}
              rows={3}
              maxLength={1200}
              disabled={busy}
              value={body}
              onChange={(event) => {
                if (!dirty) setBaseVersion(focus.version);
                setBody(event.target.value);
                setNotice("");
              }}
            />
          </label>
          {conflict && (
            <div className="notice dynamic-conflict" role="status">
              <p>
                Your focus changed while this note was open. Your text is kept; check the current
                focus above before adding it.
              </p>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setBaseVersion(focus.version);
                  setError("");
                }}
              >
                Keep this note for the current focus
              </button>
            </div>
          )}
          {unconfirmed && (
            <div className="notice dynamic-conflict" role="status">
              <p>
                The save could not be confirmed. Refresh the notes and check whether it was saved
                before trying again.
              </p>
              <button
                type="button"
                className="text-button"
                disabled={loading}
                onClick={() => {
                  setRefresh((value) => value + 1);
                }}
              >
                Refresh saved notes
              </button>
              <button
                type="button"
                className="text-button"
                disabled={loading}
                onClick={() => setUnconfirmed(false)}
              >
                I checked; allow another save
              </button>
            </div>
          )}
          <div className="dynamic-actions dynamic-save">
            <button
              type="submit"
              className="button button--secondary"
              disabled={
                busy ||
                loading ||
                !body.trim() ||
                conflict ||
                unconfirmed ||
                focus.state === "archived"
              }
            >
              {busy ? "Saving…" : correction ? "Save correction" : "Save note"}
            </button>
            {dirty && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  if (body && !window.confirm("Discard this unsaved note?")) return;
                  setBody("");
                  setCorrection(null);
                  setError("");
                  setUnconfirmed(false);
                  setBaseVersion(focus.version);
                }}
              >
                Discard note
              </button>
            )}
          </div>
        </form>
      )}
      {loadError && <ErrorNotice message={loadError} />}
      {!loaded && <p className="muted">{loading ? "Loading notes…" : "Notes are unavailable."}</p>}
      {loaded && notes.length === 0 && (
        <p className="dynamic-empty-notes">
          No notes yet. There is nothing to catch up on or score.
        </p>
      )}
      {notes.length > 0 && (
        <ol className="dynamic-note-list">
          {notes.map((note) => (
            <li key={note.id} className={note.superseded ? "is-superseded" : ""}>
              <div className="dynamic-note-heading">
                <Badge tone={note.kind === "valerie_interpretation" ? "accent" : "neutral"}>
                  {note.kind === "valerie_interpretation"
                    ? "Valerie’s interpretation"
                    : "Your report"}
                </Badge>
                <time dateTime={note.createdAt}>{formattedTime(note.createdAt)}</time>
                {note.superseded && <Badge>Corrected</Badge>}
                {note.supersedesNoteId && <Badge>Correction</Badge>}
              </div>
              <p className="dynamic-note-body">{note.body}</p>
              <p className="dynamic-note-author">
                Recorded by {note.authoredBy === "owner" ? "you" : "Valerie"}
              </p>
              {note.sources.length > 0 && <FocusSources api={api} sources={note.sources} />}
              {!note.superseded && focus.state !== "archived" && (
                <button
                  type="button"
                  className="text-button dynamic-correct-button"
                  disabled={busy || unconfirmed}
                  onClick={() => {
                    if (
                      dirty &&
                      !window.confirm("Replace your unsaved note with a new correction?")
                    )
                      return;
                    setCorrection(note);
                    setBody("");
                    setBaseVersion(focus.version);
                    setError("");
                    setNotice("");
                    document
                      .getElementById("focus-notes-title")
                      ?.scrollIntoView({ block: "start", behavior: "smooth" });
                  }}
                >
                  Add a correction
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {nextCursor && (
        <button
          type="button"
          className="button button--secondary"
          disabled={loading || busy}
          onClick={() => void loadMore()}
        >
          {loading ? "Loading…" : "Load earlier notes"}
        </button>
      )}
    </article>
  );
}
