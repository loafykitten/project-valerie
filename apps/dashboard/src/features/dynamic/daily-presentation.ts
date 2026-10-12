import type {
  BehaviorProgress,
  DailyEvent,
  ProgressBehavior,
  ProgressMode,
  ProgressStatus,
  ReportedTime,
  WakingDay,
  WakingReportKind,
  WakingState,
} from "@valerie/core";

export const wakingLabels: Record<WakingState, string> = {
  awake_reported: "Reported awake",
  main_sleep_intended: "Planning main sleep",
  nap_intended: "Planning a nap",
  unknown: "Timing unknown",
};

export const wakingReportLabels: Record<WakingReportKind, string> = {
  day_start: "Starting my waking day",
  main_wake: "Woke from main sleep",
  awake_update: "Still awake",
  main_sleep_intent: "Planning main sleep",
  nap_intent: "Planning a nap",
  nap_wake: "Awake after a nap",
  sleep_plan: "Sleep plan updated",
  uncertain: "Timing uncertain",
};

export const progressStatusLabels: Record<ProgressStatus, string> = {
  done: "Done",
  partial: "Partial",
  skipped: "Deliberately skipped",
  excused: "Excused",
};

const progressModeLabels: Record<ProgressMode, string> = {
  occurrence: "Occurrence",
  total_so_far: "Reported total",
  status: "Status report",
  plan: "Plan",
  interpretation: "Interpretation",
};

export function dailyTime(at: string | null, timezone = "America/Chicago"): string {
  if (!at) return "Timing unknown";
  const value = new Date(at);
  if (Number.isNaN(value.getTime())) return "Timing unknown";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

export function timeBasis(time: ReportedTime): string {
  if (!time.at || time.basis === "unknown") return "Time not established";
  if (time.basis === "message_time") return "Time of the report";
  if (time.basis === "relative") return "Resolved from a relative time";
  return "Reported event time";
}

export function wakingDayLabel(day: WakingDay): string {
  return day.wakeTime.at
    ? `Day began ${dailyTime(day.wakeTime.at, day.wakeTime.timezone)}`
    : `Start unknown · recorded ${dailyTime(day.createdAt, day.wakeTime.timezone)}`;
}

export function progressPresentation(
  progress: BehaviorProgress | undefined,
  behavior: ProgressBehavior,
): { value: string; detail: string; tone: "neutral" | "accent" | "warning" } {
  if (!progress || progress.basis === "not_reported")
    return {
      value: "Not reported",
      detail: "No qualifying report for this waking day.",
      tone: "neutral",
    };
  if (progress.basis === "uncertain" || progress.basis === "conflicting")
    return {
      value: progress.basis === "uncertain" ? "Uncertain" : "Conflicting reports",
      detail:
        progress.reportedTotal === null
          ? "Check the linked reports before treating this as a settled result."
          : `Last reported total: ${progress.reportedTotal.toLocaleString()} ${behavior.unit}. Some reports still need clarification.`,
      tone: "warning",
    };
  if (progress.status !== null)
    return {
      value: progressStatusLabels[progress.status],
      detail: "Reported status for this waking day.",
      tone: progress.status === "done" ? "accent" : "neutral",
    };
  if (progress.value === null)
    return {
      value: "Unknown",
      detail: "There is not enough information for a settled count.",
      tone: "neutral",
    };
  return {
    value: `${progress.value.toLocaleString()} ${behavior.unit}`,
    detail:
      progress.basis === "reported_total_plus_occurrences"
        ? "Reported total plus distinct later occurrences."
        : progress.basis === "reported_total"
          ? "Your reported total; earlier occurrences are included."
          : "Distinct reported occurrences.",
    tone: "neutral",
  };
}

export function eventLabel(event: DailyEvent): string {
  if (event.payload.kind === "waking") return wakingReportLabels[event.payload.report];
  if (event.payload.kind === "day_merge") return "Duplicate waking day merged";
  if (event.payload.mode === "status" && event.payload.status)
    return progressStatusLabels[event.payload.status];
  return progressModeLabels[event.payload.mode];
}

export function eventBasis(event: DailyEvent): string {
  if (event.payload.kind === "progress" && event.payload.mode === "plan") return "Intention only";
  if (
    event.evidenceKind === "valerie_interpretation" ||
    (event.payload.kind === "progress" && event.payload.mode === "interpretation")
  )
    return "Interpretation; does not count as completion";
  return event.evidenceKind === "integration_observation"
    ? "Observed by an integration"
    : "Owner report";
}

export function dailyWriteMessage(reason: string | undefined): string {
  const messages: Record<string, string> = {
    waking_day_not_established:
      "There is no current waking day yet. Start one with a clear main-waking update, or save this as history.",
    new_main_period_not_established:
      "This does not yet establish a new main waking period. Keep it as an awake update if it is the same day.",
    historical_time_requires_history_or_correction:
      "This time is earlier than the current waking update. Save it as history or correct the earlier report.",
    sources_refer_to_different_events:
      "The sources describe different reports. Review them separately before changing the record.",
    historical_or_stale_source:
      "The source is historical or a newer update has arrived. Review the current day before applying this report.",
    transport_provenance_uncertain:
      "The message does not establish whether the statement is the owner's own current update.",
    waking_evidence_quote_required:
      "The waking update needs a clear statement from the original message.",
    quoted_or_unavailable_evidence:
      "The source is quoted or unavailable and cannot establish a current waking update.",
  };
  return reason && messages[reason]
    ? messages[reason]
    : "This report needs a little more detail before it can change the saved records.";
}
