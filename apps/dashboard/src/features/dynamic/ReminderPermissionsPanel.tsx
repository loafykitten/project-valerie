import type { DynamicSettings, ReminderOverview } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { ToggleOption } from "./ToggleOption";

export function ReminderPermissionsPanel({
  api,
  overview,
  onRefresh,
  onDirtyChange,
}: {
  api: Api;
  overview: ReminderOverview;
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [value, setValue] = useState(overview.permissions.manageReminders);
  const [version, setVersion] = useState(overview.permissionsVersion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const edited = useRef(false);
  const writing = useRef(false);
  useEffect(() => {
    if (!edited.current) {
      setValue(overview.permissions.manageReminders);
      setVersion(overview.permissionsVersion);
    }
  }, [overview]);
  const dirty = value !== overview.permissions.manageReminders;
  const conflict = edited.current && version !== overview.permissionsVersion;
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);
  async function save() {
    if (writing.current || !dirty || conflict) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ settings: DynamicSettings }>("/reminders/permissions", {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: version, allowValerieManageReminders: value }),
      });
      edited.current = false;
      setVersion(result.settings.version);
      setNotice("Reminder permission saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      onRefresh();
    }
  }
  return (
    <article className="panel dynamic-panel" aria-labelledby="reminder-permission-title">
      <h2 id="reminder-permission-title">Valerie’s role</h2>
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
        <ToggleOption
          title="Let Valerie manage reminders"
          disabled={busy}
          checked={value}
          onChange={(checked) => {
            edited.current = true;
            setValue(checked);
            setNotice("");
          }}
        >
          Create and update reminders from your requests, including snoozing, completion and
          cancellation.
        </ToggleOption>
        <p className="dynamic-field-hint">
          Conversation reminder changes are currently{" "}
          {overview.permissions.manageReminders ? "allowed" : "off"}. Existing saved reminders keep
          their schedules.
        </p>
        {conflict && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              Permissions changed elsewhere. Your choice is kept; load the saved permission before
              changing it again.
            </p>
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--secondary"
            disabled={busy || !dirty || conflict}
          >
            {busy ? "Saving…" : "Save reminder permission"}
          </button>
          {(dirty || conflict) && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                edited.current = false;
                setValue(overview.permissions.manageReminders);
                setVersion(overview.permissionsVersion);
                setError("");
              }}
            >
              Use saved reminder permission
            </button>
          )}
        </div>
      </form>
    </article>
  );
}
