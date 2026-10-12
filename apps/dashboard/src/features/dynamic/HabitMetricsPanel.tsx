import type { HabitMetrics, HabitOutcome } from "@valerie/core";
import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { coverageLabel, habitOutcomeLabels } from "./agreement-presentation";

export function HabitMetricsPanel({
  api,
  visible,
  refreshKey,
}: {
  api: Api;
  visible: boolean;
  refreshKey: number;
}) {
  const [period, setPeriod] = useState<"day" | "week" | "month">("week");
  const [metrics, setMetrics] = useState<HabitMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: A saved record invalidates the displayed coverage.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<HabitMetrics>(`/agreements/metrics?period=${period}&dayLimit=90`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setMetrics(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, visible, period, refreshKey]);
  const outcomes: HabitOutcome[] = [
    "done",
    "smaller_done",
    "partial",
    "skipped",
    "excused",
    "not_reported",
    "uncertain",
    "not_applicable",
  ];
  return (
    <article
      className="panel dynamic-panel agreement-metrics"
      aria-labelledby="habit-metrics-title"
    >
      <div className="dynamic-heading">
        <h2 id="habit-metrics-title">Reporting and progress</h2>
        <label className="dynamic-field">
          <span className="sr-only">Group habit records</span>
          <select
            aria-label="Group habit records"
            value={period}
            onChange={(event) => setPeriod(event.target.value as typeof period)}
          >
            <option value="day">By waking day</option>
            <option value="week">By week</option>
            <option value="month">By month</option>
          </select>
        </label>
      </div>
      <p className="dynamic-intro">
        Coverage reflects established opportunities and what was reported. Unreported days are not
        labelled failures.
      </p>
      {error && <ErrorNotice message={error} />}
      {!metrics ? (
        <p className="muted">{loading ? "Loading progress…" : "Progress is unavailable."}</p>
      ) : (
        <>
          <p className="dynamic-field-hint">
            {metrics.range.wakingDays} established waking days
            {metrics.range.fromLocalDate && metrics.range.toLocalDate
              ? ` · ${metrics.range.fromLocalDate} to ${metrics.range.toLocalDate}`
              : ""}
            . The view considers up to {metrics.range.dayLimit} recent waking days.
          </p>
          {metrics.habits.length === 0 ? (
            <p className="daily-empty">No habit opportunities to summarize yet.</p>
          ) : (
            <ul className="agreement-metric-list">
              {metrics.habits.map((habit) => (
                <li key={habit.habitId}>
                  <h3>{habit.name}</h3>
                  <p>{coverageLabel(habit.counts)}</p>
                  <dl className="agreement-outcomes">
                    {outcomes.map((outcome) => (
                      <div key={outcome}>
                        <dt>
                          {outcome === "partial"
                            ? "Partial / below target"
                            : habitOutcomeLabels[outcome]}
                        </dt>
                        <dd>{habit.counts.outcomes[outcome]}</dd>
                      </div>
                    ))}
                  </dl>
                  <details className="agreement-advanced">
                    <summary>
                      {period === "day"
                        ? "Waking-day records"
                        : period === "week"
                          ? "Weekly records"
                          : "Monthly records"}
                    </summary>
                    <ul className="agreement-periods">
                      {metrics.periods
                        .filter((entry) => entry.habitId === habit.habitId)
                        .map((entry) => (
                          <li key={entry.key}>
                            <strong>
                              {entry.key === "unknown"
                                ? "Date uncertain"
                                : period === "week"
                                  ? `Week of ${entry.key}`
                                  : entry.key}
                            </strong>
                            <span>{coverageLabel(entry)}</span>
                          </li>
                        ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {(metrics.unassignedReports > 0 || metrics.uncertainTimingReports > 0) && (
            <p className="dynamic-field-hint">
              {metrics.unassignedReports} reports are unassigned to a waking day;{" "}
              {metrics.uncertainTimingReports} have uncertain timing.
            </p>
          )}
          {metrics.recentObstacles.length > 0 && (
            <details className="agreement-advanced">
              <summary>Recent reports and context</summary>
              <ul>
                {metrics.recentObstacles.map((event) => (
                  <li key={event.id}>
                    <span className="muted">
                      {event.evidenceKind === "valerie_interpretation"
                        ? "Interpretation"
                        : "Reported context"}
                      :{" "}
                    </span>
                    {event.summary}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </article>
  );
}
