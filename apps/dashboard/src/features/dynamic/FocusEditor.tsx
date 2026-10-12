import type { GrowthFocus } from "@valerie/core";
import { Badge, ErrorNotice } from "../../components/ui";
import type { FocusDraft } from "./presentation";

export function FocusEditor({
  draft,
  latest,
  dirty,
  busy,
  error,
  onChange,
  onSave,
  onClose,
  onUseSaved,
  onKeepDraft,
}: {
  draft: FocusDraft;
  latest: GrowthFocus | null;
  dirty: boolean;
  busy: boolean;
  error: string;
  onChange: (patch: Partial<FocusDraft>) => void;
  onSave: () => void;
  onClose: () => void;
  onUseSaved: () => void;
  onKeepDraft: () => void;
}) {
  const conflict = draft.id !== null && latest?.version !== draft.baseVersion;
  const unavailable = draft.id !== null && (!latest || latest.state === "archived");
  return (
    <article className="panel dynamic-panel" aria-labelledby="focus-editor-title">
      <div className="dynamic-heading">
        <div>
          <p className="eyebrow">Growth focus</p>
          <h2 id="focus-editor-title">{draft.id ? "Edit your focus" : "Choose a focus"}</h2>
        </div>
        {dirty && <Badge tone="warning">Unsaved draft</Badge>}
      </div>
      <p className="dynamic-intro">
        One area to give a little extra attention. Four to eight weeks is a useful starting point;
        the review date is a chance to reconsider it together.
      </p>
      {error && <ErrorNotice message={error} />}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <fieldset className="dynamic-fields" disabled={busy}>
          <legend className="sr-only">Focus details</legend>
          <label className="dynamic-field">
            <span>Focus</span>
            <input
              required
              maxLength={120}
              value={draft.title}
              onChange={(event) => onChange({ title: event.target.value })}
            />
          </label>
          <label className="dynamic-field">
            <span>Why this matters</span>
            <textarea
              required
              maxLength={800}
              rows={3}
              value={draft.reason}
              onChange={(event) => onChange({ reason: event.target.value })}
            />
          </label>
          <div className="dynamic-date-fields">
            <label className="dynamic-field">
              <span>Start date</span>
              <input
                required
                type="date"
                value={draft.startDate}
                onChange={(event) => onChange({ startDate: event.target.value })}
              />
            </label>
            <label className="dynamic-field">
              <span>Review date</span>
              <input
                required
                type="date"
                min={draft.startDate || undefined}
                value={draft.reviewDate}
                onChange={(event) => onChange({ reviewDate: event.target.value })}
              />
            </label>
          </div>
          <p className="dynamic-field-hint">
            Dates follow Central time. A review date does not end the focus.
          </p>
          <label className="dynamic-field">
            <span>
              Helpful practices <small>Optional</small>
            </span>
            <textarea
              rows={3}
              maxLength={804}
              value={draft.practices}
              onChange={(event) => onChange({ practices: event.target.value })}
            />
            <small>
              One short practice per line, up to five. These do not create reminders or habits.
            </small>
          </label>
          <label className="dynamic-field">
            <span>
              Signs of progress <small>Optional</small>
            </span>
            <textarea
              rows={3}
              maxLength={804}
              value={draft.indicators}
              onChange={(event) => onChange({ indicators: event.target.value })}
            />
            <small>
              What would feel different or helpful? One short item per line, up to five.
            </small>
          </label>
        </fieldset>
        {(conflict || unavailable) && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              {unavailable
                ? "This focus is no longer editable. Your draft is still here so you can keep any changes."
                : "This focus changed elsewhere. Your draft is still here; compare the saved version before continuing."}
            </p>
            {latest && (
              <details>
                <summary>View the latest saved version</summary>
                <div className="dynamic-saved-version">
                  <strong>{latest.title}</strong>
                  <p>{latest.reason}</p>
                  <p>
                    {latest.startDate} → {latest.reviewDate}
                  </p>
                  {latest.practices.map((item, index) => (
                    <p key={`practice-${index.toString()}`}>{item}</p>
                  ))}
                  {latest.indicators.map((item, index) => (
                    <p key={`indicator-${index.toString()}`}>{item}</p>
                  ))}
                </div>
              </details>
            )}
            {!unavailable && (
              <div className="dynamic-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={onKeepDraft}
                  disabled={busy}
                >
                  Keep my draft over the latest version
                </button>
                <button type="button" className="text-button" onClick={onUseSaved} disabled={busy}>
                  Use the saved version
                </button>
              </div>
            )}
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || !dirty || conflict || unavailable}
          >
            {busy ? "Saving…" : draft.id ? "Save focus" : "Set focus"}
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </article>
  );
}
