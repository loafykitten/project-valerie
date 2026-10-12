import type { DynamicSettings } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { ToggleOption } from "./ToggleOption";

export function AgreementPermissionsPanel({
  api,
  settings,
  onRefresh,
  onDirtyChange,
}: {
  api: Api;
  settings: DynamicSettings;
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
    Boolean(draft.allowValerieManageHabits) !== Boolean(settings.allowValerieManageHabits) ||
    Boolean(draft.allowValerieManageRules) !== Boolean(settings.allowValerieManageRules);
  const conflict = edited.current && draft.version !== settings.version;
  useEffect(() => onDirtyChange(dirty || busy), [dirty, busy, onDirtyChange]);
  async function save() {
    if (writing.current || !dirty || conflict) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ settings: DynamicSettings }>("/agreements/settings", {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: draft.version,
          allowValerieManageHabits: Boolean(draft.allowValerieManageHabits),
          allowValerieManageRules: Boolean(draft.allowValerieManageRules),
        }),
      });
      edited.current = false;
      setDraft(result.settings);
      setNotice("Agreement permissions saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      onRefresh();
    }
  }
  return (
    <article className="panel dynamic-panel" aria-labelledby="agreement-permissions-title">
      <h2 id="agreement-permissions-title">Valerie’s role</h2>
      <p className="dynamic-intro">
        Current agreements stay available in conversation. These controls govern changes to the
        saved agreements.
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
        <ToggleOption
          title="Let Valerie manage habits"
          disabled={busy}
          checked={Boolean(draft.allowValerieManageHabits)}
          onChange={(checked) => {
            edited.current = true;
            setDraft({ ...draft, allowValerieManageHabits: checked });
            setNotice("");
          }}
        >
          Save agreed practices, cadence and changes using your actual requests and delegated
          authority.
        </ToggleOption>
        <ToggleOption
          title="Let Valerie manage rules"
          disabled={busy}
          checked={Boolean(draft.allowValerieManageRules)}
          onChange={(checked) => {
            edited.current = true;
            setDraft({ ...draft, allowValerieManageRules: checked });
            setNotice("");
          }}
        >
          Save and revise actual agreements, including exceptions and their scope.
        </ToggleOption>
        <p className="dynamic-field-hint">
          Saved conversation edits: habits {settings.allowValerieManageHabits ? "on" : "off"}, rules{" "}
          {settings.allowValerieManageRules ? "on" : "off"}.
        </p>
        {conflict && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              Agreement permissions changed elsewhere. Your choices are kept; load the saved
              permissions before changing them again.
            </p>
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--secondary"
            disabled={busy || !dirty || conflict}
          >
            {busy ? "Saving…" : "Save agreement permissions"}
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
              }}
            >
              Use saved agreement permissions
            </button>
          )}
        </div>
      </form>
    </article>
  );
}
