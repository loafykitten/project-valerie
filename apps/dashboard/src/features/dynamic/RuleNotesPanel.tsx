import type { RuleDefinition, RuleReviewNote, WakingDay } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import { DailyTimeField, newTimeDraft, resolveTimeDraft } from "./DailyTimeField";
import { dailyTime, wakingDayLabel } from "./daily-presentation";
import { FocusSources } from "./FocusNotes";

const dispositions = {
  understood: "Understood or discussed",
  excepted: "Agreed exception",
  uncertain: "Uncertain; needs context",
} as const;
export function RuleNotesPanel({
  api,
  rule,
  days,
  currentDayId,
  onClose,
  onDirtyChange,
  onBusyChange,
}: {
  api: Api;
  rule: RuleDefinition;
  days: WakingDay[];
  currentDayId: string | null;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [notes, setNotes] = useState<RuleReviewNote[]>([]);
  const [summary, setSummary] = useState("");
  const [disposition, setDisposition] = useState<RuleReviewNote["disposition"] | "">("");
  const [dayId, setDayId] = useState(currentDayId ?? "");
  const [time, setTime] = useState(() => newTimeDraft(rule.timezone));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const writing = useRef(false);
  useEffect(() => onDirtyChange(edited || busy), [edited, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A successful note save refreshes the bounded history.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api<{ notes: RuleReviewNote[] }>(`/agreements/rules/${encodeURIComponent(rule.id)}/notes`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setNotes(result.notes);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, rule.id, refresh]);
  async function save() {
    if (writing.current || !summary.trim() || !disposition) return;
    writing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      const resolved = await resolveTimeDraft(api, time);
      await api(`/agreements/rules/${encodeURIComponent(rule.id)}/notes`, {
        method: "POST",
        body: JSON.stringify({
          ruleVersion: rule.version,
          wakingDayId: dayId || null,
          summary: summary.trim(),
          kind: "owner_report",
          disposition,
          occurred: resolved.time,
        }),
      });
      setSummary("");
      setDisposition("");
      setTime(newTimeDraft(rule.timezone));
      setEdited(false);
      setRefresh((value) => value + 1);
      setNotice("Rule discussion note saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <article className="panel dynamic-panel agreement-editor" aria-labelledby="rule-notes-title">
      <div className="dynamic-heading">
        <h2 id="rule-notes-title">Discussion: {rule.name}</h2>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            if (!edited || window.confirm("Discard the unsaved discussion note?")) onClose();
          }}
        >
          Close discussion
        </button>
      </div>
      <p className="dynamic-intro">
        Notes preserve context and exceptions. They do not create an automatic violation score. This
        draft refers to saved agreement version {rule.version}.
      </p>
      {error && <ErrorNotice message={error} />}
      {notice && (
        <p role="status" className="dynamic-feedback">
          {notice}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="dynamic-fields" disabled={busy}>
          <legend className="sr-only">Rule discussion note</legend>
          <label className="dynamic-field">
            <span>What you want to record</span>
            <textarea
              required
              rows={3}
              maxLength={1200}
              aria-label="Rule discussion note"
              value={summary}
              onChange={(event) => {
                setSummary(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          <label className="dynamic-field">
            <span>Context</span>
            <select
              required
              aria-label="Rule note context"
              value={disposition}
              onChange={(event) => {
                setDisposition(event.target.value as typeof disposition);
                setEdited(true);
              }}
            >
              <option value="">Choose the context</option>
              {Object.entries(dispositions).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <DailyTimeField
            label="When the discussion applies"
            draft={time}
            disabled={busy}
            onChange={(value) => {
              setTime(value);
              setEdited(true);
            }}
          />
          <label className="dynamic-field">
            <span>Waking day</span>
            <select
              aria-label="Rule discussion waking day"
              value={dayId}
              onChange={(event) => {
                setDayId(event.target.value);
                setEdited(true);
              }}
            >
              <option value="">Unassigned</option>
              {days
                .filter((day) => !day.mergedIntoDayId)
                .map((day) => (
                  <option key={day.id} value={day.id}>
                    {wakingDayLabel(day)}
                  </option>
                ))}
            </select>
          </label>
        </fieldset>
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--secondary"
            disabled={busy || !summary.trim() || !disposition}
          >
            {busy ? "Saving…" : "Save rule discussion"}
          </button>
        </div>
      </form>
      {loading && <p className="dynamic-field-hint">Loading discussion notes…</p>}
      <ol className="dynamic-note-list">
        {notes.map((note) => (
          <li key={note.id}>
            <div className="dynamic-note-heading">
              <Badge>{dispositions[note.disposition]}</Badge>
              <span className="muted">Agreement version {note.ruleVersion}</span>
            </div>
            <p className="dynamic-note-body">{note.summary}</p>
            <p className="dynamic-field-hint">
              {note.kind === "valerie_interpretation" ? "Valerie’s interpretation" : "Owner report"}{" "}
              · {dailyTime(note.occurred.at, note.occurred.timezone)}
            </p>
            <FocusSources api={api} sources={note.sources} />
          </li>
        ))}
      </ol>
    </article>
  );
}
