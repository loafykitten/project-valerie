import { describe, expect, test } from "bun:test";
import type { BehaviorProgress, DailyEvent, ProgressBehavior, WakingDay } from "@valerie/core";
import { timeDraftFromReported } from "./DailyTimeField";
import {
  eventBasis,
  eventLabel,
  progressPresentation,
  timeBasis,
  wakingDayLabel,
  wakingReportLabels,
} from "./daily-presentation";

const behavior: ProgressBehavior = {
  id: "fictional-music",
  version: 1,
  name: "Music practice",
  unit: "minutes",
  valueKind: "count",
  aggregation: "count",
  state: "active",
  sources: [],
  createdAt: "2026-09-15T18:00:00Z",
  updatedAt: "2026-09-15T18:00:00Z",
};
const progress: BehaviorProgress = {
  behaviorId: behavior.id,
  wakingDayId: "fictional-day",
  value: 12,
  status: null,
  basis: "reported_total",
  asOf: "2026-09-15T18:00:00Z",
  reportedTotal: 12,
  eventIds: ["total"],
  unresolvedEventIds: [],
};
const event: DailyEvent = {
  id: "fictional-report",
  version: 1,
  state: "active",
  wakingDayId: "fictional-day",
  evidenceKind: "owner_report",
  occurred: { at: "2026-09-15T18:00:00Z", timezone: "America/Chicago", basis: "exact" },
  recordedAt: "2026-09-15T18:01:00Z",
  updatedAt: "2026-09-15T18:01:00Z",
  authoredBy: "owner",
  sources: [],
  revisionSources: [],
  summary: "I may play later.",
  stateApplied: false,
  inputWatermark: null,
  payload: {
    kind: "progress",
    behaviorId: behavior.id,
    behaviorVersion: 1,
    mode: "plan",
    value: 12,
  },
};

describe("Daily Details presentation", () => {
  test("a stated day boundary does not claim waking from sleep", () => {
    expect(wakingReportLabels.day_start).toBe("Starting my waking day");
    expect(wakingReportLabels.main_wake).toBe("Woke from main sleep");
    expect(eventLabel({ ...event, payload: { kind: "waking", report: "day_start" } })).toBe(
      "Starting my waking day",
    );
    const day: WakingDay = {
      id: "fictional-day",
      version: 1,
      current: true,
      startReport: "day_start",
      wakeTime: event.occurred,
      wakeEventId: event.id,
      wakeReceivedAt: event.recordedAt,
      morningEligible: true,
      state: "awake_reported",
      stateEventId: event.id,
      expectedSleepAt: null,
      sleepEstimateBasis: "none",
      sleepPlanEventId: null,
      inputWatermark: null,
      mergedIntoDayId: null,
      closedReason: null,
      createdAt: event.recordedAt,
      updatedAt: event.updatedAt,
    };
    expect(wakingDayLabel(day)).toMatch(/^Day began /u);
  });
  test("absence of a report does not become zero or a missed habit", () => {
    expect(progressPresentation(undefined, behavior).value).toBe("Not reported");
    expect(
      progressPresentation(
        { ...progress, value: null, reportedTotal: null, basis: "not_reported" },
        behavior,
      ).value,
    ).toBe("Not reported");
  });
  test("an explicitly reported zero remains a supported result", () => {
    expect(progressPresentation({ ...progress, value: 0, reportedTotal: 0 }, behavior).value).toBe(
      "0 minutes",
    );
  });
  test("unresolved timing exposes uncertainty rather than an invented exact total", () => {
    const display = progressPresentation(
      { ...progress, value: null, basis: "uncertain", unresolvedEventIds: ["unknown-time"] },
      behavior,
    );
    expect(display.value).toBe("Uncertain");
    expect(display.detail).toContain("Last reported total: 12 minutes");
  });
  test("all reported status choices remain distinct", () => {
    const labels = ["done", "partial", "skipped", "excused"].map(
      (status) =>
        progressPresentation(
          {
            ...progress,
            value: null,
            status: status as "done" | "partial" | "skipped" | "excused",
            basis: "status_report",
          },
          behavior,
        ).value,
    );
    expect(labels).toEqual(["Done", "Partial", "Deliberately skipped", "Excused"]);
  });
  test("plans and interpretations are labelled as noncompletion evidence", () => {
    expect(eventBasis(event)).toBe("Intention only");
    expect(eventLabel(event)).toBe("Plan");
    expect(
      eventBasis({
        ...event,
        evidenceKind: "valerie_interpretation",
        payload: {
          ...event.payload,
          kind: "progress",
          behaviorId: behavior.id,
          behaviorVersion: 1,
          mode: "interpretation",
        },
      }),
    ).toContain("does not count as completion");
  });
  test("message receipt time and unknown occurrence time remain different", () => {
    expect(timeBasis({ ...event.occurred, basis: "message_time" })).toBe("Time of the report");
    expect(timeBasis({ ...event.occurred, at: null, basis: "unknown" })).toBe(
      "Time not established",
    );
  });
  test("editing formats owner local time independently of the browser timezone", () => {
    expect(
      timeDraftFromReported({
        at: "2026-09-16T04:15:42.000Z",
        timezone: "America/Chicago",
        basis: "exact",
      }).localDateTime,
    ).toBe("2026-09-15T23:15");
    expect(
      timeDraftFromReported({ at: null, timezone: "America/Chicago", basis: "unknown" }).mode,
    ).toBe("unknown");
  });
});
