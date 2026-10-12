import type { CheckinSettings } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { ToggleOption } from "./ToggleOption";

export function CheckinSettingsPanel({
  api,
  settings,
  onSaved,
  onRefresh,
  onDirtyChange,
}: {
  api: Api;
  settings: CheckinSettings;
  onSaved: (settings: CheckinSettings) => void;
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const edited = useRef(false);
  const writing = useRef(false);
  useEffect(() => {
    if (!edited.current) setDraft(settings);
  }, [settings]);
  const dirty =
    draft.enabled !== settings.enabled ||
    draft.morningDelayMinutes !== settings.morningDelayMinutes ||
    draft.eveningLeadMinutes !== settings.eveningLeadMinutes ||
    draft.minIdleMinutes !== settings.minIdleMinutes ||
    draft.maxMessageChars !== settings.maxMessageChars;
  const conflict = edited.current && draft.version !== settings.version;
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);
  function change(patch: Partial<CheckinSettings>) {
    edited.current = true;
    setDraft((previous) => ({ ...previous, ...patch }));
    setNotice("");
  }
  async function save() {
    if (writing.current || !dirty || conflict) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { version, updatedAt: _updatedAt, ...fields } = draft;
      const result = await api<{ settings: CheckinSettings }>("/reminders/checkin-settings", {
        method: "PUT",
        body: JSON.stringify({ ...fields, expectedVersion: version }),
      });
      edited.current = false;
      setDraft(result.settings);
      onSaved(result.settings);
      setNotice("Check-in settings saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      onRefresh();
    }
  }
  function numberField(
    key: "morningDelayMinutes" | "eveningLeadMinutes" | "minIdleMinutes" | "maxMessageChars",
    label: string,
    hint: string,
    min: number,
    max: number,
  ) {
    return (
      <label className="dynamic-field">
        <span>{label}</span>
        <input
          type="number"
          required
          step={1}
          min={min}
          max={max}
          value={draft[key]}
          onChange={(event) => change({ [key]: Number(event.target.value) })}
        />
        <small>{hint}</small>
      </label>
    );
  }
  return (
    <article className="panel dynamic-panel" aria-labelledby="checkin-settings-title">
      <h2 id="checkin-settings-title">Coordinated check-ins</h2>
      <p className="dynamic-intro">
        Group useful questions into one brief morning or evening conversation.
      </p>
      {error && <ErrorNotice message={error} />}
      {notice && (
        <p className="dynamic-feedback" role="status">
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
          <legend className="sr-only">Check-in timing</legend>
          <ToggleOption
            title="Enable coordinated check-ins"
            checked={draft.enabled}
            onChange={(checked) => change({ enabled: checked })}
          >
            Only consider a message when relevant questions remain. Already reported progress helps
            avoid repeated questions.
          </ToggleOption>
          {numberField(
            "morningDelayMinutes",
            "After a day-start report (minutes)",
            "Wait this long after a genuine new-day update.",
            5,
            180,
          )}
          {numberField(
            "eveningLeadMinutes",
            "Before expected sleep (minutes)",
            "Stay within the four-hour evening window.",
            1,
            240,
          )}
          <details className="reminder-advanced">
            <summary>Conversation space and length</summary>
            <div className="dynamic-fields">
              {numberField(
                "minIdleMinutes",
                "Conversation space (minutes)",
                "Wait this long after recent conversation before an optional check-in.",
                0,
                120,
              )}
              {numberField(
                "maxMessageChars",
                "Maximum message characters",
                "Keep coordinated messages brief.",
                100,
                1200,
              )}
            </div>
          </details>
        </fieldset>
        <p className="dynamic-field-hint">
          Saved check-ins are {settings.enabled ? "enabled" : "off"}. These timing choices do not
          change habit targets or explicit reminder due times.
        </p>
        {conflict && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              Check-in settings changed elsewhere. Your draft is kept; load the saved settings
              before changing them again.
            </p>
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--secondary"
            disabled={busy || !dirty || conflict}
          >
            {busy ? "Saving…" : "Save check-in settings"}
          </button>
          {(dirty || conflict) && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                edited.current = false;
                setDraft(settings);
                setError("");
                setNotice("Loaded the saved check-in settings.");
              }}
            >
              Use saved check-in settings
            </button>
          )}
        </div>
      </form>
    </article>
  );
}
