import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, EmptyState, ErrorNotice } from "../../components/ui";
import {
  heartbeatReason,
  heartbeatRunPresentation,
  heartbeatStatusPresentation,
  heartbeatTime,
} from "./presentation";
import {
  type HeartbeatDraft,
  type HeartbeatState,
  heartbeatDraft,
  heartbeatDraftChanged,
} from "./types";
import "./heartbeat.css";

type NumericSetting =
  | "minIntervalMinutes"
  | "maxIntervalMinutes"
  | "minIdleMinutes"
  | "maxPerDay"
  | "maxUnanswered"
  | "maxMessageChars";

export function HeartbeatPage({
  api,
  onDirtyChange,
  visible,
}: {
  api: Api;
  onDirtyChange: (dirty: boolean) => void;
  visible: boolean;
}) {
  const [state, setState] = useState<HeartbeatState | null>(null);
  const [draft, setDraft] = useState<HeartbeatDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const dirty = Boolean(state && draft && heartbeatDraftChanged(draft, state.settings));
  const edited = useRef(false);
  const previousEnd = useRef("04:00");
  edited.current = dirty;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!visible || busy) return;
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const result = await api<HeartbeatState>("/heartbeat", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState(result);
        if (!edited.current) setDraft(heartbeatDraft(result.settings));
        setStale(false);
        setStatusError("");
        setRefreshedAt(new Date().toISOString());
      } catch (e) {
        if (!controller.signal.aborted) {
          setStale(true);
          setStatusError(errorMessage(e));
        }
      } finally {
        pending = false;
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [api, visible, busy]);

  function edit(patch: Partial<HeartbeatDraft>) {
    edited.current = true;
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setNotice("");
  }

  function accept(result: HeartbeatState, replaceDraft: boolean) {
    setState(result);
    if (replaceDraft) {
      edited.current = false;
      setDraft(heartbeatDraft(result.settings));
    }
    setStale(false);
    setStatusError("");
    setRefreshedAt(new Date().toISOString());
  }

  async function refresh(reloadDraft = false) {
    setBusy(true);
    setError("");
    try {
      accept(await api<HeartbeatState>("/heartbeat"), reloadDraft || !edited.current);
      if (reloadDraft) setNotice("Loaded the latest saved settings.");
    } catch (e) {
      setStatusError(errorMessage(e));
      setStale(true);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { version, ...settings } = draft;
      accept(
        await api<HeartbeatState>("/heartbeat/settings", {
          method: "PUT",
          body: JSON.stringify({ ...settings, expectedVersion: version }),
        }),
        true,
      );
      setNotice("Heartbeat settings saved.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function pauseOrResume(pausedUntil: string | null | "resume") {
    if (!state) return;
    const previousVersion = state.settings.version;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const resume = pausedUntil === "resume";
      const result = await api<HeartbeatState>(`/heartbeat/${resume ? "resume" : "pause"}`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: previousVersion,
          ...(!resume ? { pausedUntil } : {}),
        }),
      });
      accept(result, !edited.current);
      // Rebase only our pause change. A draft predating another saved edit remains stale.
      if (edited.current)
        setDraft((current) =>
          current?.version === previousVersion
            ? { ...current, version: result.settings.version }
            : current,
        );
      setNotice(
        resume
          ? "Heartbeats resumed within your saved hours and limits."
          : "Heartbeats paused. A message already being delivered may still arrive.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function numberField(
    key: NumericSetting,
    label: string,
    detail: string,
    min: number,
    max: number,
  ) {
    return (
      <label className="heartbeat-field">
        <span className="heartbeat-field-label">{label}</span>
        <input
          type="number"
          required
          min={min}
          max={max}
          step={1}
          disabled={busy}
          value={draft?.[key] ?? ""}
          onChange={(event) => edit({ [key]: Number(event.target.value) })}
        />
        <small>{detail}</small>
      </label>
    );
  }

  const presentation = state ? heartbeatStatusPresentation(state) : null;
  const conflict = Boolean(draft && state && dirty && draft.version !== state.settings.version);
  const anyTime = draft?.activeStart === draft?.activeEnd;
  return (
    <section className="page heartbeat-page" aria-labelledby="heartbeat-title">
      <div className="page-heading">
        <div>
          <h1 id="heartbeat-title">Heartbeats</h1>
          <p className="page-description">
            Little moments of warmth, playfulness, curiosity, or a gentle invitation to talk.
          </p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={() => {
            void refresh();
          }}
        >
          Refresh status
        </button>
      </div>
      {(error || statusError) && <ErrorNotice message={error || statusError} />}
      {notice && (
        <div className="notice heartbeat-notice" role="status">
          <p>{notice}</p>
        </div>
      )}
      {!state || !draft || !presentation ? (
        <div className="panel heartbeat-panel">
          <p className="muted">
            {error || statusError ? "Heartbeat status is unavailable." : "Loading heartbeats…"}
          </p>
        </div>
      ) : (
        <>
          <div className="panel heartbeat-status">
            <div className="heartbeat-status-heading">
              <div>
                <span className="eyebrow">{stale ? "Last known status" : "Current status"}</span>
                <h2>{presentation.title}</h2>
                <p>{presentation.description}</p>
              </div>
              <Badge tone={stale ? "warning" : presentation.tone}>
                {stale ? "Status unavailable" : presentation.title}
              </Badge>
            </div>
            <dl className="heartbeat-counts">
              <div>
                <dt>Sent this waking day</dt>
                <dd>
                  {state.status.deliveredToday} <span>/ {state.settings.maxPerDay}</span>
                </dd>
              </div>
              <div>
                <dt>Heartbeats without a reply</dt>
                <dd>
                  {state.status.unansweredCount} <span>/ {state.settings.maxUnanswered}</span>
                </dd>
              </div>
              <div>
                <dt>Next opportunity</dt>
                <dd className="heartbeat-next-time">
                  {heartbeatTime(state.status.nextOpportunityAt, state.settings.timezone)}
                </dd>
              </div>
            </dl>
            {state.status.unknownToday > 0 && (
              <p className="heartbeat-uncertain">
                {state.status.unknownToday} delivery{" "}
                {state.status.unknownToday === 1 ? "is" : "are"} uncertain this waking day. These
                count toward the limits and are not resent automatically.
              </p>
            )}
            {state.status.sendingToday > 0 && (
              <p className="heartbeat-uncertain">
                A message is being sent. Its place in the daily allowance is reserved while Telegram
                confirms the result.
              </p>
            )}
            <div className="heartbeat-status-footer">
              <p>Opportunities are flexible. Valerie can choose to stay quiet.</p>
              <div className="heartbeat-actions">
                {state.status.paused ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={busy}
                    onClick={() => {
                      void pauseOrResume("resume");
                    }}
                  >
                    Resume
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={busy || !state.settings.enabled}
                      onClick={() => {
                        void pauseOrResume(new Date(Date.now() + 86_400_000).toISOString());
                      }}
                    >
                      Pause for 24 hours
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || !state.settings.enabled}
                      onClick={() => {
                        void pauseOrResume(null);
                      }}
                    >
                      Pause until resumed
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="heartbeat-columns">
            <div className="panel heartbeat-panel">
              <h2>Timing and space</h2>
              <p className="heartbeat-intro">
                Short messages can simply brighten your day. There is no daily list of topics to
                cover, and warmth can include an invitation to come talk.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <label className="heartbeat-enable">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    disabled={busy}
                    onChange={(event) => edit({ enabled: event.target.checked })}
                  />
                  <span>
                    <strong>Enable heartbeats</strong>
                    <small>
                      Allow Valerie to initiate a short Telegram message within these limits.
                    </small>
                  </span>
                </label>
                <fieldset className="heartbeat-hours-choice" disabled={busy}>
                  <legend>When messages are welcome</legend>
                  <label>
                    <input
                      type="radio"
                      name="heartbeat-hours"
                      checked={anyTime}
                      onChange={() => {
                        previousEnd.current = draft.activeEnd;
                        edit({ activeEnd: draft.activeStart });
                      }}
                    />
                    <span>Any time, day or night</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="heartbeat-hours"
                      checked={!anyTime}
                      onChange={() =>
                        edit({
                          activeEnd:
                            previousEnd.current !== draft.activeStart
                              ? previousEnd.current
                              : draft.activeStart === "04:00"
                                ? "23:00"
                                : "04:00",
                        })
                      }
                    />
                    <span>Within these hours</span>
                  </label>
                </fieldset>
                <div className="heartbeat-form-grid">
                  <label className="heartbeat-field heartbeat-timezone">
                    <span className="heartbeat-field-label">Timezone</span>
                    <input
                      type="text"
                      required
                      maxLength={100}
                      value={draft.timezone}
                      disabled={busy}
                      placeholder="America/Chicago"
                      onChange={(event) => edit({ timezone: event.target.value })}
                    />
                    <small>Hours and waking-day limits follow this timezone.</small>
                  </label>
                  <label className="heartbeat-field">
                    <span className="heartbeat-field-label">
                      {anyTime ? "Daily allowance resets at" : "Messages allowed from"}
                    </span>
                    <input
                      type="time"
                      required
                      value={draft.activeStart}
                      disabled={busy}
                      onChange={(event) =>
                        edit({
                          activeStart: event.target.value,
                          ...(anyTime ? { activeEnd: event.target.value } : {}),
                        })
                      }
                    />
                  </label>
                  {!anyTime && (
                    <label className="heartbeat-field">
                      <span className="heartbeat-field-label">Until</span>
                      <input
                        type="time"
                        required
                        value={draft.activeEnd}
                        disabled={busy}
                        onChange={(event) => edit({ activeEnd: event.target.value })}
                      />
                    </label>
                  )}
                </div>
                <p className="heartbeat-field-note">
                  {anyTime
                    ? "Messages are welcome around the clock. Recent conversation can guide a softer message if you may be asleep, and Valerie can still stay quiet."
                    : "Hours can cross midnight, such as noon until 4 a.m. The daily allowance resets at the start time."}
                </p>
                <div className="heartbeat-form-grid">
                  {numberField(
                    "maxPerDay",
                    "Maximum per waking day",
                    "An upper limit, not a target.",
                    1,
                    8,
                  )}
                  {numberField(
                    "maxUnanswered",
                    "Maximum without a reply",
                    "A little warm follow-up is welcome; stop at this limit until you reply.",
                    1,
                    8,
                  )}
                </div>
                <details className="heartbeat-advanced">
                  <summary>Spacing and message length</summary>
                  <div className="heartbeat-form-grid">
                    {numberField(
                      "minIntervalMinutes",
                      "Minimum spacing (minutes)",
                      "Minimum time between heartbeat opportunities.",
                      30,
                      1440,
                    )}
                    {numberField(
                      "maxIntervalMinutes",
                      "Maximum spacing (minutes)",
                      "Random spacing varies up to this value. Quiet hours and other limits can delay the next opportunity.",
                      30,
                      1440,
                    )}
                    {numberField(
                      "minIdleMinutes",
                      "Conversation space (minutes)",
                      "Wait this long after recent conversation activity.",
                      15,
                      1440,
                    )}
                    {numberField(
                      "maxMessageChars",
                      "Maximum message characters",
                      "Brief by default; typically one to three sentences.",
                      80,
                      1000,
                    )}
                  </div>
                </details>
                {conflict && (
                  <div className="notice" role="status">
                    <p>
                      Settings changed elsewhere. Your draft is still here; load the saved settings
                      before making a new edit.
                    </p>
                  </div>
                )}
                <div className="heartbeat-actions heartbeat-save">
                  <button type="submit" className="button" disabled={busy || !dirty || conflict}>
                    {busy ? "Working…" : "Save settings"}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={busy || !dirty}
                    onClick={() => {
                      void refresh(true);
                    }}
                  >
                    Load saved settings
                  </button>
                  {dirty && <span className="muted">Unsaved changes</span>}
                </div>
              </form>
            </div>

            <div className="panel heartbeat-panel heartbeat-history">
              <h2>Recent opportunities</h2>
              <p className="heartbeat-intro">
                Actual decisions and delivery results. Sent messages also appear in Conversation.
              </p>
              {state.recentRuns.length === 0 ? (
                <EmptyState title="No opportunities yet">
                  <p>Results will appear here once heartbeats start considering messages.</p>
                </EmptyState>
              ) : (
                <ol className="heartbeat-runs">
                  {state.recentRuns.map((run) => {
                    const result = heartbeatRunPresentation(run.status);
                    return (
                      <li key={run.id}>
                        <div className="heartbeat-run-heading">
                          <Badge tone={result.tone}>{result.label}</Badge>
                          <time dateTime={run.deliveredAt ?? run.finishedAt ?? run.createdAt}>
                            {heartbeatTime(
                              run.deliveredAt ?? run.finishedAt ?? run.createdAt,
                              state.settings.timezone,
                            )}
                          </time>
                        </div>
                        <p>{heartbeatReason(run.reason) || result.description}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
              {refreshedAt && (
                <p className="heartbeat-refreshed">
                  Updated {heartbeatTime(refreshedAt, state.settings.timezone)}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
