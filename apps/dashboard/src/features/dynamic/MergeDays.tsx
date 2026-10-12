import type { DailyWriteResult, WakingDay } from "@valerie/core";
import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { dailyWriteMessage, wakingDayLabel } from "./daily-presentation";

export function MergeDays({
  api,
  days,
  onRefresh,
  onDirtyChange,
}: {
  api: Api;
  days: WakingDay[];
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [from, setFrom] = useState<WakingDay | null>(null);
  const [into, setInto] = useState<WakingDay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => onDirtyChange(Boolean(from || into || busy)), [from, into, busy, onDirtyChange]);
  const available = days.filter((day) => !day.mergedIntoDayId);
  const stale =
    (from && days.find((day) => day.id === from.id)?.version !== from.version) ||
    (into && days.find((day) => day.id === into.id)?.version !== into.version);
  async function merge() {
    if (!from || !into || from.id === into.id || stale || busy) return;
    if (
      !window.confirm(
        "Merge these as one waking day? The reports and original day history are retained.",
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<DailyWriteResult>("/dynamic/daily/days/merge", {
        method: "POST",
        body: JSON.stringify({
          fromId: from.id,
          expectedFromVersion: from.version,
          intoId: into.id,
          expectedIntoVersion: into.version,
        }),
      });
      if (result.effect === "needs_clarification") {
        setError(dailyWriteMessage(result.reason));
        return;
      }
      setFrom(null);
      setInto(null);
      setNotice("Duplicate day merged. Original reports and revisions are retained.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      onRefresh();
    }
  }
  if (available.length < 2 && !from && !into) return null;
  return (
    <details className="daily-merge">
      <summary>Correct duplicate waking days</summary>
      <p className="dynamic-field-hint">
        Use this only when two records describe the same waking period. This moves their reports
        into one day while retaining the history.
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
          void merge();
        }}
      >
        <div className="daily-report-filters">
          <label className="dynamic-field">
            <span>Duplicate day</span>
            <select
              required
              disabled={busy}
              aria-label="Duplicate waking day"
              value={from?.id ?? ""}
              onChange={(event) =>
                setFrom(available.find((day) => day.id === event.target.value) ?? null)
              }
            >
              <option value="">Choose the duplicate</option>
              {available.map((day) => (
                <option key={day.id} value={day.id}>
                  {wakingDayLabel(day)}
                </option>
              ))}
            </select>
          </label>
          <label className="dynamic-field">
            <span>Keep this day</span>
            <select
              required
              disabled={busy}
              aria-label="Waking day to keep"
              value={into?.id ?? ""}
              onChange={(event) =>
                setInto(available.find((day) => day.id === event.target.value) ?? null)
              }
            >
              <option value="">Choose the day to keep</option>
              {available.map((day) => (
                <option key={day.id} value={day.id}>
                  {wakingDayLabel(day)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {stale && (
          <div className="notice dynamic-conflict" role="status">
            <p>A selected day changed. Review the current day records before merging.</p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setFrom(days.find((day) => day.id === from?.id) ?? null);
                setInto(days.find((day) => day.id === into?.id) ?? null);
              }}
            >
              Use the updated day records
            </button>
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--secondary"
            disabled={busy || !from || !into || from.id === into.id || Boolean(stale)}
          >
            {busy ? "Merging…" : "Merge duplicate day"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              setFrom(null);
              setInto(null);
              setError("");
            }}
          >
            Clear day selection
          </button>
        </div>
      </form>
    </details>
  );
}
