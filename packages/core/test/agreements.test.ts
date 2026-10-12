import { afterEach, expect, test } from "bun:test";
import {
  type AgreementMutationContext,
  createAgreementService,
  createConversationService,
  createDailyService,
  createDynamicService,
  DynamicConflictError,
  DynamicPermissionError,
  type HabitSaveInput,
  openStore,
  type RuleSaveInput,
  type Store,
} from "../src";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const owner: AgreementMutationContext = { actor: "owner" };
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Fictional record missing.");
  return value;
}
function fixture() {
  const store = openStore(":memory:");
  stores.push(store);
  let clock = new Date("2026-09-15T17:00:00.000Z"),
    next = 0;
  const now = () => new Date(clock),
    agreements = createAgreementService(store, { now }),
    daily = createDailyService(store, { now }),
    dynamic = createDynamicService(store, { now }),
    conversations = createConversationService(store, { now });
  const day = (at: string | null = now().toISOString()) =>
    required(
      daily.recordWakingReport(
        {
          report: "day_start",
          mode: "current",
          expectedCurrentDayId: daily.currentDay()?.id ?? null,
          expectedDayVersion: daily.currentDay()?.version ?? null,
          occurred: { at, timezone: "America/Chicago", basis: at ? "message_time" : "unknown" },
          summary: "Owner started a new waking day.",
        },
        { actor: "owner" },
      ).day,
    );
  const behavior = (name = "Fictional practice", valueKind: "count" | "status" = "status") =>
    daily.saveBehavior(
      { name, unit: valueKind === "count" ? "actions" : "report", valueKind },
      { actor: "owner" },
    );
  const habit = (behaviorId: string, extra: Partial<HabitSaveInput> = {}) =>
    agreements.saveHabit(
      {
        name: "Creative practice",
        reason: "Make time for something enjoyable.",
        behaviorId,
        fullPractice: "Spend a little time on the agreed creative practice.",
        smallerPractice: "Try the agreed two-minute version.",
        cadence: { kind: "every_waking_day" },
        slots: ["morning", "evening"],
        effectiveAt: now().toISOString(),
        threshold: null,
        ...extra,
      },
      owner,
    );
  const rule = (extra: Partial<RuleSaveInput> = {}) =>
    agreements.saveRule(
      {
        name: "Speak about feelings honestly",
        meaning:
          "Honest painful feelings and quotations are welcome; they are not insults or misconduct.",
        reason: "Keep difficult feelings safe to share.",
        scope: "Our conversations.",
        effectiveAt: now().toISOString(),
        expiresAt: null,
        timezone: "America/Chicago",
        window: null,
        exceptions: ["Honest emotional disclosure and uncertain humor remain welcome."],
        condition: null,
        ...extra,
      },
      owner,
    );
  const report = (
    behaviorId: string,
    wakingDayId: string,
    mode: "status" | "occurrence" | "total_so_far" | "plan" | "interpretation" = "status",
    value = 1,
    status: "done" | "partial" | "skipped" | "excused" = "done",
  ) =>
    required(
      daily.recordProgressReport(
        {
          behaviorId,
          wakingDayId,
          occurred: { at: now().toISOString(), timezone: "America/Chicago", basis: "message_time" },
          summary: "An explicit fictional owner report.",
          mode,
          ...(mode === "status" ? { status } : mode === "interpretation" ? {} : { value }),
        },
        { actor: "owner" },
      ).event,
    );
  const source = (text: string, chatId = "123") => {
    const updateId = ++next;
    conversations.acceptTelegramBatch({
      nextOffset: updateId + 1,
      inputs: [
        {
          updateId,
          messageId: String(updateId),
          chatId,
          senderId: "123",
          text,
          receivedAt: now().toISOString(),
        },
      ],
    });
    const row = required(
      store.db
        .query<{ id: string; turnId: string }, [number]>(
          "SELECT id,turn_id AS turnId FROM core_telegram_inputs WHERE update_id=?",
        )
        .get(updateId),
    );
    return { ...row, sourceId: `conversation:${row.id}` };
  };
  const model = (turnId: string, operationKey: string): AgreementMutationContext => ({
    actor: "valerie",
    turnId,
    operationKey,
    permissions: { manageHabits: true, manageRules: true },
  });
  return {
    store,
    agreements,
    daily,
    dynamic,
    now,
    day,
    behavior,
    habit,
    rule,
    report,
    source,
    model,
    setTime: (at: string) => {
      clock = new Date(at);
    },
  };
}

