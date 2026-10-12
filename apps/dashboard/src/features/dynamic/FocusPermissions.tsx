import type { DynamicSettings } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, ApiError, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import { ToggleOption } from "./ToggleOption";

export function FocusPermissions({
  api,
  settings,
  onSaved,
  onDirtyChange,
  onRefresh,
}: {
  api: Api;
  settings: DynamicSettings;
  onSaved: (settings: DynamicSettings) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const writing = useRef(false);
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setDraft(settings);
  }, [settings]);
  const dirty =
    draft.allowValerieManageFocus !== settings.allowValerieManageFocus ||
    draft.allowValerieLogNotes !== settings.allowValerieLogNotes;
  const conflict = edited.current && draft.version !== settings.version;
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);

  async function save() {
    if (writing.current || !dirty || conflict) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ settings: DynamicSettings }>("/dynamic/settings", {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: draft.version,
          allowValerieManageFocus: draft.allowValerieManageFocus,
          allowValerieLogNotes: draft.allowValerieLogNotes,
        }),
      });
      edited.current = false;
      setDraft(result.settings);
      onSaved(result.settings);
      setNotice("Valerie’s permissions are saved.");
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 409) onRefresh();
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  return (
    <article className="panel dynamic-panel" aria-labelledby="focus-permissions-title">
      <div className="dynamic-heading">
        <h2 id="focus-permissions-title">Valerie’s role</h2>
        {dirty && <Badge tone="warning">Unsaved</Badge>}
      </div>
      <p className="dynamic-intro">
        {settings.allowValerieManageFocus
          ? "Valerie can choose and revise your focus using what you’ve discussed. You can redirect or pause it."
          : "You choose and revise the saved focus. Valerie can talk it through with you."}
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
        <ToggleOption
          title="Let Valerie manage the focus"
          disabled={busy}
          checked={draft.allowValerieManageFocus}
          onChange={(checked) => {
            edited.current = true;
            setDraft((previous) => ({
              ...previous,
              allowValerieManageFocus: checked,
            }));
            setNotice("");
          }}
        >
          Choose, revise, pause, resume or archive it, grounded in your conversations.
        </ToggleOption>
        <ToggleOption
          title="Let Valerie keep progress notes"
          disabled={busy}
          checked={draft.allowValerieLogNotes}
          onChange={(checked) => {
            edited.current = true;
            setDraft((previous) => ({ ...previous, allowValerieLogNotes: checked }));
            setNotice("");
          }}
        >
          Save things you report and her own interpretations separately, with links to the original
          messages.
        </ToggleOption>
        <p className="dynamic-field-hint">
          {settings.allowValerieLogNotes
            ? "Conversation notes are currently allowed."
            : "Conversation notes are currently off."}
        </p>
        {conflict && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              Permissions changed elsewhere. Your choices are still here. Reload the saved
              permissions before changing them again.
            </p>
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            className="button button--secondary"
            type="submit"
            disabled={busy || !dirty || conflict}
          >
            {busy ? "Saving…" : "Save permissions"}
          </button>
          {(dirty || conflict) && (
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                edited.current = false;
                setDraft(settings);
                setError("");
                setNotice("Loaded the saved permissions.");
              }}
            >
              Use saved permissions
            </button>
          )}
        </div>
      </form>
    </article>
  );
}
