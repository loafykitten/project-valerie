import { afterEach, expect, test } from "bun:test";
import type { Store } from "@valerie/core";
import { required, scheduledFixture } from "../reminders/test-fixture";
import { createDailyTools } from "./daily";
import { createToolRegistry } from "./registry";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(pinned = { manageProgress: true, manageHabits: true }) {
  const f = scheduledFixture();
  stores.push(f.store);
  f.daily.saveSettings({
    expectedVersion: f.daily.getSettings().version,
    allowValerieManageWaking: true,
    allowValerieManageProgress: true,
  });
  f.agreements.saveSettings({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageHabits: true,
    allowValerieManageRules: false,
  });
  const subject = f.daily.saveBehavior(
    { name: "Sketching", unit: "minutes", valueKind: "count" },
    { actor: "owner" },
  );
  const day = required(
    f.daily.recordWakingReport(
      {
        report: "day_start",
        mode: "current",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        occurred: { at: f.now().toISOString(), timezone: "America/Chicago", basis: "exact" },
        summary: "A fictional waking day.",
      },
      { actor: "owner" },
    ).day,
  );
  const habit = f.agreements.saveHabit(
    {
      name: "Sketching practice",
      reason: "Enjoy drawing.",
      behaviorId: subject.id,
      fullPractice: "Sketch for ten minutes.",
      smallerPractice: "Sketch for two minutes.",
      cadence: { kind: "every_waking_day" },
      slots: ["evening"],
      effectiveAt: f.now().toISOString(),
      threshold: 10,
    },
    { actor: "owner" },
  );
  const opportunity = required(
    f.agreements.opportunities(day.id).find((item) => item.habitId === habit.id),
  );
  f.advance(1000);
  const source = f.accept("I managed the smaller version, two minutes of sketching.");
  const args = {
    action: "report",
    behaviorId: subject.id,
    wakingDayId: day.id,
    mode: "occurrence",
    value: 2,
    summary: "The owner reports doing her smaller two-minute practice.",
    sourceIds: [source.sourceId],
    habitPractice: {
      habitId: habit.id,
      definitionVersion: opportunity.definitionVersion,
      variant: "smaller",
    },
  };
  const registry = createToolRegistry(
    f.store,
    createDailyTools(f.store, {
      now: f.now,
      extended: true,
      habitPractice: true,
      permissions: { manageWaking: false, manageProgress: pinned.manageProgress },
      agreementPermissions: { manageHabits: pinned.manageHabits, manageRules: false },
      offeredToolNames: [
        "daily_read",
        "daily_waking",
        "daily_progress",
        "agreement_write",
        "reminder_write",
      ],
    }),
  );
  const call = (input: Record<string, unknown> = args, operationKey = "combined-practice") =>
    registry.execute(
      { id: operationKey, name: "daily_progress", arguments: JSON.stringify(input) },
      { turnId: source.turnId, operationKey, signal: new AbortController().signal },
      () => {},
    );
  const reports = () =>
    f.daily
      .listEvents({ dayId: day.id })
      .items.filter((event) => event.payload.kind === "progress");
  const variants = () => f.store.db.query("SELECT id FROM core_habit_variants").all();
  return {
    ...f,
    subject,
    day,
    habit,
    opportunity,
    source,
    args,
    registry,
    call,
    reports,
    variants,
  };
}

test("one atomic report records two minutes and its smaller-practice tag with no extra count or duplicate on replay", async () => {
  const f = fixture(),
    first = await f.call();
  expect(first).toMatchObject({
    status: "succeeded",
    result: {
      schedulingAvailable: true,
      scheduledByThisAction: false,
      event: { payload: { mode: "occurrence", value: 2 } },
      practiceVariant: {
        habitId: f.habit.id,
        variant: "smaller",
        definitionVersion: f.opportunity.definitionVersion,
      },
    },
  });
  const result = first.result as {
    event: { id: string; version: number };
    practiceVariant: { eventId: string; eventVersion: number };
  };
  expect(result.practiceVariant.eventId).toBe(result.event.id);
  expect(result.practiceVariant.eventVersion).toBe(result.event.version);
  expect(f.reports()).toHaveLength(1);
  expect(f.variants()).toHaveLength(1);
  expect(f.daily.readBehaviorProgress(f.subject.id, f.day.id)).toMatchObject({ value: 2 });
  expect(f.agreements.opportunities(f.day.id)[0]?.outcome).toBe("smaller_done");
  expect(await f.call()).toEqual(first);
  expect(f.reports()).toHaveLength(1);
  expect(f.variants()).toHaveLength(1);
  expect(f.store.db.query("SELECT operation_key FROM core_dynamic_operations").all()).toHaveLength(
    2,
  );
});

