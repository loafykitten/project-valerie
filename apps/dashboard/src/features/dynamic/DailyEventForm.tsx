import type {
  DailyEvent,
  DailyEventEdit,
  DailyWriteResult,
  ProgressBehavior,
  ProgressMode,
  ProgressReportInput,
  ProgressStatus,
  WakingDay,
} from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import {
  DailyTimeField,
  newTimeDraft,
  resolveTimeDraft,
  timeDraftFromReported,
} from "./DailyTimeField";
import { dailyWriteMessage, progressStatusLabels, wakingDayLabel } from "./daily-presentation";

export function DailyEventForm({
  api,
  event,
  latest,
  behaviors,
  days,
  currentDayId,
  onClose,
  onRefresh,
  onDirtyChange,
  onBusyChange,
}: {
  api: Api;
  event: DailyEvent | null;
  latest: DailyEvent | null;
  behaviors: ProgressBehavior[];
  days: WakingDay[];
  currentDayId: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const initialProgress = event?.payload.kind === "progress" ? event.payload : null;
  const initialTime = event
    ? timeDraftFromReported(event.occurred)
    : newTimeDraft("America/Chicago");
  const initialPlannedTime = initialProgress?.plannedFor
    ? timeDraftFromReported({
        at: initialProgress.plannedFor,
        timezone: event?.occurred.timezone ?? "America/Chicago",
        basis: "exact",
      })
    : newTimeDraft("America/Chicago", "unknown");
  const [baseVersion, setBaseVersion] = useState(event?.version ?? null);
  const [behaviorId, setBehaviorId] = useState(initialProgress?.behaviorId ?? "");
  const [mode, setMode] = useState<ProgressMode>(initialProgress?.mode ?? "occurrence");
  const [quantity, setQuantity] = useState(initialProgress?.value?.toString() ?? "");
  const [status, setStatus] = useState<ProgressStatus | "">(initialProgress?.status ?? "");
  const [summary, setSummary] = useState(event?.summary ?? "");
  const [dayId, setDayId] = useState(event ? (event.wakingDayId ?? "") : (currentDayId ?? ""));
  const [time, setTime] = useState(initialTime);
  const [plannedTime, setPlannedTime] = useState(initialPlannedTime);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const writing = useRef(false);
  const behavior = behaviors.find((item) => item.id === behaviorId);
  const isProgress = !event || event.payload.kind === "progress";
  const conflict = Boolean(event && latest && latest.version !== baseVersion);
  const withdrawn = event && latest?.state === "voided";
  useEffect(() => onDirtyChange(edited || busy), [edited, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  async function save() {
    if (writing.current || conflict || withdrawn || unconfirmed) return;
    if (event && !summary.trim()) {
      setError("Keep a short description of what this report says.");
      return;
    }
    if (isProgress && !behavior) {
      setError("Choose a tracking subject for this report.");
      return;
    }
    if (isProgress && mode === "status" && !status) {
      setError("Choose the status you are reporting.");
      return;
    }
    if (
      isProgress &&
      (mode === "occurrence" || mode === "total_so_far") &&
      (!quantity || !Number.isFinite(Number(quantity)) || Number(quantity) < 0)
    ) {
      setError("Enter the quantity you are reporting.");
      return;
    }
    if (isProgress && (mode === "plan" || mode === "interpretation") && !summary.trim()) {
      setError("Add a short description of the plan or interpretation.");
      return;
    }
    writing.current = true;
    onBusyChange(true);
    setBusy(true);
    setError("");
    try {
      const changedTime = !event || JSON.stringify(time) !== JSON.stringify(initialTime);
      const resolved = changedTime
        ? await resolveTimeDraft(api, time)
        : { time: event.occurred, notice: "" };
      const plan =
        isProgress && mode === "plan"
          ? event && JSON.stringify(plannedTime) === JSON.stringify(initialPlannedTime)
            ? {
                time: {
                  at: initialProgress?.plannedFor ?? null,
                  timezone: plannedTime.timezone,
                  basis: "exact" as const,
                },
                notice: "",
              }
            : await resolveTimeDraft(api, plannedTime)
          : null;
      const progress: Omit<
        ProgressReportInput,
        "behaviorId" | "wakingDayId" | "occurred" | "summary"
      > = {
        mode,
        ...(mode === "occurrence" || mode === "total_so_far" ? { value: Number(quantity) } : {}),
        ...(mode === "status" && status ? { status } : {}),
        ...(mode === "total_so_far" &&
        (changedTime ? resolved.time.at : (initialProgress?.totalThroughAt ?? resolved.time.at))
          ? {
              totalThroughAt: (changedTime
                ? resolved.time.at
                : (initialProgress?.totalThroughAt ?? resolved.time.at)) as string,
            }
          : {}),
        ...(plan?.time.at ? { plannedFor: plan.time.at } : {}),
        evidenceKind: mode === "interpretation" ? "valerie_interpretation" : "owner_report",
      };
      const text =
        summary.trim() ||
        `${behavior?.name ?? "Waking report"}: ${mode === "status" && status ? progressStatusLabels[status] : mode === "total_so_far" ? `reported total ${quantity}` : `reported ${quantity}`}.`;
      const progressChanged =
        isProgress &&
        (!initialProgress ||
          (["mode", "value", "status", "totalThroughAt", "plannedFor"] as const).some(
            (key) => progress[key] !== initialProgress[key],
          ) ||
          progress.evidenceKind !== event?.evidenceKind);
      const input: DailyEventEdit | ProgressReportInput = event
        ? {
            id: event.id,
            expectedVersion: baseVersion as number,
            ...(text !== event.summary ? { summary: text } : {}),
            ...(dayId !== (event.wakingDayId ?? "") ? { wakingDayId: dayId || null } : {}),
            ...(changedTime ? { occurred: resolved.time } : {}),
            ...(progressChanged ? { progress } : {}),
          }
        : {
            behaviorId,
            wakingDayId: dayId || null,
            occurred: resolved.time,
            summary: text,
            ...progress,
          };
      const result = await api<DailyWriteResult>(
        event ? `/dynamic/daily/events/${encodeURIComponent(event.id)}` : "/dynamic/daily/progress",
        { method: event ? "PUT" : "POST", body: JSON.stringify(input) },
      );
      if (result.effect === "needs_clarification") {
        setError(dailyWriteMessage(result.reason));
        return;
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      // The source may have committed despite a lost response; inspect the saved list before repeating it.
      if (
        cause instanceof Error &&
        "status" in cause &&
        (cause.status === 0 || (typeof cause.status === "number" && cause.status >= 500))
      )
        setUnconfirmed(true);
    } finally {
      writing.current = false;
      onBusyChange(false);
      setBusy(false);
      onRefresh();
    }
  }
  return (
    <article
      className="panel dynamic-panel daily-event-editor"
      aria-labelledby="daily-event-editor-title"
    >
      <h2 id="daily-event-editor-title">
        {event ? "Correct or move a report" : "Add a progress report"}
      </h2>
      <p className="dynamic-intro">
        {event
          ? "Earlier versions stay in the history. Corrections update the shared result."
          : "Record what happened, what you intend, or what remains uncertain."}
      </p>
      {error && <ErrorNotice message={error} />}
      <form
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          void save();
        }}
      >
        <fieldset className="dynamic-fields" disabled={busy}>
          <legend className="sr-only">Daily report details</legend>
          {isProgress && (
            <>
              <label className="dynamic-field">
                <span>Tracking subject</span>
                <select
                  required
                  aria-label="Report tracking subject"
                  value={behaviorId}
                  disabled={busy || Boolean(event)}
                  onChange={(change) => {
                    const next = behaviors.find((item) => item.id === change.target.value);
                    setBehaviorId(change.target.value);
                    setMode(next?.valueKind === "status" ? "status" : "occurrence");
                    setQuantity("");
                    setStatus("");
                    setEdited(true);
                  }}
                >
                  <option value="">Choose a subject</option>
                  {behaviors
                    .filter((item) => item.state === "active" || item.id === behaviorId)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="dynamic-field">
                <span>Kind of report</span>
                <select
                  aria-label="Progress report kind"
                  value={mode}
                  onChange={(change) => {
                    setMode(change.target.value as ProgressMode);
                    setEdited(true);
                  }}
                >
                  {behavior?.valueKind !== "status" && (
                    <>
                      <option value="occurrence">A distinct occurrence or quantity</option>
                      <option value="total_so_far">My total so far</option>
                    </>
                  )}
                  {behavior?.valueKind === "status" && (
                    <option value="status">A reported status</option>
                  )}
                  <option value="plan">A plan; nothing completed yet</option>
                  <option value="interpretation">An interpretation or uncertainty</option>
                </select>
              </label>
              {(mode === "occurrence" || mode === "total_so_far") && (
                <label className="dynamic-field">
                  <span>
                    {mode === "total_so_far" ? "Total so far" : "Quantity"}{" "}
                    <small>{behavior?.unit}</small>
                  </span>
                  <input
                    required
                    type="number"
                    step="any"
                    min={0}
                    aria-label="Reported quantity"
                    value={quantity}
                    onChange={(change) => {
                      setQuantity(change.target.value);
                      setEdited(true);
                    }}
                  />
                  {mode === "total_so_far" && (
                    <small>
                      Earlier occurrences are included in this total. They will not be added again.
                    </small>
                  )}
                </label>
              )}
              {mode === "status" && (
                <label className="dynamic-field">
                  <span>Reported status</span>
                  <select
                    required
                    aria-label="Reported progress status"
                    value={status}
                    onChange={(change) => {
                      setStatus(change.target.value as ProgressStatus);
                      setEdited(true);
                    }}
                  >
                    <option value="">Choose a status</option>
                    {Object.entries(progressStatusLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <small>
                    Not knowing is different from missing something. An interpretation can keep that
                    uncertainty without claiming completion.
                  </small>
                </label>
              )}
            </>
          )}
          <label className="dynamic-field">
            <span>Details</span>
            <textarea
              rows={3}
              maxLength={800}
              aria-label="Daily report details"
              value={summary}
              onChange={(change) => {
                setSummary(change.target.value);
                setEdited(true);
              }}
            />
          </label>
          <DailyTimeField
            label={
              mode === "total_so_far" && isProgress
                ? "Total through this time"
                : "When it happened or was reported"
            }
            draft={time}
            disabled={busy}
            onChange={(value) => {
              setTime(value);
              setEdited(true);
            }}
          />
          {isProgress && mode === "plan" && (
            <DailyTimeField
              label="Planned for"
              draft={plannedTime}
              disabled={busy}
              allowNow={false}
              onChange={(value) => {
                setPlannedTime(value);
                setEdited(true);
              }}
            />
          )}
          <label className="dynamic-field">
            <span>Waking day</span>
            <select
              aria-label="Report waking day"
              value={dayId}
              onChange={(change) => {
                setDayId(change.target.value);
                setEdited(true);
              }}
            >
              <option value="">Unassigned; day not established</option>
              {days
                .filter((day) => !day.mergedIntoDayId)
                .map((day) => (
                  <option key={day.id} value={day.id}>
                    {day.current ? "Current · " : ""}
                    {wakingDayLabel(day)}
                  </option>
                ))}
            </select>
            <small>A report can remain unassigned when its waking day is unknown.</small>
          </label>
        </fieldset>
        {(conflict || withdrawn) && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              {withdrawn
                ? "This report was withdrawn elsewhere. Your draft remains here to copy."
                : "This report changed elsewhere. Your draft is kept; compare the latest report before saving."}
            </p>
            {latest && <p>Saved: {latest.summary}</p>}
            {!withdrawn && latest && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setBaseVersion(latest.version);
                  setError("");
                }}
              >
                Keep my report draft over the latest version
              </button>
            )}
          </div>
        )}
        {unconfirmed && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              The save could not be confirmed. Check the refreshed reports before saving this again.
            </p>
            <button type="button" className="text-button" onClick={() => setUnconfirmed(false)}>
              I checked; allow another save
            </button>
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || !edited || conflict || Boolean(withdrawn) || unconfirmed}
          >
            {busy ? "Saving…" : event ? "Save report correction" : "Save progress report"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              if (!edited || window.confirm("Discard this unsaved daily report?")) onClose();
            }}
          >
            Cancel report edit
          </button>
        </div>
      </form>
    </article>
  );
}
