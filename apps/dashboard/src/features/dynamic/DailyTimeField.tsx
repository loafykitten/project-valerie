import type { ReportedTime } from "@valerie/core";
import type { Api } from "../../app/api";

export type TimeDraft = {
  mode: "now" | "local" | "unknown";
  localDateTime: string;
  timezone: string;
  occurrence?: "first" | "second";
};

export type ResolvedTime = {
  at: string;
  timezone: string;
  localDateTime: string;
  offset: string;
  adjustment: "none" | "gap_forward" | "overlap_first" | "overlap_second";
};

export function newTimeDraft(timezone: string, mode: TimeDraft["mode"] = "now"): TimeDraft {
  return { mode, localDateTime: "", timezone };
}

export function timeDraftFromReported(time: ReportedTime): TimeDraft {
  if (!time.at) return newTimeDraft(time.timezone, "unknown");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: time.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(time.at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    mode: "local",
    timezone: time.timezone,
    localDateTime: `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`,
  };
}

export async function resolveTimeDraft(
  api: Api,
  draft: TimeDraft,
): Promise<{ time: ReportedTime; notice: string }> {
  if (draft.mode === "unknown")
    return { time: { at: null, timezone: draft.timezone, basis: "unknown" }, notice: "" };
  if (draft.mode === "local" && !draft.localDateTime)
    throw new Error("Choose a date and time, or mark the timing unknown.");
  const resolved = await api<ResolvedTime>("/dynamic/daily/resolve-time", {
    method: "POST",
    body: JSON.stringify({
      mode: draft.mode,
      timezone: draft.timezone,
      ...(draft.mode === "local" ? { localDateTime: draft.localDateTime } : {}),
      ...(draft.mode === "local" && draft.occurrence ? { occurrence: draft.occurrence } : {}),
    }),
  });
  const notice =
    resolved.adjustment === "gap_forward"
      ? `That clock time fell in a daylight-saving gap. It was saved as ${resolved.localDateTime.replace("T", " ")} ${resolved.offset}.`
      : resolved.adjustment === "overlap_first"
        ? `That clock time occurred twice. The first occurrence was used (${resolved.offset}).`
        : resolved.adjustment === "overlap_second"
          ? `That clock time occurred twice. The second occurrence was used (${resolved.offset}).`
          : "";
  return {
    time: {
      at: resolved.at,
      timezone: resolved.timezone,
      basis: draft.mode === "now" ? "message_time" : "exact",
      ...(draft.mode === "local" ? { originalLocalIntent: draft.localDateTime } : {}),
    },
    notice,
  };
}

export function DailyTimeField({
  label,
  draft,
  onChange,
  disabled,
  allowNow = true,
  allowUnknown = true,
  unknownLabel = "Timing unknown",
}: {
  label: string;
  draft: TimeDraft;
  onChange: (draft: TimeDraft) => void;
  disabled: boolean;
  allowNow?: boolean;
  allowUnknown?: boolean;
  unknownLabel?: string;
}) {
  return (
    <div className="daily-time-field">
      <label className="dynamic-field">
        <span>{label}</span>
        <select
          aria-label={label}
          disabled={disabled}
          value={draft.mode}
          onChange={(event) =>
            onChange({ ...draft, mode: event.target.value as TimeDraft["mode"] })
          }
        >
          {allowNow && <option value="now">Now</option>}
          <option value="local">Choose a date and time</option>
          {allowUnknown && <option value="unknown">{unknownLabel}</option>}
        </select>
      </label>
      {draft.mode === "local" && (
        <div className="daily-time-field">
          <label className="dynamic-field">
            <span>
              Date and time <small>{draft.timezone}</small>
            </span>
            <input
              type="datetime-local"
              step={60}
              required
              disabled={disabled}
              aria-label={`${label}: date and time`}
              value={draft.localDateTime}
              onChange={(event) => onChange({ ...draft, localDateTime: event.target.value })}
            />
            <small>
              Uses the saved timezone. Daylight-saving gaps move to the first valid time; repeated
              times use the first occurrence.
            </small>
          </label>
          <details className="daily-time-overlap">
            <summary>Repeated clock times</summary>
            <select
              aria-label={`${label}: repeated clock time`}
              disabled={disabled}
              value={draft.occurrence ?? "first"}
              onChange={(event) =>
                onChange({ ...draft, occurrence: event.target.value as "first" | "second" })
              }
            >
              <option value="first">If this time repeats, use the first occurrence</option>
              <option value="second">If this time repeats, use the second occurrence</option>
            </select>
          </details>
        </div>
      )}
    </div>
  );
}
