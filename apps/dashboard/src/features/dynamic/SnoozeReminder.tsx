import type { Reminder } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { DailyTimeField, newTimeDraft, resolveTimeDraft } from "./DailyTimeField";
import { dailyTime } from "./daily-presentation";

export function SnoozeReminder({
  api,
  reminder,
  latest,
  onClose,
  onSaved,
  onRefresh,
  onDirtyChange,
  onBusyChange,
}: {
  api: Api;
  reminder: Reminder;
  latest: Reminder | null;
  onClose: () => void;
  onSaved: (reminder: Reminder) => void;
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [base, setBase] = useState(reminder);
  const [time, setTime] = useState(() => newTimeDraft(reminder.timezone, "local"));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writing = useRef(false);
  const conflict = Boolean(latest && latest.version !== base.version);
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  async function save(minutes?: number) {
    if (writing.current || conflict) return;
    writing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const resolved = await resolveTimeDraft(
        api,
        minutes === undefined ? time : newTimeDraft(base.timezone),
      );
      if (!resolved.time.at) throw new Error("Choose a future time for the snooze.");
      const dueAt =
        minutes === undefined
          ? resolved.time.at
          : new Date(Date.parse(resolved.time.at) + minutes * 60000).toISOString();
      const result = await api<{ reminder: Reminder }>(
        `/reminders/${encodeURIComponent(base.id)}/snooze`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: base.version,
            occurrenceId: base.currentOccurrenceId,
            dueAt,
            originalTimeIntent:
              minutes === undefined
                ? `${time.localDateTime} ${time.timezone}`
                : `Snooze for ${minutes} minutes`,
          }),
        },
      );
      onSaved(result.reminder);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      onBusyChange(false);
      onRefresh();
    }
  }
  return (
    <article
      className="panel dynamic-panel reminder-editor"
      aria-labelledby="snooze-reminder-title"
    >
      <h2 id="snooze-reminder-title">Snooze: {base.title}</h2>
      <p className="dynamic-intro">
        Current due time: {dailyTime(base.dueAt, base.timezone)}. Earlier delivery records stay in
        the history.
      </p>
      {error && <ErrorNotice message={error} />}
      <div className="dynamic-actions">
        <button
          type="button"
          className="button button--secondary"
          disabled={busy || conflict}
          onClick={() => void save(15)}
        >
          In 15 minutes
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy || conflict}
          onClick={() => void save(60)}
        >
          In one hour
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="dynamic-save">
          <DailyTimeField
            label="Snooze until"
            draft={time}
            disabled={busy}
            allowNow={false}
            allowUnknown={false}
            onChange={(value) => {
              setTime(value);
              setDirty(true);
            }}
          />
        </div>
        {conflict && (
          <div className="notice dynamic-conflict" role="status">
            <p>This reminder changed while the snooze was open. Your chosen time is kept.</p>
            {latest && (
              <>
                <p>
                  Saved reminder: {latest.title} · {dailyTime(latest.dueAt, latest.timezone)}
                </p>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setBase(latest);
                    setError("");
                  }}
                >
                  Use the latest reminder for this snooze
                </button>
              </>
            )}
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || !dirty || conflict}
          >
            {busy ? "Saving…" : "Save snooze"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              if (!dirty || window.confirm("Discard the unsaved snooze time?")) onClose();
            }}
          >
            Cancel snooze
          </button>
        </div>
      </form>
    </article>
  );
}
