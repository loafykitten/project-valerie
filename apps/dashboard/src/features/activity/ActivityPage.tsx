import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, EmptyState, ErrorNotice, formattedTime } from "../../components/ui";

type ActivityEvent = {
  id: string;
  kind: string;
  summary: string;
  status: string;
  createdAt: string;
};

type Activity = { events: ActivityEvent[]; outstanding: ActivityEvent[] };

function statusTone(status: string): "success" | "warning" | "neutral" {
  if (["completed", "success", "succeeded"].includes(status)) return "success";
  if (["failed", "error", "blocked", "pending", "running"].includes(status)) return "warning";
  return "neutral";
}

export function ActivityPage({ api }: { api: Api }) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [resolvedQuery, setResolvedQuery] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const query = filter.trim().slice(0, 200);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The refresh counter handles both manual refresh and the polling interval.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const debounce = window.setTimeout(
      () => {
        api<Activity>(`/activity?q=${encodeURIComponent(query)}`, { signal: controller.signal })
          .then((result) => {
            if (controller.signal.aborted) return;
            setActivity(result);
            setResolvedQuery(query);
            setLastRefreshed(new Date().toISOString());
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted) setError(errorMessage(error));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      window.clearTimeout(debounce);
      controller.abort();
    };
  }, [api, query, refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") setRefresh((value) => value + 1);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const matchingActivity = activity !== null && query === resolvedQuery;
  // Keep matching results mounted while polling; a new query still gets a loading state.
  const searching = !error && !matchingActivity;

  return (
    <section className="page" aria-labelledby="activity-title">
      <div className="page-heading">
        <div>
          <h1 id="activity-title">Activity</h1>
          <p className="page-description">Recorded actions and outstanding work.</p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={loading || searching}
        >
          {loading || searching ? "Refreshing…" : "Refresh activity"}
        </button>
      </div>
      {error && (
        <ErrorNotice message={error}>
          {activity && (
            <p>
              {matchingActivity
                ? "Showing the last successful results."
                : "Outstanding work is from the last successful refresh."}
            </p>
          )}
        </ErrorNotice>
      )}
      <div className="activity-summary panel">
        <span className="activity-emblem" aria-hidden="true">
          ↗
        </span>
        <div>
          <p className="eyebrow">Outstanding work</p>
          <h2>
            {activity
              ? activity.outstanding.length === 0
                ? "No outstanding work recorded."
                : `${activity.outstanding.length} ${activity.outstanding.length === 1 ? "item needs" : "items need"} attention.`
              : "Checking activity…"}
          </h2>
          <p>System watching and conversational recaps are not built yet.</p>
        </div>
        {activity && (
          <Badge tone={activity.outstanding.length ? "warning" : "neutral"}>
            {activity.outstanding.length} outstanding
          </Badge>
        )}
      </div>
      {activity && activity.outstanding.length > 0 && (
        <div className="panel outstanding-panel">
          <div className="panel-heading">
            <h2>Still in progress</h2>
          </div>
          {activity.outstanding.map((event) => (
            <div className="integration-row" key={event.id}>
              <p>{event.summary}</p>
              <Badge tone={statusTone(event.status)}>{event.status}</Badge>
            </div>
          ))}
        </div>
      )}
      <div className="panel activity-panel">
        <div className="panel-heading">
          <div>
            <h2>Recent activity</h2>
            <p>Search the last 7 days. Up to 100 matching events are shown.</p>
            <p>
              {lastRefreshed
                ? `Last refreshed ${formattedTime(lastRefreshed)} · refreshes every 30 seconds while visible.`
                : "Recent events will appear here."}
            </p>
          </div>
          <div className="search-field">
            <label className="sr-only" htmlFor="activity-search">
              Search activity from the last 7 days
            </label>
            <span aria-hidden="true">⌕</span>
            <input
              id="activity-search"
              type="search"
              placeholder="Search the last 7 days…"
              maxLength={200}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        </div>
        {searching ? (
          <p className="panel-padding muted" role="status">
            {query ? "Searching activity…" : "Loading activity…"}
          </p>
        ) : error && !matchingActivity ? (
          <p className="panel-padding muted">
            This activity could not be loaded. Refresh to try again.
          </p>
        ) : activity && activity.events.length > 0 ? (
          <ol className="event-list">
            {activity.events.map((event) => (
              <li className="event-row" key={event.id}>
                <span
                  className={`event-marker event-marker--${statusTone(event.status)}`}
                  aria-hidden="true"
                />
                <div className="event-content">
                  <div className="event-kind">{event.kind.replaceAll(/[._-]/g, " ")}</div>
                  <p>{event.summary}</p>
                  <time dateTime={event.createdAt}>{formattedTime(event.createdAt)}</time>
                </div>
                <Badge tone={statusTone(event.status)}>{event.status}</Badge>
              </li>
            ))}
          </ol>
        ) : (
          activity && (
            <EmptyState title={query ? "No matching activity" : "No recorded activity"}>
              <p>
                {query
                  ? "No matches in the last 7 days. Try a different word, or clear the search to see recent events."
                  : "Prompt saves and other recorded actions appear here."}
              </p>
            </EmptyState>
          )
        )}
      </div>
    </section>
  );
}
