import { describe, expect, test } from "bun:test";
import {
  heartbeatReason,
  heartbeatRunPresentation,
  heartbeatStatusPresentation,
  heartbeatTime,
} from "./presentation";
import { type HeartbeatState, heartbeatDraft, heartbeatDraftChanged } from "./types";

const state: HeartbeatState = {
  settings: {
    version: 1,
    enabled: true,
    timezone: "America/Chicago",
    activeStart: "12:00",
    activeEnd: "12:00",
    minIntervalMinutes: 180,
    maxIntervalMinutes: 360,
    minIdleMinutes: 60,
    maxPerDay: 2,
    maxUnanswered: 2,
    maxMessageChars: 480,
    paused: false,
    pausedUntil: null,
    updatedAt: "2026-09-15T18:00:00.000Z",
  },
  status: {
    enabled: true,
    paused: false,
    activeNow: true,
    wakingDay: "2026-09-15",
    nextOpportunityAt: "2026-09-15T21:00:00.000Z",
    latestOwnerInputAt: "2026-09-15T18:00:00.000Z",
    deliveredToday: 0,
    unansweredCount: 0,
    unknownToday: 0,
    sendingToday: 0,
    blockingReason: null,
    activeRunId: null,
  },
  runtime: { state: "waiting", lastError: null, lastTickAt: "2026-09-15T20:00:00.000Z" },
  recentRuns: [],
};

describe("heartbeat status presentation", () => {
  test("saved enablement never implies a stopped or failed worker is available", () => {
    expect(heartbeatStatusPresentation(state).title).toBe("On");
    for (const runtimeState of ["stopped", "failed", "starting"])
      expect(
        heartbeatStatusPresentation({
          ...state,
          runtime: { ...state.runtime, state: runtimeState },
        }).title,
      ).toBe("Unavailable");
    expect(
      heartbeatStatusPresentation({
        ...state,
        status: { ...state.status, paused: true },
        settings: { ...state.settings, paused: true },
      }).title,
    ).toBe("Paused");
    expect(
      heartbeatStatusPresentation({
        ...state,
        status: { ...state.status, blockingReason: "unanswered_limit" },
      }).description,
    ).toContain("without a reply");
  });

  test("silence, suppression, failure, uncertainty, and confirmed delivery remain distinct", () => {
    const labels = ["silent", "suppressed", "failed", "unknown", "delivered"].map(
      (status) => heartbeatRunPresentation(status).label,
    );
    expect(new Set(labels).size).toBe(5);
    expect(heartbeatRunPresentation("unknown").description).toContain(
      "not be resent automatically",
    );
    expect(heartbeatRunPresentation("sending").label).toBe("Sending");
    expect(heartbeatReason("provider-body-fictional-secret")).not.toContain("fictional-secret");
  });

  test("owner timezone controls displayed opportunity times, with invalid times kept unreadable", () => {
    expect(heartbeatTime("2026-09-15T21:00:00.000Z", "America/Chicago")).toContain("4:00");
    expect(heartbeatTime("2026-09-15T21:00:00.000Z", "America/New_York")).toContain("5:00");
    expect(heartbeatTime(null, "America/Chicago")).toBe("Not scheduled");
    expect(heartbeatTime("private-invalid-input", "America/Chicago")).toBe("Time unavailable");
  });

  test("pause and status refreshes do not appear as unsaved form edits", () => {
    const draft = heartbeatDraft(state.settings);
    expect(
      heartbeatDraftChanged(draft, {
        ...state.settings,
        version: 2,
        paused: true,
        pausedUntil: null,
      }),
    ).toBe(false);
    expect(heartbeatDraftChanged({ ...draft, maxPerDay: 1 }, state.settings)).toBe(true);
    expect(heartbeatDraftChanged({ ...draft, activeEnd: "04:00" }, state.settings)).toBe(true);
  });
});