test("agreement scopes default off and preserve all existing flags across edits", () => {
  const f = fixture();
  expect(f.agreements.overview()).toMatchObject({ habits: [], rules: [], opportunities: [] });
  const source = f.source("Let's agree on a creative practice."),
    behavior = f.behavior();
  const input: HabitSaveInput = {
    name: "Agreed practice",
    reason: "Enjoy making things.",
    behaviorId: behavior.id,
    fullPractice: "Paint a tile.",
    smallerPractice: null,
    cadence: { kind: "every_waking_day" },
    slots: ["evening"],
    effectiveAt: f.now().toISOString(),
    threshold: null,
    sourceIds: [source.sourceId],
  };
  expect(() => f.agreements.saveHabit(input, f.model(source.turnId, "not-authorized"))).toThrow(
    DynamicPermissionError,
  );
  f.agreements.saveSettings({
    expectedVersion: 1,
    allowValerieManageHabits: true,
    allowValerieManageRules: true,
    allowValerieManageReminders: true,
  });
  expect(() =>
    f.agreements.saveHabit(input, {
      ...f.model(source.turnId, "old-turn"),
      permissions: { manageHabits: false, manageRules: true },
    }),
  ).toThrow(DynamicPermissionError);
  const saved = f.agreements.saveHabit(input, f.model(source.turnId, "authorized"));
  expect(saved.authoredBy).toBe("valerie");
  f.dynamic.saveSettings({
    expectedVersion: f.dynamic.getSettings().version,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  f.daily.saveSettings({
    expectedVersion: f.daily.getSettings().version,
    allowValerieManageWaking: true,
    allowValerieManageProgress: true,
  });
  expect(f.agreements.getSettings()).toMatchObject({
    allowValerieManageHabits: true,
    allowValerieManageRules: true,
    allowValerieManageReminders: true,
  });
  f.agreements.saveSettings({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageHabits: false,
    allowValerieManageRules: true,
  });
  expect(() => f.agreements.saveHabit(input, f.model(source.turnId, "authorized"))).toThrow(
    DynamicPermissionError,
  );
});

test("habit opportunities start with actual established days, pin definition meaning, and keep states separate", () => {
  const f = fixture(),
    behavior = f.behavior(),
    first = f.day(),
    habit = f.habit(behavior.id);
  const original = required(f.agreements.opportunities(first.id)[0]);
  expect(original).toMatchObject({
    definitionVersion: 1,
    outcome: "not_reported",
    applicable: true,
    reported: false,
  });
  expect(f.agreements.questions(first.id, "morning")).toHaveLength(1);
  f.setTime("2026-09-15T18:00:00.000Z");
  const edited = f.agreements.saveHabit(
    { ...habit, id: habit.id, expectedVersion: 1, fullPractice: "A different future practice." },
    owner,
  );
  expect(f.agreements.opportunities(first.id)[0]?.definition.fullPractice).toBe(habit.fullPractice);
  expect(f.agreements.opportunities(first.id)[0]?.definitionVersion).toBe(1);
  const paused = f.agreements.setState(
    { target: "habit", id: habit.id, expectedVersion: edited.version, state: "paused" },
    owner,
  );
  expect(paused.sources).toEqual(edited.sources);
  expect(paused.stateSources).not.toEqual(edited.stateSources);
  expect(f.agreements.questions(first.id, "evening")).toEqual([]);
  expect(f.agreements.opportunities(first.id)[0]?.outcome).toBe("not_applicable");
  f.agreements.setState(
    { target: "habit", id: habit.id, expectedVersion: paused.version, state: "active" },
    owner,
  );
  expect(f.agreements.opportunities(first.id)[0]?.outcome).toBe("not_reported");
  f.setTime("2026-09-16T17:00:00.000Z");
  const second = f.day();
  expect(f.agreements.opportunities(second.id)[0]?.definition.fullPractice).toBe(
    edited.fullPractice,
  );
  expect(f.agreements.metrics({ period: "day" }).counts).toMatchObject({
    opportunities: 2,
    reported: 0,
    coverage: 0,
  });
});

test("creating a habit creates no missed historical days and unknown weekday cadence remains uncertain", () => {
  const f = fixture();
  const old = f.day();
  f.setTime("2026-09-16T17:00:00.000Z");
  const current = f.day(),
    behavior = f.behavior(),
    habit = f.habit(behavior.id);
  expect(f.agreements.opportunities(old.id)).toEqual([]);
  expect(f.agreements.opportunities(current.id)).toHaveLength(1);
  expect(f.agreements.metrics({ dayLimit: 90 }).counts.opportunities).toBe(1);
  const weekdays = f.habit(behavior.id, {
    name: "Only Mondays",
    cadence: { kind: "weekdays", weekdays: [1] },
  });
  expect(
    f.agreements.opportunities(current.id).find((item) => item.habitId === weekdays.id)?.outcome,
  ).toBe("not_applicable");
  f.setTime("2026-09-17T17:00:00.000Z");
  const unknown = f.day(null);
  const result = f.agreements.opportunities(unknown.id);
  expect(result.find((item) => item.habitId === weekdays.id)).toMatchObject({
    applicable: null,
    outcome: "uncertain",
    localStartDate: null,
  });
  expect(result.find((item) => item.habitId === habit.id)?.applicable).toBe(true);
});

test("a count habit and rule consume one shared checkpoint without duplicate counts", () => {
  const f = fixture(),
    day = f.day(),
    behavior = f.behavior("Meal reports", "count"),
    habit = f.habit(behavior.id, { name: "Agreed meal practice", threshold: 2 });
  const rule = f.rule({
    name: "Agreed meal condition",
    condition: { behaviorId: behavior.id, comparison: "at_least", value: 2 },
  });
  f.report(behavior.id, day.id, "occurrence", 1);
  f.setTime("2026-09-15T19:00:00.000Z");
  f.report(behavior.id, day.id, "total_so_far", 2);
  const opportunity = required(
    f.agreements.opportunities(day.id).find((item) => item.habitId === habit.id),
  );
  expect(opportunity).toMatchObject({
    outcome: "done",
    reported: true,
    progress: { value: 2, basis: "reported_total" },
  });
  expect(f.agreements.rulesAt()[0]).toMatchObject({
    rule: { id: rule.id },
    conditionResult: "met",
    progress: { value: 2 },
  });
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).value).toBe(2);
  expect(f.agreements.questions(day.id, "evening")).toEqual([]);
  expect(
    f.store.db
      .query("SELECT count(*) AS count FROM core_dynamic_events WHERE kind='progress'")
      .get(),
  ).toEqual({ count: 2 });
});

