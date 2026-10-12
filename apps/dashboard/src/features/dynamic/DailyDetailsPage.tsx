import type { DailyEvent, DailyOverview, DailyWriteResult } from "@valerie/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import { DailyAgreementSummary } from "./DailyAgreementSummary";
import { DailyEventForm } from "./DailyEventForm";
import { DailyPermissions } from "./DailyPermissions";
import { DailyRecordsList } from "./DailyRecordsList";
import {
  dailyTime,
  dailyWriteMessage,
  progressPresentation,
  wakingDayLabel,
  wakingLabels,
} from "./daily-presentation";
import { MergeDays } from "./MergeDays";
import { TrackingSubjects } from "./TrackingSubjects";
import { WakingReportForm } from "./WakingReportForm";
import "./daily.css";

export function DailyDetailsPage({
  api,
  visible,
  onDirtyChange,
  refreshKey,
  onOpenAgreements,
}: {
  api: Api;
  visible: boolean;
  onDirtyChange: (dirty: boolean) => void;
  refreshKey: number;
  onOpenAgreements: () => void;
}) {
  const [overview, setOverview] = useState<DailyOverview | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [eventRefresh, setEventRefresh] = useState(0);
  const [editing, setEditing] = useState<DailyEvent | null | undefined>(undefined);
  const [latestEdit, setLatestEdit] = useState<DailyEvent | null>(null);
  const [behaviorFilter, setBehaviorFilter] = useState("");
  const [wakingDirty, setWakingDirty] = useState(false);
  const [subjectDirty, setSubjectDirty] = useState(false);
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [eventDirty, setEventDirty] = useState(false);
  const [eventBusy, setEventBusy] = useState(false);
  const [mergeDirty, setMergeDirty] = useState(false);
  const writing = useRef(false);
  const requestRefresh = useCallback(() => {
    setRefresh((value) => value + 1);
    setEventRefresh((value) => value + 1);
  }, []);
  useEffect(
    () =>
      onDirtyChange(
        wakingDirty || subjectDirty || permissionsDirty || eventDirty || mergeDirty || busy,
      ),
    [wakingDirty, subjectDirty, permissionsDirty, eventDirty, mergeDirty, busy, onDirtyChange],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refreshes update saved records without replacing any open draft.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending || writing.current) return;
      pending = true;
      setLoading(true);
      try {
        const result = await api<DailyOverview>("/dynamic/daily", { signal: controller.signal });
        if (!controller.signal.aborted) {
          setOverview((previous) =>
            previous && previous.settings.version > result.settings.version
              ? { ...result, settings: previous.settings }
              : result,
          );
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
    const timer = window.setInterval(() => void load(), 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [api, visible, refresh, refreshKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Read the selected report even if it has moved off the recent page.
  useEffect(() => {
    if (!editing) {
      setLatestEdit(null);
      return;
    }
    const controller = new AbortController();
    api<{ event: DailyEvent }>(`/dynamic/daily/events/${encodeURIComponent(editing.id)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setLatestEdit(result.event);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setActionError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [api, editing?.id, refresh, refreshKey]);
  function edit(event: DailyEvent | null) {
    if (eventBusy) return;
    if (eventDirty && !window.confirm("Discard the unsaved daily report before opening another?"))
      return;
    setEditing(event);
    setLatestEdit(event);
    setActionError("");
    setNotice("");
  }
  async function withdraw(event: DailyEvent) {
    if (
      writing.current ||
      !window.confirm(
        "Withdraw this report? It will stop contributing to progress; the original and its sources remain in history.",
      )
    )
      return;
    writing.current = true;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const result = await api<DailyWriteResult>(
        `/dynamic/daily/events/${encodeURIComponent(event.id)}/void`,
        { method: "POST", body: JSON.stringify({ expectedVersion: event.version }) },
      );
      if (result.effect === "needs_clarification") setActionError(dailyWriteMessage(result.reason));
      else
        setNotice(
          "Report withdrawn. The shared result has been recalculated from the remaining evidence.",
        );
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      requestRefresh();
    }
  }
  const day = overview?.currentDay;
  const timezone = day?.wakeTime.timezone ?? "America/Chicago";
  return (
    <section className="daily-details" aria-labelledby="daily-details-title">
      <div className="dynamic-heading daily-page-heading">
        <div>
          <h2 id="daily-details-title">Daily Details</h2>
          <p className="dynamic-intro">
            Your waking day and shared progress records, with room for uncertainty.
          </p>
        </div>
        <button
          type="button"
          className="text-button"
          disabled={loading || busy}
          onClick={requestRefresh}
        >
          {loading ? "Refreshing…" : "Refresh daily details"}
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {actionError && <ErrorNotice message={actionError} />}
      {notice && (
        <p className="notice dynamic-feedback" role="status">
          {notice}
        </p>
      )}
      {!overview ? (
        <div className="panel dynamic-panel">
          <p className="muted">
            {loading ? "Loading daily records…" : "Daily records are unavailable."}
          </p>
        </div>
      ) : (
        <>
          <div className="dynamic-columns">
            <div className="daily-main-column">
              <article className="panel dynamic-panel" aria-labelledby="current-waking-day-title">
                <div className="dynamic-heading">
                  <div>
                    <p className="eyebrow">Current waking day</p>
                    <h2 id="current-waking-day-title">
                      {day ? wakingLabels[day.state] : "No waking day established"}
                    </h2>
                  </div>
                  {day && <Badge>{day.current ? "Current" : "Historical"}</Badge>}
                </div>
                <p className="dynamic-intro">
                  {day
                    ? wakingDayLabel(day)
                    : "A clear waking update can establish the day. Midnight and silence do not start one."}
                </p>
                {day && (
                  <dl className="dynamic-focus-dates">
                    <div>
                      <dt>Expected main sleep</dt>
                      <dd>{dailyTime(day.expectedSleepAt, timezone)}</dd>
                    </div>
                    <div>
                      <dt>Sleep estimate comes from</dt>
                      <dd>
                        {day.sleepEstimateBasis === "owner_plan"
                          ? "Your reported plan"
                          : day.sleepEstimateBasis === "usual_routine"
                            ? "Usual routine; an estimate"
                            : "No plan established"}
                      </dd>
                    </div>
                  </dl>
                )}
                {day && (
                  <p className="dynamic-field-hint">
                    Sleep intentions and estimates do not claim you were asleep.
                  </p>
                )}
                <WakingReportForm
                  api={api}
                  currentDay={day ?? null}
                  days={overview.days}
                  onRefresh={requestRefresh}
                  onDirtyChange={setWakingDirty}
                />
                {day && (
                  <details className="daily-windows">
                    <summary>Timing references</summary>
                    <p className="dynamic-field-hint">
                      These windows describe the day. No check-in is scheduled or sent by these
                      records.
                    </p>
                    {overview.windows.length === 0 ? (
                      <p className="muted">No current timing window established.</p>
                    ) : (
                      <dl>
                        {overview.windows.map((window) => (
                          <div key={window.slot}>
                            <dt>
                              {window.slot === "morning" ? "After waking" : "Before expected sleep"}
                            </dt>
                            <dd>
                              {dailyTime(window.earliestAt, timezone)} –{" "}
                              {dailyTime(window.expiresAt, timezone)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </details>
                )}
                <MergeDays
                  api={api}
                  days={overview.days}
                  onRefresh={requestRefresh}
                  onDirtyChange={setMergeDirty}
                />
              </article>
              <article className="panel dynamic-panel" aria-labelledby="daily-progress-title">
                <div className="dynamic-heading">
                  <h2 id="daily-progress-title">Current day’s progress</h2>
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      busy ||
                      eventBusy ||
                      overview.behaviors.every((behavior) => behavior.state !== "active")
                    }
                    onClick={() => edit(null)}
                  >
                    Add a progress report
                  </button>
                </div>
                <p className="dynamic-intro">
                  Each subject has one shared result. A plan or interpretation never completes it.
                </p>
                {!day ? (
                  <p className="daily-empty">
                    Progress reports can stay unassigned until their waking day is known.
                  </p>
                ) : overview.behaviors.filter((behavior) => behavior.state === "active").length ===
                  0 ? (
                  <p className="daily-empty">
                    Nothing is being tracked yet. Choose a subject when it would be useful.
                  </p>
                ) : (
                  <ul className="daily-progress-list">
                    {overview.behaviors
                      .filter((behavior) => behavior.state === "active")
                      .map((behavior) => {
                        const progress = overview.progress.find(
                          (item) => item.behaviorId === behavior.id,
                        );
                        const display = progressPresentation(progress, behavior);
                        return (
                          <li key={behavior.id}>
                            <div className="dynamic-heading">
                              <h3>{behavior.name}</h3>
                              <Badge tone={display.tone}>{display.value}</Badge>
                            </div>
                            <p>{display.detail}</p>
                            {progress?.asOf && (
                              <small>As of {dailyTime(progress.asOf, timezone)}</small>
                            )}
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => {
                                setBehaviorFilter(behavior.id);
                                document
                                  .getElementById("daily-records-title")
                                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
                              }}
                            >
                              Read supporting reports
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </article>
              <DailyAgreementSummary
                api={api}
                visible={visible}
                refreshKey={refresh + refreshKey}
                onOpen={onOpenAgreements}
              />
            </div>
            <div className="dynamic-sidebar">
              <DailyPermissions
                api={api}
                settings={overview.settings}
                onSaved={(settings) =>
                  setOverview((previous) => (previous ? { ...previous, settings } : previous))
                }
                onRefresh={requestRefresh}
                onDirtyChange={setPermissionsDirty}
              />
              <TrackingSubjects
                api={api}
                behaviors={overview.behaviors}
                onRefresh={requestRefresh}
                onDirtyChange={setSubjectDirty}
              />
            </div>
          </div>
          {editing !== undefined && (
            <DailyEventForm
              key={editing?.id ?? "new"}
              api={api}
              event={editing}
              latest={latestEdit}
              behaviors={overview.behaviors}
              days={overview.days}
              currentDayId={day?.id ?? null}
              onClose={() => setEditing(undefined)}
              onRefresh={requestRefresh}
              onDirtyChange={setEventDirty}
              onBusyChange={setEventBusy}
            />
          )}
          <DailyRecordsList
            api={api}
            visible={visible}
            refresh={eventRefresh + refreshKey}
            days={overview.days}
            behaviors={overview.behaviors}
            behaviorFilter={behaviorFilter}
            onBehaviorFilter={setBehaviorFilter}
            onEdit={edit}
            onWithdraw={(event) => void withdraw(event)}
            busy={busy || eventBusy}
          />
        </>
      )}
    </section>
  );
}
