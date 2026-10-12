import type {
  DailyWriteResult,
  WakingDay,
  WakingReportInput,
  WakingReportKind,
} from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { DailyTimeField, newTimeDraft, resolveTimeDraft } from "./DailyTimeField";
import { dailyWriteMessage, wakingDayLabel, wakingReportLabels } from "./daily-presentation";

export function WakingReportForm({
  api,
  currentDay,
  days,
  onRefresh,
  onDirtyChange,
}: {
  api: Api;
  currentDay: WakingDay | null;
  days: WakingDay[];
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const timezone = currentDay?.wakeTime.timezone ?? "America/Chicago";
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<WakingReportKind | "">("");
  const [summary, setSummary] = useState("");
  const [time, setTime] = useState(() => newTimeDraft(timezone));
  const [sleep, setSleep] = useState(() => newTimeDraft(timezone, "unknown"));
  const [historical, setHistorical] = useState(false);
  const [historyDay, setHistoryDay] = useState("");
  const [base, setBase] = useState({
    id: currentDay?.id ?? null,
    version: currentDay?.version ?? null,
  });
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const writing = useRef(false);
  useEffect(() => {
    if (!edited) setBase({ id: currentDay?.id ?? null, version: currentDay?.version ?? null });
  }, [currentDay, edited]);
  useEffect(() => onDirtyChange(edited || busy), [edited, busy, onDirtyChange]);
  const conflict =
    edited &&
    !historical &&
    (base.id !== (currentDay?.id ?? null) || base.version !== (currentDay?.version ?? null));
  function reset() {
    setReport("");
    setSummary("");
    setTime(newTimeDraft(timezone));
    setSleep(newTimeDraft(timezone, "unknown"));
    setHistorical(false);
    setHistoryDay("");
    setEdited(false);
    setOpen(false);
  }
  async function save() {
    if (writing.current || !report || conflict) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const occurred = await resolveTimeDraft(api, time);
      const sleepTime = report === "sleep_plan" ? await resolveTimeDraft(api, sleep) : null;
      const input: WakingReportInput = {
        report,
        expectedCurrentDayId: base.id,
        expectedDayVersion: base.version,
        mode: historical ? "history" : "current",
        occurred: occurred.time,
        summary: summary.trim() || wakingReportLabels[report],
        ...(historical ? { wakingDayId: historyDay || null } : {}),
        ...(report === "main_wake" ? { newMainPeriod: true } : {}),
        ...(sleepTime
          ? {
              expectedSleepAt: sleepTime.time.at,
              sleepEstimateBasis: sleepTime.time.at ? "owner_plan" : "none",
            }
          : {}),
      };
      const result = await api<DailyWriteResult>("/dynamic/daily/waking", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (result.effect === "needs_clarification") {
        setError(dailyWriteMessage(result.reason));
        return;
      }
      reset();
      setNotice(
        [
          result.effect === "already_recorded"
            ? "This waking update was already recorded."
            : "Waking update saved.",
          occurred.notice,
          sleepTime?.notice ?? "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      onRefresh();
    }
  }
  return (
    <div className="daily-waking-report">
      <button
        type="button"
        className="button button--secondary"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? "Hide waking update" : "Add a waking update"}
      </button>
      {notice && (
        <p className="dynamic-feedback" role="status">
          {notice}
        </p>
      )}
      <div hidden={!open}>
        {error && <ErrorNotice message={error} />}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="dynamic-fields" disabled={busy}>
            <legend className="sr-only">Waking update</legend>
            <label className="dynamic-field">
              <span>Update to record</span>
              <select
                required
                aria-label="Waking update type"
                value={report}
                onChange={(event) => {
                  setReport(event.target.value as WakingReportKind);
                  setEdited(true);
                  setNotice("");
                }}
              >
                <option value="">Choose an update</option>
                {Object.entries(wakingReportLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {report === "main_wake" && (
              <p className="dynamic-field-hint">
                This explicitly starts a new main waking period. Waking after a nap belongs to the
                existing day.
              </p>
            )}
            <DailyTimeField
              label="When this update applies"
              draft={time}
              disabled={busy}
              onChange={(value) => {
                setTime(value);
                setEdited(true);
              }}
            />
            {report === "sleep_plan" && (
              <DailyTimeField
                label="Expected start of main sleep"
                draft={sleep}
                disabled={busy}
                allowNow={false}
                onChange={(value) => {
                  setSleep(value);
                  setEdited(true);
                }}
              />
            )}
            <label className="dynamic-field">
              <span>
                Details <small>Optional</small>
              </span>
              <textarea
                rows={2}
                maxLength={800}
                aria-label="Waking update details"
                value={summary}
                onChange={(event) => {
                  setSummary(event.target.value);
                  setEdited(true);
                }}
              />
            </label>
            <label className="daily-checkbox">
              <input
                type="checkbox"
                checked={historical}
                onChange={(event) => {
                  setHistorical(event.target.checked);
                  setEdited(true);
                }}
              />
              <span>Save as a historical report</span>
            </label>
            {historical && (
              <label className="dynamic-field">
                <span>Assign to a waking day</span>
                <select
                  aria-label="Historical waking day"
                  value={historyDay}
                  onChange={(event) => {
                    setHistoryDay(event.target.value);
                    setEdited(true);
                  }}
                >
                  <option value="">Leave unassigned</option>
                  {days
                    .filter((day) => !day.mergedIntoDayId)
                    .map((day) => (
                      <option key={day.id} value={day.id}>
                        {wakingDayLabel(day)}
                      </option>
                    ))}
                </select>
                <small>Historical reports do not announce that you have just woken up.</small>
              </label>
            )}
          </fieldset>
          {conflict && (
            <div className="notice dynamic-conflict" role="status">
              <p>
                The current waking day changed while this form was open. Your draft is kept; review
                the current state before applying it.
              </p>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setBase({ id: currentDay?.id ?? null, version: currentDay?.version ?? null });
                  setError("");
                }}
              >
                Use the current waking day for this update
              </button>
            </div>
          )}
          <div className="dynamic-actions dynamic-save">
            <button
              type="submit"
              className="button button--primary"
              disabled={busy || !report || conflict}
            >
              {busy ? "Saving…" : "Save waking update"}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                if (!edited || window.confirm("Discard this unsaved waking update?")) {
                  reset();
                  setError("");
                }
              }}
            >
              Discard waking update
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