test("full, smaller, partial, skipped and excused are sourced outcomes and mini tags add no counters", () => {
  const f = fixture(),
    day = f.day(),
    behavior = f.behavior(),
    habit = f.habit(behavior.id);
  const event = f.report(behavior.id, day.id, "status", 1, "partial"),
    opportunity = required(f.agreements.opportunities(day.id)[0]);
  expect(opportunity.outcome).toBe("partial");
  const tag = f.agreements.logVariant(
    {
      habitId: habit.id,
      wakingDayId: day.id,
      definitionVersion: opportunity.definitionVersion,
      eventId: event.id,
      expectedEventVersion: event.version,
      variant: "smaller",
    },
    owner,
  );
  expect(f.agreements.opportunities(day.id)[0]).toMatchObject({
    outcome: "smaller_done",
    variant: "smaller",
    variantRecordId: tag.id,
  });
  expect(
    f.daily.listEvents().items.filter((item) => item.payload.kind === "progress"),
  ).toHaveLength(1);
  expect(
    f.agreements.logVariant(
      {
        habitId: habit.id,
        wakingDayId: day.id,
        definitionVersion: opportunity.definitionVersion,
        eventId: event.id,
        expectedEventVersion: event.version,
        variant: "smaller",
      },
      owner,
    ).id,
  ).toBe(tag.id);
  f.agreements.voidVariant({ id: tag.id, expectedVersion: tag.version }, owner);
  expect(f.agreements.opportunities(day.id)[0]?.outcome).toBe("partial");
  for (const [index, status] of (["done", "skipped", "excused"] as const).entries()) {
    f.setTime(`2026-09-15T${18 + index}:00:00.000Z`);
    f.report(behavior.id, day.id, "status", 1, status);
    expect(f.agreements.opportunities(day.id)[0]?.outcome).toBe(status);
  }
});