test("a stale definition, invalid full tag, foreign habit or unsupported report rolls back the progress and operation receipts", async () => {
  for (const invalid of ["version", "full", "foreign", "plan", "unassigned"] as const) {
    const f = fixture();
    let habitId = f.habit.id;
    if (invalid === "foreign") {
      const foreign = f.accept("A different chat's practice.", { chatId: "999" });
      const other = f.agreements.saveHabit(
        {
          ...f.habit,
          id: undefined,
          expectedVersion: undefined,
          name: "Foreign practice",
          sourceIds: [foreign.sourceId],
        },
        { actor: "owner" },
      );
      habitId = other.id;
    }
    const result = await f.call({
      ...f.args,
      ...(invalid === "plan" ? { mode: "plan" } : {}),
      ...(invalid === "unassigned" ? { wakingDayId: undefined } : {}),
      habitPractice: {
        ...f.args.habitPractice,
        habitId,
        ...(invalid === "version" ? { definitionVersion: 999 } : {}),
        ...(invalid === "full" ? { variant: "full" } : {}),
      },
    });
    expect(result.status).toBe("rejected");
    expect(f.reports()).toHaveLength(0);
    expect(f.daily.listEvents({ dayId: null }).items).toHaveLength(0);
    expect(f.variants()).toHaveLength(0);
    expect(
      f.store.db.query("SELECT operation_key FROM core_dynamic_operations").all(),
    ).toHaveLength(0);
    if (invalid !== "foreign") expect((await f.call()).status).toBe("succeeded");
  }
});

test("both pinned and live progress/habit scopes are required, including an idempotent replay", async () => {
  for (const scope of ["manageProgress", "manageHabits"] as const) {
    const f = fixture({ manageProgress: true, manageHabits: true, [scope]: false });
    expect(await f.call()).toMatchObject({ status: "rejected", code: "permission_denied" });
    expect(f.reports()).toHaveLength(0);
    expect(f.variants()).toHaveLength(0);
    const live = fixture();
    if (scope === "manageHabits")
      live.agreements.saveSettings({
        expectedVersion: live.agreements.getSettings().version,
        allowValerieManageHabits: false,
        allowValerieManageRules: false,
      });
    else
      live.daily.saveSettings({
        expectedVersion: live.daily.getSettings().version,
        allowValerieManageWaking: true,
        allowValerieManageProgress: false,
      });
    expect(await live.call()).toMatchObject({ status: "rejected", code: "permission_denied" });
    expect(live.reports()).toHaveLength(0);
    const replay = fixture();
    expect((await replay.call()).status).toBe("succeeded");
    if (scope === "manageHabits")
      replay.agreements.saveSettings({
        expectedVersion: replay.agreements.getSettings().version,
        allowValerieManageHabits: false,
        allowValerieManageRules: false,
      });
    else
      replay.daily.saveSettings({
        expectedVersion: replay.daily.getSettings().version,
        allowValerieManageWaking: true,
        allowValerieManageProgress: false,
      });
    expect(await replay.call()).toMatchObject({ status: "rejected", code: "permission_denied" });
    expect(replay.reports()).toHaveLength(1);
    expect(replay.variants()).toHaveLength(1);
  }
});

test("classification is explicit and report-only; numeric status mistakes receive repair guidance without a write", async () => {
  const f = fixture();
  expect(
    await f.call({ ...f.args, action: "correct", id: "not-an-event", expectedVersion: 1 }),
  ).toMatchObject({ status: "rejected", field: "action" });
  expect(await f.call({ ...f.args, status: "done" })).toMatchObject({
    status: "rejected",
    field: "status",
    reason: "wrong_report_mode",
  });
  expect(f.reports()).toHaveLength(0);
  const withoutTag = { ...f.args, habitPractice: undefined };
  expect(await f.call(withoutTag)).toMatchObject({ status: "succeeded" });
  expect(f.variants()).toHaveLength(0);
  expect(f.agreements.opportunities(f.day.id)[0]?.outcome).toBe("partial");
});
