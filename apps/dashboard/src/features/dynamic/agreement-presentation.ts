import type {
  HabitCadence,
  HabitMetricCounts,
  HabitOutcome,
  RulePhase,
  RuleView,
} from "@valerie/core";

export const weekdayLabels = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
export const habitOutcomeLabels: Record<HabitOutcome, string> = {
  done: "Done",
  smaller_done: "Smaller version done",
  partial: "Partial",
  skipped: "Deliberately skipped",
  excused: "Excused",
  not_reported: "Not reported",
  uncertain: "Uncertain",
  not_applicable: "Not applicable",
};
export function habitCadenceLabel(cadence: HabitCadence): string {
  return cadence.kind === "every_waking_day"
    ? "Each waking day"
    : cadence.weekdays
        .map((day) => weekdayLabels[day])
        .filter(Boolean)
        .join(", ");
}
export function habitOutcomeTone(outcome: HabitOutcome): "neutral" | "accent" | "warning" {
  return outcome === "uncertain"
    ? "warning"
    : outcome === "done" || outcome === "smaller_done"
      ? "accent"
      : "neutral";
}
export function coverageLabel(counts: HabitMetricCounts): string {
  return counts.applicable === 0
    ? "No applicable opportunities in this range"
    : `${counts.reported.toLocaleString()} of ${counts.applicable.toLocaleString()} applicable opportunities reported`;
}
export const rulePhaseLabels: Record<RulePhase, string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
  scheduled: "Starts later",
  expired: "Expired",
  outside_window: "Outside agreed hours",
};
export const ruleConditionLabels: Record<RuleView["conditionResult"], string> = {
  met: "Reported condition met",
  not_met: "Reported condition not met",
  not_reported: "No report yet",
  uncertain: "Needs clarification",
  not_applicable: "Not currently applicable",
  not_configured: "Conversation agreement",
};
