import type { OccurrenceStatus, Reminder, ScheduledOccurrence } from "@valerie/core";

export function occurrencePresentation(status: OccurrenceStatus): {
  label: string;
  tone: "neutral" | "accent" | "warning";
} {
  const labels: Record<OccurrenceStatus, string> = {
    scheduled: "Scheduled",
    generating: "Preparing a message",
    prepared: "Ready to send",
    sending: "Sending",
    retry: "Retry scheduled",
    sent: "Delivered",
    silent: "Quiet this time",
    suppressed: "No longer needed",
    failed: "Delivery failed",
    unknown: "Delivery uncertain",
    cancelled: "Cancelled",
    expired: "Expired",
  };
  return {
    label: labels[status],
    tone:
      status === "unknown" || status === "failed"
        ? "warning"
        : status === "sent"
          ? "accent"
          : "neutral",
  };
}
export function reminderPresentation(
  reminder: Reminder,
  occurrence: ScheduledOccurrence | undefined,
): { label: string; tone: "neutral" | "accent" | "warning" } {
  if (reminder.state === "completed") return { label: "Completed", tone: "accent" };
  if (reminder.state === "cancelled") return { label: "Cancelled", tone: "neutral" };
  if (reminder.state === "expired") return { label: "Expired", tone: "neutral" };
  if (!occurrence) return { label: "Delivery status unavailable", tone: "neutral" };
  if (occurrence.status === "sent")
    return { label: "Delivered · awaiting completion", tone: "accent" };
  return occurrencePresentation(occurrence.status);
}
export function canRetryReminder(
  reminder: Reminder,
  occurrence: ScheduledOccurrence | undefined,
): boolean {
  return (
    reminder.state === "active" &&
    occurrence?.kind === "explicit_reminder" &&
    occurrence?.id === reminder.currentOccurrenceId &&
    occurrence.status === "failed"
  );
}
