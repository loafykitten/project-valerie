import { expect, test } from "bun:test";
import {
  calculateCheckinWindow,
  createDailyService,
  dailyInstant,
  openStore,
  resolveDailyLocalTime,
  resolveDailyRelativeTime,
} from "../src";

test("local sleep plans resolve DST gaps forward and choose a declared repeated occurrence", () => {
  expect(resolveDailyLocalTime("2026-03-08T02:30", "America/Chicago")).toMatchObject({
    at: "2026-03-08T08:00:00.000Z",
    localDateTime: "2026-03-08T03:00",
    offsetMinutes: -300,
    adjustment: "gap_forward",
  });
  expect(resolveDailyLocalTime("2026-11-01T01:30", "America/Chicago")).toMatchObject({
    at: "2026-11-01T06:30:00.000Z",
    offsetMinutes: -300,
    adjustment: "repeated",
    occurrence: "first",
  });
  expect(resolveDailyLocalTime("2026-11-01T01:30", "America/Chicago", "second")).toMatchObject({
    at: "2026-11-01T07:30:00.000Z",
    offsetMinutes: -360,
    occurrence: "second",
  });
  expect(() => resolveDailyLocalTime("2026-02-30T10:00", "America/Chicago")).toThrow();
  expect(() => resolveDailyLocalTime("2026-09-15T10:00", "Not/AZone")).toThrow();
  expect(() => dailyInstant("2026-02-30T10:00:00-06:00")).toThrow();
  expect(() => dailyInstant("2026-09-15T24:00:00Z")).toThrow();
  expect(dailyInstant("2026-09-15T10:00:00-05:00")).toBe("2026-09-15T15:00:00.000Z");
});
test("relative offsets use elapsed duration across DST and calculated windows never dispatch", () => {
  expect(resolveDailyRelativeTime("2026-03-08T07:30:00.000Z", 120, "America/Chicago").at).toBe(
    "2026-03-08T09:30:00.000Z",
  );
  const store = openStore(":memory:");
  try {
    const now = () => new Date("2026-09-15T17:00:00.000Z"),
      daily = createDailyService(store, { now });
    const result = daily.recordWakingReport(
      {
        report: "main_wake",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        mode: "current",
        occurred: { at: now().toISOString(), timezone: "America/Chicago", basis: "message_time" },
        summary: "A main waking update.",
        expectedSleepAt: "2026-09-16T09:00:00.000Z",
        sleepEstimateBasis: "owner_plan",
      },
      { actor: "owner" },
    );
    const day = result.day;
    if (!day) throw new Error("Fictional waking day missing.");
    expect(calculateCheckinWindow(day, "morning", { now: now() })).toMatchObject({
      earliestAt: "2026-09-15T17:30:00.000Z",
      preferredAt: "2026-09-15T17:30:00.000Z",
      expiresAt: "2026-09-15T21:00:00.000Z",
    });
    expect(calculateCheckinWindow(day, "evening", { now: now() })).toMatchObject({
      earliestAt: "2026-09-16T05:00:00.000Z",
      preferredAt: "2026-09-16T07:00:00.000Z",
      expiresAt: "2026-09-16T09:00:00.000Z",
    });
    expect(
      calculateCheckinWindow(day, "morning", { now: new Date("2026-09-16T17:00:00.000Z") }),
    ).toBeNull();
    expect(store.db.query("SELECT count(*) AS count FROM core_conversation_outbox").get()).toEqual({
      count: 0,
    });
    expect(daily.listEvents().items).toHaveLength(1);
  } finally {
    store.close();
  }
});