test("plans, interpretations, zero counts and changed source meaning cannot silently become smaller completions", () => {
  const f = fixture(),
    day = f.day(),
    behavior = f.behavior("Counted practice", "count"),
    habit = f.habit(behavior.id, { threshold: 2 });
  const opportunity = required(f.agreements.opportunities(day.id)[0]);
  for (const mode of ["plan", "interpretation", "total_so_far"] as const) {
    const event = f.report(behavior.id, day.id, mode, 0);
    expect(() =>
      f.agreements.logVariant(
        {
          habitId: habit.id,
          wakingDayId: day.id,
          definitionVersion: 1,
          eventId: event.id,
          expectedEventVersion: 1,
          variant: "smaller",
        },
        owner,
      ),
    ).toThrow("actual positive");
  }
  f.setTime("2026-09-15T18:00:00.000Z");
  const event = f.report(behavior.id, day.id, "occurrence", 1);
  f.agreements.logVariant(
    {
      habitId: habit.id,
      wakingDayId: day.id,
      definitionVersion: opportunity.definitionVersion,
      eventId: event.id,
      expectedEventVersion: 1,
      variant: "smaller",
    },
    owner,
  );
  expect(f.agreements.opportunities(day.id)[0]?.outcome).toBe("smaller_done");
  f.daily.reviseEvent(
    { id: event.id, expectedVersion: 1, summary: "Corrected description of what occurred." },
    { actor: "owner" },
  );
  expect(f.agreements.opportunities(day.id)[0]?.outcome).toBe("uncertain");
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).value).toBe(1);
});

test("rule expiry, future starts, overnight weekday windows and pause are recomputed at read time", () => {
  const f = fixture();
  f.setTime("2026-09-14T17:00:00.000Z");
  const rule = f.rule({
    name: "Monday evening agreement",
    window: { start: "22:00", end: "02:00", weekdays: [1] },
    expiresAt: "2026-09-15T07:00:00.000Z",
  });
  expect(f.agreements.rulesAt("2026-09-15T04:00:00.000Z")).toHaveLength(1);
  expect(f.agreements.rulesAt("2026-09-15T06:59:59.000Z")).toHaveLength(1);
  expect(f.agreements.rulesAt("2026-09-15T07:00:00.000Z")).toEqual([]);
  expect(
    f.agreements.rulesAt("2026-09-15T08:00:00.000Z", { includeInactive: true })[0]?.phase,
  ).toBe("expired");
  f.setTime("2026-09-15T04:00:00.000Z");
  const before = f.agreements.capture().revision;
  f.setTime("2026-09-15T07:00:00.000Z");
  expect(f.agreements.capture().revision).not.toBe(before);
  const paused = f.agreements.setState(
    { target: "rule", id: rule.id, expectedVersion: 1, state: "paused" },
    owner,
  );
  expect(paused.sources).toEqual(rule.sources);
  expect(f.agreements.rulesAt()).toEqual([]);
  const future = f.rule({ name: "Future agreement", effectiveAt: "2026-09-16T17:00:00.000Z" });
  expect(
    f.agreements
      .rulesAt(f.now().toISOString(), { includeInactive: true })
      .find((item) => item.rule.id === future.id)?.phase,
  ).toBe("scheduled");
});

test("honest feelings can be reviewed as owner reports without an automatic violation or global score", () => {
  const f = fixture(),
    day = f.day(),
    rule = f.rule();
  const note = f.agreements.logRuleNote(
    {
      ruleId: rule.id,
      ruleVersion: rule.version,
      wakingDayId: day.id,
      summary:
        "The owner reported feeling discouraged; she was disclosing pain, not insulting herself.",
      kind: "owner_report",
      disposition: "understood",
      occurred: { at: f.now().toISOString(), timezone: "America/Chicago", basis: "message_time" },
    },
    owner,
  );
  expect(note).toMatchObject({ kind: "owner_report", disposition: "understood", ruleVersion: 1 });
  expect(f.agreements.ruleNotes(rule.id)).toEqual([note]);
  expect(f.agreements.rulesAt()[0]?.conditionResult).toBe("not_configured");
  expect(f.agreements.capture().content).toContain("not automatic violations");
  expect(f.daily.listEvents().items.filter((item) => item.payload.kind === "progress")).toEqual([]);
});

