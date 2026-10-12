import type { DynamicSettings } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, ApiError, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { ToggleOption } from "./ToggleOption";

export function DailyPermissions({
  api,
  settings,
  onSaved,
  onRefresh,
  onDirtyChange,
}: {
  api: Api;
  settings: DynamicSettings;
  onSaved: (settings: DynamicSettings) => void;
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
    Boolean(draft.allowValerieManageWaking) !== Boolean(settings.allowValerieManageWaking) ||
    Boolean(draft.allowValerieManageProgress) !== Boolean(settings.allowValerieManageProgress);
  const conflict = edited.current && draft.version !== settings.version;
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);
  async function save() {
    if (writing.current || !dirty || conflict) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { settings: saved } = await api<{ settings: DynamicSettings }>(
        "/dynamic/daily/settings",
        {
          method: "PUT",
          body: JSON.stringify({
            expectedVersion: draft.version,
            allowValerieManageWaking: Boolean(draft.allowValerieManageWaking),
            allowValerieManageProgress: Boolean(draft.allowValerieManageProgress),
          }),
        },
      );
      edited.current = false;
      setDraft(saved);
      onSaved(saved);
      setNotice("Daily record permissions saved.");
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) onRefresh();
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="panel dynamic-panel" aria-labelledby="daily-permissions-title">
      <h2 id="daily-permissions-title">Conversation records</h2>
      <p className="dynamic-intro">Let Valerie keep continuity from what you actually tell her.</p>
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
          title="Let Valerie record your waking day"
          disabled={busy}
          checked={Boolean(draft.allowValerieManageWaking)}
          onChange={(checked) => {
            edited.current = true;
            setDraft((previous) => ({
              ...previous,
              allowValerieManageWaking: checked,
            }));
            setNotice("");
          }}
        >
          Save waking updates, naps and sleep intentions with their sources. A usual routine or
          silence is not proof you slept.
        </ToggleOption>
        <ToggleOption
          title="Let Valerie keep progress records"
          disabled={busy}
          checked={Boolean(draft.allowValerieManageProgress)}
          onChange={(checked) => {
            edited.current = true;
            setDraft((previous) => ({
              ...previous,
              allowValerieManageProgress: checked,
            }));
            setNotice("");
          }}
        >
          Record and correct things you report. Plans and interpretations remain separate from
          completed actions.
        </ToggleOption>
        <p className="dynamic-field-hint">
          Saved permissions: waking records {settings.allowValerieManageWaking ? "on" : "off"},
          progress records {settings.allowValerieManageProgress ? "on" : "off"}.
        </p>
        {conflict && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              Permissions changed elsewhere. Your choices are kept; load the saved permissions
              before changing them again.
            </p>
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--secondary"
            disabled={!dirty || busy || conflict}
          >
            {busy ? "Saving…" : "Save record permissions"}
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
                setNotice("Loaded the saved record permissions.");
              }}
            >
              Use saved record permissions
            </button>
          )}
        </div>
      </form>
    </article>
  );
}
