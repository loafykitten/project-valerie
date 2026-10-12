import type { ProgressBehavior } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";

type SubjectDraft = {
  id: string | null;
  version: number | null;
  name: string;
  unit: string;
  valueKind: "count" | "status";
  state: "active" | "archived";
};
const draftOf = (record: ProgressBehavior | null): SubjectDraft => ({
  id: record?.id ?? null,
  version: record?.version ?? null,
  name: record?.name ?? "",
  unit: record?.unit ?? "",
  valueKind: record?.valueKind ?? "count",
  state: record?.state ?? "active",
});

export function TrackingSubjects({
  api,
  behaviors,
  onRefresh,
  onDirtyChange,
}: {
  api: Api;
  behaviors: ProgressBehavior[];
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<SubjectDraft | null>(null);
  const [base, setBase] = useState<SubjectDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const writing = useRef(false);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(base);
  const latest = draft?.id ? behaviors.find((behavior) => behavior.id === draft.id) : undefined;
  const conflict = draft?.id !== null && draft !== null && latest?.version !== draft.version;
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);
  async function save() {
    if (!draft || writing.current || conflict) return;
    if (!draft.name.trim() || (draft.valueKind === "count" && !draft.unit.trim())) {
      setError("Give this subject a name and a unit for its count.");
      return;
    }
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const path = draft.id
        ? `/dynamic/daily/behaviors/${encodeURIComponent(draft.id)}`
        : "/dynamic/daily/behaviors";
      await api<{ behavior: ProgressBehavior }>(path, {
        method: draft.id ? "PUT" : "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          unit: draft.valueKind === "status" && !draft.id ? "status" : draft.unit.trim(),
          valueKind: draft.valueKind,
          aggregation: draft.valueKind === "count" ? "count" : "latest_status",
          state: draft.state,
          ...(draft.id ? { expectedVersion: draft.version } : {}),
        }),
      });
      setDraft(null);
      setBase(null);
      setNotice("Tracking subject saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      onRefresh();
    }
  }
  function edit(record: ProgressBehavior | null) {
    if (dirty && !window.confirm("Discard the unsaved tracking subject changes?")) return;
    const next = draftOf(record);
    setDraft(next);
    setBase(next);
    setError("");
    setNotice("");
  }
  return (
    <article className="panel dynamic-panel" aria-labelledby="tracking-subjects-title">
      <div className="dynamic-heading">
        <h2 id="tracking-subjects-title">What you track</h2>
        <button type="button" className="text-button" disabled={busy} onClick={() => edit(null)}>
          Add a subject
        </button>
      </div>
      <p className="dynamic-intro">
        Choose a count or status you want to record. This does not set a target or schedule a
        reminder.
      </p>
      {error && <ErrorNotice message={error} />}
      {notice && (
        <p className="dynamic-feedback" role="status">
          {notice}
        </p>
      )}
      {draft && (
        <form
          className="daily-subject-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="dynamic-fields" disabled={busy}>
            <legend className="sr-only">Tracking subject</legend>
            <label className="dynamic-field">
              <span>Name</span>
              <input
                required
                maxLength={120}
                aria-label="Tracking subject name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label className="dynamic-field">
              <span>Record as</span>
              <select
                aria-label="Tracking subject type"
                disabled={busy || Boolean(draft.id)}
                value={draft.valueKind}
                onChange={(event) =>
                  setDraft({ ...draft, valueKind: event.target.value as SubjectDraft["valueKind"] })
                }
              >
                <option value="count">A count or quantity</option>
                <option value="status">A reported status</option>
              </select>
            </label>
            {draft.valueKind === "count" && (
              <label className="dynamic-field">
                <span>Unit</span>
                <input
                  required
                  maxLength={40}
                  aria-label="Tracking subject unit"
                  disabled={busy || Boolean(draft.id)}
                  value={draft.unit}
                  onChange={(event) => setDraft({ ...draft, unit: event.target.value })}
                />
                <small>
                  For example, minutes or occurrences. Saved units keep their original meaning.
                </small>
              </label>
            )}
            {draft.id && (
              <label className="dynamic-field">
                <span>Availability</span>
                <select
                  aria-label="Tracking subject availability"
                  value={draft.state}
                  onChange={(event) =>
                    setDraft({ ...draft, state: event.target.value as SubjectDraft["state"] })
                  }
                >
                  <option value="active">Active</option>
                  <option value="archived">Archived; keep earlier reports</option>
                </select>
              </label>
            )}
          </fieldset>
          {conflict && (
            <div className="notice dynamic-conflict" role="status">
              <p>This subject changed elsewhere. Your draft is kept.</p>
              {latest && (
                <>
                  <p>
                    Saved: {latest.name} · {latest.unit} · {latest.state}
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setDraft({ ...draft, version: latest.version });
                      setBase(draftOf(latest));
                      setError("");
                    }}
                  >
                    Keep my subject draft over the latest version
                  </button>
                </>
              )}
            </div>
          )}
          <div className="dynamic-actions dynamic-save">
            <button
              type="submit"
              className="button button--secondary"
              disabled={busy || !dirty || conflict}
            >
              {busy ? "Saving…" : "Save tracking subject"}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                if (!dirty || window.confirm("Discard the unsaved tracking subject changes?")) {
                  setDraft(null);
                  setBase(null);
                  setError("");
                }
              }}
            >
              Cancel subject edit
            </button>
          </div>
        </form>
      )}
      {behaviors.length === 0 ? (
        <p className="daily-empty">
          No tracking subjects yet. Nothing is expected or marked missed.
        </p>
      ) : (
        <ul className="daily-subject-list">
          {behaviors.map((behavior) => (
            <li key={behavior.id}>
              <div>
                <strong>{behavior.name}</strong>
                <small>
                  {behavior.valueKind === "count"
                    ? behavior.unit
                    : "Done, partial, skipped or excused"}
                </small>
              </div>
              {behavior.state === "archived" && <Badge>Archived</Badge>}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => edit(behavior)}
              >
                Edit <span className="sr-only">{behavior.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