test("metrics use real opportunities and coverage, preserve overnight grouping, and do not fill missing calendar days", () => {
  const f = fixture(),
    day = f.day(),
    behavior = f.behavior(),
    habit = f.habit(behavior.id);
  f.report(behavior.id, day.id);
  f.setTime("2026-09-18T03:00:00.000Z");
  const next = f.day();
  f.agreements.opportunities(next.id);
  const metrics = f.agreements.metrics({ period: "day", habitId: habit.id });
  expect(metrics.counts).toMatchObject({
    opportunities: 2,
    applicable: 2,
    reported: 1,
    coverage: 0.5,
  });
  expect(metrics.periods.map((item) => item.key)).toEqual(["2026-09-17", "2026-09-15"]);
  expect(metrics.range.wakingDays).toBe(2);
  expect(f.agreements.metrics({ period: "week", habitId: habit.id }).periods).toHaveLength(1);
  expect(f.agreements.metrics({ period: "month", habitId: habit.id }).periods[0]?.key).toBe(
    "2026-09",
  );
});

test("stale definitions, source ownership and archive immutability reject edits without changing agreements", () => {
  const f = fixture(),
    behavior = f.behavior(),
    habit = f.habit(behavior.id),
    rule = f.rule();
  f.agreements.setState(
    { target: "habit", id: habit.id, expectedVersion: 1, state: "paused" },
    owner,
  );
  expect(() =>
    f.agreements.saveHabit({ ...habit, id: habit.id, expectedVersion: 1 }, owner),
  ).toThrow(DynamicConflictError);
  f.agreements.setState(
    { target: "rule", id: rule.id, expectedVersion: 1, state: "archived" },
    owner,
  );
  expect(() =>
    f.agreements.setState(
      { target: "rule", id: rule.id, expectedVersion: 2, state: "active" },
      owner,
    ),
  ).toThrow("unarchived");
  f.agreements.saveSettings({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageHabits: true,
    allowValerieManageRules: true,
  });
  const foreign = f.source("Another chat's agreement.", "999"),
    current = f.source("Our conversation.");
  expect(() =>
    f.agreements.saveRule(
      { ...rule, id: undefined, name: "Unsupported agreement", sourceIds: [foreign.sourceId] },
      f.model(current.turnId, "foreign"),
    ),
  ).toThrow("Use owner messages from this conversation");
  expect(() =>
    f.store.db.query("UPDATE core_rule_revisions SET record_json='{}' WHERE id=?").run(rule.id),
  ).toThrow("immutable");
});

test("a future habit creates no premature opportunity and an explicit earlier start takes effect", () => {
  const f = fixture(),
    day = f.day(),
    behavior = f.behavior();
  const future = f.habit(behavior.id, { effectiveAt: "2026-09-20T17:00:00.000Z" });
  expect(f.agreements.opportunities(day.id)).toEqual([]);
  f.setTime("2026-09-15T18:00:00.000Z");
  const updated = f.agreements.saveHabit(
    { ...future, id: future.id, expectedVersion: 1, effectiveAt: f.now().toISOString() },
    owner,
  );
  expect(f.agreements.opportunities(day.id)[0]).toMatchObject({
    definitionVersion: updated.version,
    applicable: true,
    outcome: "not_reported",
  });
});

test("merged duplicate days preserve a smaller-version report and count one habit opportunity", () => {
  const f = fixture(),
    first = f.day(),
    behavior = f.behavior(),
    habit = f.habit(behavior.id);
  f.setTime("2026-09-16T17:00:00.000Z");
  const duplicate = f.day(),
    opportunity = required(f.agreements.opportunities(duplicate.id)[0]);
  const event = f.report(behavior.id, duplicate.id, "status", 1, "partial");
  const tag = f.agreements.logVariant(
    {
      habitId: habit.id,
      wakingDayId: duplicate.id,
      definitionVersion: opportunity.definitionVersion,
      eventId: event.id,
      expectedEventVersion: 1,
      variant: "smaller",
    },
    owner,
  );
  const currentFirst = required(f.daily.readDay(first.id));
  f.daily.mergeDays(
    {
      fromId: duplicate.id,
      expectedFromVersion: duplicate.version,
      intoId: first.id,
      expectedIntoVersion: currentFirst.version,
    },
    { actor: "owner" },
  );
  const result = f.agreements.opportunities(first.id);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ outcome: "smaller_done", variantRecordId: tag.id });
  expect(f.agreements.metrics().counts).toMatchObject({ opportunities: 1, reported: 1 });
});

