import type { Reminder, ReminderSaveInput } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import {
  DailyTimeField,
  newTimeDraft,
  resolveTimeDraft,
  timeDraftFromReported,
} from "./DailyTimeField";
import { dailyTime } from "./daily-presentation";
import { ToggleOption } from "./ToggleOption";

export function ReminderEditor({
  api,
  reminder,
  latest,
  copy,
  onClose,
  onSaved,
  onRefresh,
  onDirtyChange,
  onBusyChange,
}: {
  api: Api;
  reminder: Reminder | null;
  latest: Reminder | null;
  copy: boolean;
  onClose: () => void;
  onSaved: (reminder: Reminder) => void;
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const editing = Boolean(reminder && !copy);
  const initialDue =
    editing && reminder
      ? timeDraftFromReported({ at: reminder.dueAt, timezone: reminder.timezone, basis: "exact" })
      : newTimeDraft(reminder?.timezone ?? "America/Chicago", "local");
  const initialExpiry =
    editing && reminder?.expiresAt
      ? timeDraftFromReported({
          at: reminder.expiresAt,
          timezone: reminder.timezone,
          basis: "exact",
        })
      : newTimeDraft(reminder?.timezone ?? "America/Chicago", "unknown");
  const [title, setTitle] = useState(reminder?.title ?? "");
  const [purpose, setPurpose] = useState(reminder?.purpose ?? "");
  const [due, setDue] = useState(initialDue);
  const [expiry, setExpiry] = useState(initialExpiry);
  const [allowFallback, setAllowFallback] = useState(reminder?.allowFallback ?? true);
  const [baseVersion, setBaseVersion] = useState(editing ? (reminder?.version ?? null) : null);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const writing = useRef(false);
  const conflict = editing && latest?.version !== baseVersion;
  const terminal = editing && (latest?.state === "completed" || latest?.state === "cancelled");
  useEffect(() => onDirtyChange(edited || busy), [edited, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  async function save() {
    if (writing.current || conflict || terminal || unconfirmed) return;
    if (!title.trim() || due.mode === "unknown") {
      setError("Give the reminder a title and a time.");
      return;
    }
    writing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const changedDue = !editing || JSON.stringify(due) !== JSON.stringify(initialDue);
      const resolvedDue = changedDue
        ? await resolveTimeDraft(api, due)
        : {
            time: { at: reminder?.dueAt ?? null, timezone: reminder?.timezone ?? due.timezone },
            notice: "",
          };
      const changedExpiry = !editing || JSON.stringify(expiry) !== JSON.stringify(initialExpiry);
      const resolvedExpiry = changedExpiry
        ? await resolveTimeDraft(api, expiry)
        : { time: { at: reminder?.expiresAt ?? null }, notice: "" };
      if (!resolvedDue.time.at) throw new Error("Choose a due time for this reminder.");
      const fields: ReminderSaveInput = {
        title: title.trim(),
        purpose: purpose.trim(),
        dueAt: resolvedDue.time.at,
        timezone: due.timezone,
        originalTimeIntent: changedDue
          ? due.mode === "now"
            ? "Now"
            : `${due.localDateTime} ${due.timezone}`
          : (reminder?.originalTimeIntent ?? ""),
        expiresAt: resolvedExpiry.time.at,
        allowFallback,
        ...(editing ? { id: reminder?.id, expectedVersion: baseVersion as number } : {}),
      };
      const result = await api<{ reminder: Reminder }>(
        editing ? `/reminders/${encodeURIComponent(reminder?.id ?? "")}` : "/reminders",
        { method: editing ? "PUT" : "POST", body: JSON.stringify(fields) },
      );
      onSaved(result.reminder);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      if (
        cause instanceof Error &&
        "status" in cause &&
        (cause.status === 0 || (typeof cause.status === "number" && cause.status >= 500))
      )
        setUnconfirmed(true);
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
      aria-labelledby="reminder-editor-title"
    >
      <h2 id="reminder-editor-title">
        {editing ? "Edit reminder" : copy ? "Another reminder" : "New reminder"}
      </h2>
      <p className="dynamic-intro">
        Choose one time and what you want to remember. Completion remains separate from delivery.
      </p>
      {error && <ErrorNotice message={error} />}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="dynamic-fields" disabled={busy}>
          <legend className="sr-only">Reminder details</legend>
          <label className="dynamic-field">
            <span>Remind me to</span>
            <input
              required
              maxLength={120}
              aria-label="Reminder title"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          <label className="dynamic-field">
            <span>
              Purpose or details <small>Optional</small>
            </span>
            <textarea
              rows={3}
              maxLength={1200}
              aria-label="Reminder purpose"
              value={purpose}
              onChange={(event) => {
                setPurpose(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          <label className="dynamic-field">
            <span>Timezone for these times</span>
            <input
              required
              maxLength={100}
              aria-label="Reminder timezone"
              value={due.timezone}
              onChange={(event) => {
                setDue({ ...due, timezone: event.target.value });
                setExpiry({ ...expiry, timezone: event.target.value });
                setEdited(true);
              }}
            />
          </label>
          <DailyTimeField
            label="Remind me at"
            draft={due}
            allowUnknown={false}
            disabled={busy}
            onChange={(value) => {
              setDue(value);
              setEdited(true);
            }}
          />
          <DailyTimeField
            label="Stop trying after"
            draft={expiry}
            unknownLabel="No expiry"
            allowNow={false}
            disabled={busy}
            onChange={(value) => {
              setExpiry(value);
              setEdited(true);
            }}
          />
          <p className="dynamic-field-hint">
            Without an expiry, a late reminder stays due until it is delivered, completed or
            cancelled.
          </p>
          <ToggleOption
            title="Allow a simple backup message"
            checked={allowFallback}
            onChange={(checked) => {
              setAllowFallback(checked);
              setEdited(true);
            }}
          >
            If Valerie cannot prepare her usual message, send a brief reminder using this title.
          </ToggleOption>
        </fieldset>
        {(conflict || terminal) && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              {terminal
                ? "This reminder is no longer active. Your draft is kept so you can copy it into another reminder."
                : "The reminder changed elsewhere. Your draft is kept; compare the latest saved time and details before saving."}
            </p>
            {latest && (
              <div className="dynamic-saved-version">
                <strong>{latest.title}</strong>
                <p>{latest.purpose}</p>
                <p>
                  {dailyTime(latest.dueAt, latest.timezone)} · {latest.state}
                </p>
              </div>
            )}
            {!terminal && latest && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setBaseVersion(latest.version);
                  setError("");
                }}
              >
                Keep my reminder draft over the latest version
              </button>
            )}
          </div>
        )}
        {unconfirmed && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              The save could not be confirmed. Refresh the reminders and check for the saved result
              before trying again.
            </p>
            <button type="button" className="text-button" onClick={() => setUnconfirmed(false)}>
              I checked; allow another save
            </button>
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || !edited || Boolean(conflict) || Boolean(terminal) || unconfirmed}
          >
            {busy ? "Saving…" : "Save reminder"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              if (!edited || window.confirm("Discard the unsaved reminder changes?")) onClose();
            }}
          >
            Cancel reminder edit
          </button>
        </div>
      </form>
    </article>
  );
}
