import { describe, expect, test } from "bun:test";
import type {
  HabitMetricCounts,
  OccurrenceStatus,
  Reminder,
  ScheduledOccurrence,
} from "@valerie/core";
import {
  coverageLabel,
  habitCadenceLabel,
  habitOutcomeLabels,
  habitOutcomeTone,
  ruleConditionLabels,
  rulePhaseLabels,
} from "./agreement-presentation";
import {
  canRetryReminder,
  occurrencePresentation,
  reminderPresentation,
} from "./reminder-presentation";

const reminder: Reminder = {
  id: "fictional-reminder",
  version: 1,
  state: "active",
  title: "Bring the sketchbook",
  purpose: "Have it ready for the outing.",
  dueAt: "2026-09-15T20:00:00Z",
  timezone: "America/Chicago",
  originalTimeIntent: "3 p.m. Central",
  expiresAt: null,
  allowFallback: true,
  currentOccurrenceId: "current-occurrence",
  sources: [],
  stateSources: [],
  authoredBy: "owner",
  createdAt: "2026-09-15T18:00:00Z",
  updatedAt: "2026-09-15T18:00:00Z",
};
function occurrence(
  status: OccurrenceStatus,
  patch: Partial<ScheduledOccurrence> = {},
): ScheduledOccurrence {
  return {
    id: "current-occurrence",
    kind: "explicit_reminder",
    reminderId: reminder.id,
    reminderVersion: 1,
    chatId: null,
    inputWatermark: 0,
    dueAt: reminder.dueAt,
    earliestAt: reminder.dueAt,
    expiresAt: null,
    status,
    title: reminder.title,
    purpose: reminder.purpose,
    timezone: reminder.timezone,
    allowFallback: true,
    checkin: null,
    fence: null,
    leaseOwner: null,
    snapshot: null,
    result: null,
    text: null,
    usedFallback: false,
    attempts: 0,
    nextAttemptAt: null,
    telegramMessageId: null,
    deliveredAt: null,
    reason: null,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
    ...patch,
  };
}
const counts: HabitMetricCounts = {
  opportunities: 7,
  applicable: 4,
  reported: 2,
  coverage: 0.5,
  outcomes: {
    done: 1,
    smaller_done: 0,
    partial: 1,
    skipped: 0,
    excused: 0,
    not_reported: 2,
    uncertain: 0,
    not_applicable: 3,
  },
};

describe("Agreement evidence presentation", () => {
  test("coverage uses established applicable opportunities instead of calendar padding", () => {
    expect(coverageLabel(counts)).toBe("2 of 4 applicable opportunities reported");
    expect(coverageLabel({ ...counts, applicable: 0, reported: 0 })).toBe(
      "No applicable opportunities in this range",
    );
  });
  test("smaller, partial, excused and missing reports remain distinct", () => {
    expect(habitOutcomeLabels.smaller_done).toBe("Smaller version done");
    expect(habitOutcomeLabels.partial).toBe("Partial");
    expect(habitOutcomeLabels.excused).toBe("Excused");
    expect(habitOutcomeLabels.not_reported).toBe("Not reported");
    expect(habitOutcomeTone("not_reported")).toBe("neutral");
  });
  test("selected weekdays are named without silently changing cadence", () => {
    expect(habitCadenceLabel({ kind: "weekdays", weekdays: [1, 5] })).toBe("Monday, Friday");
    expect(habitCadenceLabel({ kind: "every_waking_day" })).toBe("Each waking day");
  });
  test("expired and out-of-window conditions are not presented as missing compliance", () => {
    expect(rulePhaseLabels.expired).toBe("Expired");
    expect(rulePhaseLabels.outside_window).toBe("Outside agreed hours");
    expect(ruleConditionLabels.not_applicable).toBe("Not currently applicable");
    expect(ruleConditionLabels.uncertain).toBe("Needs clarification");
  });
});
describe("Reminder delivery presentation", () => {
  test("confirmed delivery does not mean the task was completed", () => {
    expect(reminderPresentation(reminder, occurrence("sent")).label).toBe(
      "Delivered · awaiting completion",
    );
    expect(
      reminderPresentation({ ...reminder, state: "completed" }, occurrence("sent")).label,
    ).toBe("Completed");
  });
  test("a prepared message is not a delivery receipt", () => {
    expect(occurrencePresentation("prepared").label).toBe("Ready to send");
    expect(reminderPresentation(reminder, undefined).label).toBe("Delivery status unavailable");
  });
  test("unknown delivery is never offered an automatic or manual retry button", () => {
    expect(canRetryReminder(reminder, occurrence("unknown"))).toBe(false);
    expect(reminderPresentation(reminder, occurrence("unknown")).label).toBe("Delivery uncertain");
  });
  test("retry is limited to the current explicit definitively failed occurrence", () => {
    expect(canRetryReminder(reminder, occurrence("failed"))).toBe(true);
    expect(canRetryReminder(reminder, occurrence("failed", { id: "old-occurrence" }))).toBe(false);
    expect(canRetryReminder(reminder, occurrence("failed", { kind: "checkin" }))).toBe(false);
    expect(canRetryReminder({ ...reminder, state: "cancelled" }, occurrence("failed"))).toBe(false);
  });
});