test("owner metric supplemental counts are not limited to the first fifty report rows", () => {
  const f = fixture(),
    day = f.day(),
    behavior = f.behavior();
  f.habit(behavior.id);
  for (let index = 0; index < 55; index++)
    f.daily.recordProgressReport(
      {
        behaviorId: behavior.id,
        wakingDayId: null,
        occurred: { at: null, timezone: "America/Chicago", basis: "unknown" },
        summary: "An unassigned fictional owner report.",
        mode: "status",
        status: "partial",
      },
      { actor: "owner" },
    );
  const metrics = f.agreements.metrics();
  expect(metrics.unassignedReports).toBe(55);
  expect(metrics.uncertainTimingReports).toBe(55);
  expect(f.agreements.opportunities(day.id)[0]?.outcome).toBe("not_reported");
});

test("rule windows use resolved DST boundaries rather than restarting or dropping inside a repeated hour", () => {
  const f = fixture();
  f.setTime("2026-10-31T17:00:00.000Z");
  const fall = f.rule({
    name: "Repeated-hour window",
    window: { start: "01:30", end: "02:30", weekdays: [0] },
  });
  expect(
    f.agreements.rulesAt("2026-11-01T06:29:59.000Z").some((view) => view.rule.id === fall.id),
  ).toBe(false);
  expect(
    f.agreements.rulesAt("2026-11-01T07:10:00.000Z").some((view) => view.rule.id === fall.id),
  ).toBe(true);
  expect(
    f.agreements.rulesAt("2026-11-01T08:30:00.000Z").some((view) => view.rule.id === fall.id),
  ).toBe(false);
  f.setTime("2026-03-07T17:00:00.000Z");
  const spring = f.rule({
    name: "Missing-hour window",
    window: { start: "02:30", end: "03:30", weekdays: [0] },
  });
  expect(
    f.agreements.rulesAt("2026-03-08T07:59:59.000Z").some((view) => view.rule.id === spring.id),
  ).toBe(false);
  expect(
    f.agreements.rulesAt("2026-03-08T08:00:00.000Z").some((view) => view.rule.id === spring.id),
  ).toBe(true);
  expect(
    f.agreements.rulesAt("2026-03-08T08:30:00.000Z").some((view) => view.rule.id === spring.id),
  ).toBe(false);
});

test("a review tied to an old rule revision cannot assert applicability after that revision was superseded", () => {
  const f = fixture(),
    day = f.day(),
    rule = f.rule();
  f.setTime("2026-09-15T18:00:00.000Z");
  f.agreements.setState(
    { target: "rule", id: rule.id, expectedVersion: 1, state: "paused" },
    owner,
  );
  f.setTime("2026-09-15T19:00:00.000Z");
  const input = {
    ruleId: rule.id,
    ruleVersion: 1,
    wakingDayId: day.id,
    summary: "Review of a reported feeling.",
    kind: "owner_report" as const,
    disposition: "understood" as const,
  };
  const late = f.agreements.logRuleNote(
    {
      ...input,
      occurred: { at: f.now().toISOString(), timezone: "America/Chicago", basis: "exact" },
    },
    owner,
  );
  expect(late.applicableAtReport).toBeNull();
  const earlier = f.agreements.logRuleNote(
    {
      ...input,
      occurred: { at: "2026-09-15T17:30:00.000Z", timezone: "America/Chicago", basis: "exact" },
    },
    owner,
  );
  expect(earlier.applicableAtReport).toBe(true);
});

test("a later model pause is not exposed through an older opportunity's pinned definition", () => {
  const f = fixture(),
    day = f.day(),
    behavior = f.behavior();
  f.agreements.saveSettings({
    expectedVersion: 1,
    allowValerieManageHabits: true,
    allowValerieManageRules: true,
  });
  const original = f.source("Let's agree on a simple creative practice.");
  const habit = f.agreements.saveHabit(
    {
      name: "Source-scoped practice",
      reason: "Enjoy creating.",
      behaviorId: behavior.id,
      fullPractice: "Paint for a little while.",
      smallerPractice: null,
      cadence: { kind: "every_waking_day" },
      slots: ["evening"],
      effectiveAt: f.now().toISOString(),
      threshold: null,
      sourceIds: [original.sourceId],
    },
    f.model(original.turnId, "create-scoped"),
  );
  const changed = f.source("Pause that practice for now.");
  f.agreements.setState(
    {
      target: "habit",
      id: habit.id,
      expectedVersion: 1,
      state: "paused",
      sourceIds: [changed.sourceId],
    },
    f.model(changed.turnId, "pause-scoped"),
  );
  expect(f.agreements.opportunities(day.id, { turnId: original.turnId })).toEqual([]);
  expect(f.agreements.opportunities(day.id, { turnId: changed.turnId })[0]?.outcome).toBe(
    "not_applicable",
  );
});
