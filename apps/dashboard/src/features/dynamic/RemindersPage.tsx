import type { Reminder, ReminderOverview } from "@valerie/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import { CheckinSettingsPanel } from "./CheckinSettingsPanel";
import { dailyTime } from "./daily-presentation";
import { FocusSources } from "./FocusNotes";
import { ReminderEditor } from "./ReminderEditor";
import { ReminderPermissionsPanel } from "./ReminderPermissionsPanel";
import {
  canRetryReminder,
  occurrencePresentation,
  reminderPresentation,
} from "./reminder-presentation";
import { SnoozeReminder } from "./SnoozeReminder";
import "./reminders.css";

type ReminderEditorState = { kind: "edit" | "copy" | "snooze"; reminder: Reminder | null };
type ReminderOverviewResponse = ReminderOverview & {
  worker?: { state: string; lastTickAt: string | null; lastError: string | null };
};
export function RemindersPage({
  api,
  visible,
  refreshKey,
  onDirtyChange,
}: {
  api: Api;
  visible: boolean;
  refreshKey: number;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [overview, setOverview] = useState<ReminderOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<ReminderEditorState | null>(null);
  const [latest, setLatest] = useState<Reminder | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [permissionDirty, setPermissionDirty] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<"all" | "explicit_reminder" | "checkin">(
    "all",
  );
  const writing = useRef(false);
  const requestRefresh = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(
    () => onDirtyChange(editorDirty || editorBusy || settingsDirty || permissionDirty || busy),
    [editorDirty, editorBusy, settingsDirty, permissionDirty, busy, onDirtyChange],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Poll saved delivery state while keeping all open drafts.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending || writing.current) return;
      pending = true;
      setLoading(true);
      try {
        const result = await api<ReminderOverviewResponse>("/reminders", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setOverview(result);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [api, visible, refresh, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A selected reminder may be older than the recent overview page.
  useEffect(() => {
    if (!editor?.reminder) {
      setLatest(null);
      return;
    }
    const controller = new AbortController();
    api<{ reminder: Reminder }>(`/reminders/${encodeURIComponent(editor.reminder.id)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setLatest(result.reminder);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setActionError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [api, editor?.reminder?.id, refresh, refreshKey]);
  function open(kind: ReminderEditorState["kind"], reminder: Reminder | null) {
    if (editorBusy || busy) return;
    if (
      editorDirty &&
      !window.confirm("Discard the unsaved reminder changes before opening another?")
    )
      return;
    setEditor({ kind, reminder });
    setLatest(reminder);
    setActionError("");
    setNotice("");
  }
  function accept(reminder: Reminder) {
    setOverview((previous) =>
      previous
        ? {
            ...previous,
            reminders: [reminder, ...previous.reminders.filter((item) => item.id !== reminder.id)],
          }
        : previous,
    );
    setNotice(
      `Saved: ${reminder.title}. ${reminder.state === "active" ? `Due ${dailyTime(reminder.dueAt, reminder.timezone)}.` : reminder.state === "completed" ? "Marked complete." : "Cancelled."}`,
    );
  }
  async function action(reminder: Reminder, name: "complete" | "cancel" | "retry") {
    if (writing.current || editorBusy) return;
    writing.current = true;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const result = await api<{ reminder: Reminder }>(
        `/reminders/${encodeURIComponent(reminder.id)}/${name === "retry" ? "retry-failed" : name}`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: reminder.version,
            ...(name === "cancel" ? {} : { occurrenceId: reminder.currentOccurrenceId }),
          }),
        },
      );
      accept(result.reminder);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      requestRefresh();
    }
  }
  const lock = busy || editorBusy;
  const active = overview?.reminders.filter((reminder) => reminder.state === "active") ?? [];
  const closed = overview?.reminders.filter((reminder) => reminder.state !== "active") ?? [];
  function card(reminder: Reminder) {
    const occurrence = overview?.occurrences.find(
      (item) => item.id === reminder.currentOccurrenceId,
    );
    const status = reminderPresentation(reminder, occurrence);
    return (
      <li key={reminder.id} className="reminder-card">
        <div className="dynamic-heading">
          <h3>{reminder.title}</h3>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        {reminder.purpose && <p className="dynamic-intro">{reminder.purpose}</p>}
        <dl className="reminder-times">
          <div>
            <dt>Due</dt>
            <dd>{dailyTime(reminder.dueAt, reminder.timezone)}</dd>
          </div>
          {occurrence?.deliveredAt && (
            <div>
              <dt>Delivered</dt>
              <dd>{dailyTime(occurrence.deliveredAt, reminder.timezone)}</dd>
            </div>
          )}
          {reminder.expiresAt && (
            <div>
              <dt>Expires</dt>
              <dd>{dailyTime(reminder.expiresAt, reminder.timezone)}</dd>
            </div>
          )}
        </dl>
        {occurrence?.status === "unknown" && (
          <p className="dynamic-field-hint">
            Delivery could not be confirmed. This occurrence is not retried automatically. Snoozing
            chooses a new occurrence deliberately.
          </p>
        )}
        {occurrence?.nextAttemptAt && occurrence.status === "retry" && (
          <p className="dynamic-field-hint">
            Next delivery attempt: {dailyTime(occurrence.nextAttemptAt, reminder.timezone)}.
          </p>
        )}
        <details className="reminder-advanced">
          <summary>Sources and saved choices</summary>
          <p className="dynamic-field-hint">
            {reminder.allowFallback
              ? "A simple backup message is allowed."
              : "A simple backup message is off."}
          </p>
          <FocusSources api={api} sources={reminder.sources} />
          {reminder.stateSources.length > 0 && (
            <FocusSources api={api} sources={reminder.stateSources} label="Latest change context" />
          )}
        </details>
        <div className="dynamic-actions dynamic-save">
          {(reminder.state === "active" || reminder.state === "expired") && (
            <button
              type="button"
              className="text-button"
              disabled={lock}
              onClick={() => open("edit", reminder)}
            >
              Edit reminder
            </button>
          )}
          {reminder.state === "active" && (
            <>
              <button
                type="button"
                className="button button--secondary"
                disabled={lock}
                onClick={() => void action(reminder, "complete")}
              >
                Mark complete
              </button>
              <button
                type="button"
                className="text-button"
                disabled={lock}
                onClick={() => open("snooze", reminder)}
              >
                Snooze
              </button>
              <button
                type="button"
                className="text-button"
                disabled={lock}
                onClick={() => void action(reminder, "cancel")}
              >
                Cancel reminder
              </button>
              {canRetryReminder(reminder, occurrence) && (
                <button
                  type="button"
                  className="text-button"
                  disabled={lock}
                  onClick={() => void action(reminder, "retry")}
                >
                  Retry failed delivery
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="text-button"
            disabled={lock}
            onClick={() => open("copy", reminder)}
          >
            Create another
          </button>
        </div>
      </li>
    );
  }
  const deliveryWorker = overview?.worker;
  const deliveryActive =
    deliveryWorker &&
    ["waiting", "preparing"].includes(deliveryWorker.state) &&
    deliveryWorker.lastTickAt &&
    Date.now() - Date.parse(deliveryWorker.lastTickAt) < 120000;
  return (
    <section className="reminders-page" aria-labelledby="reminders-title">
      <div className="dynamic-heading">
        <div>
          <h2 id="reminders-title">Reminders</h2>
          <p className="dynamic-intro">
            Saved times, useful check-ins, and what was actually delivered.
          </p>
        </div>
        <div className="dynamic-actions">
          <button
            type="button"
            className="text-button"
            disabled={loading || lock}
            onClick={requestRefresh}
          >
            {loading ? "Refreshing…" : "Refresh reminders"}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={lock}
            onClick={() => open("edit", null)}
          >
            New reminder
          </button>
        </div>
      </div>
      {error && <ErrorNotice message={error} />}
      {actionError && <ErrorNotice message={actionError} />}
      {notice && (
        <p className="notice dynamic-feedback" role="status">
          {notice}
        </p>
      )}
      {deliveryWorker && (
        <div className="panel dynamic-panel">
          <h3>
            {deliveryActive
              ? "Delivery active"
              : deliveryWorker.state === "starting"
                ? "Delivery starting"
                : deliveryWorker.state === "failed"
                  ? "Delivery needs attention"
                  : ["waiting", "preparing"].includes(deliveryWorker.state)
                    ? "Delivery has not checked recently"
                    : "Delivery stopped"}
          </h3>
          <p className="muted">
            {deliveryActive
              ? "Reminders can arrive while you chat. Casual heartbeat pacing does not postpone them."
              : "Saved schedules are retained. Delivery needs to resume before messages can arrive."}
          </p>
          {deliveryWorker.lastTickAt && (
            <p className="muted">Last checked {dailyTime(deliveryWorker.lastTickAt)}.</p>
          )}
        </div>
      )}
      {!overview ? (
        <div className="panel dynamic-panel">
          <p className="muted">{loading ? "Loading reminders…" : "Reminders are unavailable."}</p>
        </div>
      ) : (
        <>
          {editor &&
            (editor.kind === "snooze" && editor.reminder ? (
              <SnoozeReminder
                key={`snooze:${editor.reminder.id}`}
                api={api}
                reminder={editor.reminder}
                latest={latest}
                onClose={() => setEditor(null)}
                onSaved={accept}
                onRefresh={requestRefresh}
                onDirtyChange={setEditorDirty}
                onBusyChange={setEditorBusy}
              />
            ) : (
              <ReminderEditor
                key={`${editor.kind}:${editor.reminder?.id ?? "new"}`}
                api={api}
                reminder={editor.reminder}
                latest={latest}
                copy={editor.kind === "copy"}
                onClose={() => setEditor(null)}
                onSaved={accept}
                onRefresh={requestRefresh}
                onDirtyChange={setEditorDirty}
                onBusyChange={setEditorBusy}
              />
            ))}
          <div className="dynamic-columns">
            <div className="reminder-main">
              <article className="panel dynamic-panel">
                <h2>Active reminders</h2>
                {active.length === 0 ? (
                  <p className="daily-empty">
                    No active reminders. Add one when you want a specific follow-up.
                  </p>
                ) : (
                  <ul className="reminder-list">{active.map(card)}</ul>
                )}
              </article>
              {closed.length > 0 && (
                <article className="panel dynamic-panel">
                  <details>
                    <summary>Completed, cancelled and expired reminders</summary>
                    <ul className="reminder-list">{closed.map(card)}</ul>
                  </details>
                </article>
              )}
            </div>
            <div className="dynamic-sidebar">
              <ReminderPermissionsPanel
                api={api}
                overview={overview}
                onRefresh={requestRefresh}
                onDirtyChange={setPermissionDirty}
              />
              <CheckinSettingsPanel
                api={api}
                settings={overview.checkinSettings}
                onSaved={(settings) =>
                  setOverview((previous) =>
                    previous ? { ...previous, checkinSettings: settings } : previous,
                  )
                }
                onRefresh={requestRefresh}
                onDirtyChange={setSettingsDirty}
              />
            </div>
          </div>
          <article className="panel dynamic-panel reminder-deliveries">
            <div className="dynamic-heading">
              <h2>Recent delivery records</h2>
              <label className="dynamic-field">
                <span className="sr-only">Delivery record type</span>
                <select
                  aria-label="Delivery record type"
                  value={historyFilter}
                  onChange={(event) => setHistoryFilter(event.target.value as typeof historyFilter)}
                >
                  <option value="all">Reminders and check-ins</option>
                  <option value="explicit_reminder">Reminders</option>
                  <option value="checkin">Check-ins</option>
                </select>
              </label>
            </div>
            {overview.occurrences.filter(
              (item) => historyFilter === "all" || item.kind === historyFilter,
            ).length === 0 ? (
              <p className="daily-empty">No delivery records in this view.</p>
            ) : (
              <ol className="dynamic-note-list">
                {overview.occurrences
                  .filter((item) => historyFilter === "all" || item.kind === historyFilter)
                  .map((occurrence) => {
                    const status = occurrencePresentation(occurrence.status);
                    return (
                      <li key={occurrence.id}>
                        <div className="dynamic-note-heading">
                          <Badge tone={status.tone}>{status.label}</Badge>
                          <strong>
                            {occurrence.kind === "checkin"
                              ? "Coordinated check-in"
                              : occurrence.title}
                          </strong>
                        </div>
                        <p className="dynamic-field-hint">
                          Due {dailyTime(occurrence.dueAt, occurrence.timezone)}
                          {occurrence.deliveredAt
                            ? ` · Delivered ${dailyTime(occurrence.deliveredAt, occurrence.timezone)}`
                            : ""}
                        </p>
                        {occurrence.status === "unknown" && (
                          <p className="dynamic-field-hint">
                            Unconfirmed delivery; no automatic replay.
                          </p>
                        )}
                        {occurrence.usedFallback && (
                          <p className="dynamic-field-hint">
                            A saved simple backup message was used.
                          </p>
                        )}
                        {occurrence.text && (
                          <details className="reminder-advanced">
                            <summary>
                              {occurrence.status === "sent"
                                ? "Delivered message"
                                : occurrence.status === "unknown"
                                  ? "Message with unconfirmed delivery"
                                  : "Prepared message"}
                            </summary>
                            <p className="dynamic-note-body">{occurrence.text}</p>
                          </details>
                        )}
                      </li>
                    );
                  })}
              </ol>
            )}
          </article>
        </>
      )}
    </section>
  );
}
