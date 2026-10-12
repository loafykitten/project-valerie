import type { DailyEvent, DynamicPage, ProgressBehavior, WakingDay } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import { dailyTime, eventBasis, eventLabel, timeBasis, wakingDayLabel } from "./daily-presentation";
import { FocusSources } from "./FocusNotes";

function PreviousVersions({ api, event }: { api: Api; event: DailyEvent }) {
  const [version, setVersion] = useState(Math.max(1, event.version - 1));
  const [saved, setSaved] = useState<DailyEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <details className="daily-versions">
      <summary>Earlier versions</summary>
      <div className="dynamic-actions">
        <label className="dynamic-field">
          <span>Version to read</span>
          <input
            type="number"
            min={1}
            max={event.version}
            value={version}
            onChange={(change) => setVersion(Number(change.target.value))}
          />
        </label>
        <button
          type="button"
          className="text-button"
          disabled={busy || !Number.isInteger(version) || version < 1 || version > event.version}
          onClick={() => {
            setBusy(true);
            setError("");
            void api<{ event: DailyEvent }>(
              `/dynamic/daily/events/${encodeURIComponent(event.id)}?revision=${version}`,
            )
              .then((result) => setSaved(result.event))
              .catch((cause: unknown) => setError(errorMessage(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Reading…" : "Read saved version"}
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {saved && (
        <div className="dynamic-saved-version">
          <strong>
            Version {saved.version} · {saved.state === "voided" ? "Withdrawn" : eventLabel(saved)}
          </strong>
          <p>{saved.summary}</p>
          <p>
            {dailyTime(saved.occurred.at, saved.occurred.timezone)} · {eventBasis(saved)}
          </p>
          {saved.payload.kind === "progress" && saved.payload.value !== undefined && (
            <p>Reported value: {saved.payload.value}</p>
          )}
        </div>
      )}
    </details>
  );
}

export function DailyRecordsList({
  api,
  visible,
  refresh,
  days,
  behaviors,
  behaviorFilter,
  onBehaviorFilter,
  onEdit,
  onWithdraw,
  busy,
}: {
  api: Api;
  visible: boolean;
  refresh: number;
  days: WakingDay[];
  behaviors: ProgressBehavior[];
  behaviorFilter: string;
  onBehaviorFilter: (id: string) => void;
  onEdit: (event: DailyEvent) => void;
  onWithdraw: (event: DailyEvent) => void;
  busy: boolean;
}) {
  const [dayFilter, setDayFilter] = useState("all");
  const [events, setEvents] = useState<DailyEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const path = `/dynamic/daily/events?limit=20${dayFilter === "all" ? "" : `&dayId=${encodeURIComponent(dayFilter)}`}${behaviorFilter ? `&behaviorId=${encodeURIComponent(behaviorFilter)}` : ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A committed mutation or manual refresh reloads the current evidence view.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<DynamicPage<DailyEvent>>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setEvents(result.items);
          setNextCursor(result.nextCursor);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      pageRequest.current?.abort();
    };
  }, [api, visible, path, refresh, reload]);
  async function more() {
    if (!nextCursor || loading) return;
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await api<DynamicPage<DailyEvent>>(
        `${path}&cursor=${encodeURIComponent(nextCursor)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setEvents((previous) => [
        ...previous,
        ...result.items.filter((event) => !previous.some((item) => item.id === event.id)),
      ]);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <article className="panel dynamic-panel daily-records" aria-labelledby="daily-records-title">
      <div className="dynamic-heading">
        <h2 id="daily-records-title">Reports and their sources</h2>
        <button
          type="button"
          className="text-button"
          disabled={loading || busy}
          onClick={() => setReload((value) => value + 1)}
        >
          Refresh reports
        </button>
      </div>
      <p className="dynamic-intro">
        What was reported, when it applied, and any corrections. Unassigned reports keep their
        uncertainty.
      </p>
      <div className="daily-report-filters">
        <label className="dynamic-field">
          <span>Waking day</span>
          <select
            aria-label="Filter reports by waking day"
            value={dayFilter}
            onChange={(change) => setDayFilter(change.target.value)}
          >
            <option value="all">All waking days</option>
            <option value="unassigned">Unassigned reports</option>
            {days.map((day) => (
              <option key={day.id} value={day.id}>
                {day.current ? "Current · " : ""}
                {wakingDayLabel(day)}
                {day.mergedIntoDayId ? " · merged" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="dynamic-field">
          <span>Subject</span>
          <select
            aria-label="Filter reports by subject"
            value={behaviorFilter}
            onChange={(change) => onBehaviorFilter(change.target.value)}
          >
            <option value="">All subjects and waking updates</option>
            {behaviors.map((behavior) => (
              <option key={behavior.id} value={behavior.id}>
                {behavior.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <ErrorNotice message={error} />}
      {events.length === 0 && (
        <p className="daily-empty">
          {loading
            ? "Loading reports…"
            : "No reports in this view. Silence has not been recorded as a failure."}
        </p>
      )}
      <ol className="dynamic-note-list">
        {events.map((event) => {
          const progress = event.payload.kind === "progress" ? event.payload : null;
          const behavior = progress
            ? behaviors.find((item) => item.id === progress.behaviorId)
            : undefined;
          const day = days.find((item) => item.id === event.wakingDayId);
          return (
            <li key={event.id} className={event.state === "voided" ? "is-superseded" : ""}>
              <div className="dynamic-note-heading">
                <Badge
                  tone={
                    event.payload.kind === "progress" && event.payload.mode === "interpretation"
                      ? "accent"
                      : "neutral"
                  }
                >
                  {eventLabel(event)}
                </Badge>
                {behavior && <strong>{behavior.name}</strong>}
                {event.state === "voided" && <Badge>Withdrawn · excluded</Badge>}
              </div>
              <p className="dynamic-note-body">{event.summary}</p>
              {event.payload.kind === "progress" && event.payload.value !== undefined && (
                <p className="daily-report-quantity">
                  {event.payload.value.toLocaleString()} {behavior?.unit ?? "reported units"}
                </p>
              )}
              <p className="daily-report-basis">{eventBasis(event)}</p>
              <dl className="daily-event-times">
                <div>
                  <dt>{timeBasis(event.occurred)}</dt>
                  <dd>{dailyTime(event.occurred.at, event.occurred.timezone)}</dd>
                </div>
                <div>
                  <dt>Recorded</dt>
                  <dd>{dailyTime(event.recordedAt, event.occurred.timezone)}</dd>
                </div>
              </dl>
              <p className="dynamic-note-author">
                {event.wakingDayId
                  ? day
                    ? wakingDayLabel(day)
                    : "Assigned to an earlier waking day"
                  : "Waking day unassigned"}{" "}
                · Recorded by {event.authoredBy === "owner" ? "you" : "Valerie"}
              </p>
              {event.payload.kind === "waking" && !event.stateApplied && (
                <p className="dynamic-field-hint">
                  Kept as history; this report did not change the current waking state.
                </p>
              )}
              {event.sources.length > 0 && <FocusSources api={api} sources={event.sources} />}
              {event.version > 1 && event.revisionSources.length > 0 && (
                <FocusSources
                  api={api}
                  sources={event.revisionSources}
                  label="Correction context"
                />
              )}
              {event.version > 1 && <PreviousVersions api={api} event={event} />}
              {event.state === "active" && event.payload.kind !== "day_merge" && (
                <div className="dynamic-actions daily-event-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => onEdit(event)}
                  >
                    Correct or move report
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => onWithdraw(event)}
                  >
                    Withdraw report
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {nextCursor && (
        <button
          type="button"
          className="button button--secondary"
          disabled={loading || busy}
          onClick={() => void more()}
        >
          {loading ? "Loading…" : "Load earlier reports"}
        </button>
      )}
    </article>
  );
}
