import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateCheckinWindow,
  createConversationService,
  createDailyService,
  createDynamicService,
  type DailyMutationContext,
  DynamicConflictError,
  DynamicPermissionError,
  openStore,
  type ProgressReportInput,
  type ReportedTime,
  type Store,
  type TelegramSourceMetadata,
  type WakingReportInput,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fictional record missing.");
  return value;
}
const owner: DailyMutationContext = { actor: "owner" };
const original: TelegramSourceMetadata = {
  version: 1,
  provenance: "original",
  quotedRanges: [],
  replyQuote: null,
  incomplete: false,
};
const reported = (
  at: string | null,
  basis: ReportedTime["basis"] = at ? "exact" : "unknown",
): ReportedTime => ({ at, timezone: "America/Chicago", basis });
function fixture(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  let clock = new Date("2026-09-15T17:00:00.000Z"),
    nextId = 0;
  const now = () => new Date(clock),
    daily = createDailyService(store, { now }),
    dynamic = createDynamicService(store, { now }),
    conversations = createConversationService(store, { now });
  const add = (
    text: string,
    options: { chatId?: string; senderId?: string; metadata?: TelegramSourceMetadata | null } = {},
  ) => {
    const updateId = ++nextId;
    conversations.acceptTelegramBatch({
      nextOffset: updateId + 1,
      inputs: [
        {
          updateId,
          messageId: String(updateId),
          chatId: options.chatId ?? "123",
          senderId: options.senderId ?? "123",
          text,
          receivedAt: now().toISOString(),
          sourceMetadata: options.metadata === undefined ? original : options.metadata,
        },
      ],
    });
    const row = store.db
      .query<{ id: string; turnId: string }, [number]>(
        "SELECT id,turn_id AS turnId FROM core_telegram_inputs WHERE update_id=?",
      )
      .get(updateId);
    if (!row) throw new Error("Fictional source missing.");
    return { ...row, sourceId: `conversation:${row.id}`, text, at: now().toISOString() };
  };
  const model = (source: ReturnType<typeof add>, key = source.id): DailyMutationContext => ({
    actor: "valerie",
    turnId: source.turnId,
    operationKey: key,
    permissions: { manageWaking: true, manageProgress: true },
  });
  const delegate = () =>
    daily.saveSettings({
      expectedVersion: daily.getSettings().version,
      allowValerieManageWaking: true,
      allowValerieManageProgress: true,
    });
  const wake = (
    source: ReturnType<typeof add>,
    partial: Partial<WakingReportInput> = {},
    key = source.id,
  ) => {
    const current = daily.currentDay();
    return daily.recordWakingReport(
      {
        report: "main_wake",
        expectedCurrentDayId: current?.id ?? null,
        expectedDayVersion: current?.version ?? null,
        mode: "current",
        occurred: reported(source.at, "message_time"),
        summary: source.text,
        sourceIds: [source.sourceId],
        evidenceQuote: source.text,
        ...partial,
      },
      model(source, key),
    );
  };
  const ownerWake = () =>
    required(
      daily.recordWakingReport(
        {
          report: "main_wake",
          expectedCurrentDayId: daily.currentDay()?.id ?? null,
          expectedDayVersion: daily.currentDay()?.version ?? null,
          mode: "current",
          occurred: reported(now().toISOString()),
          summary: "Owner reported the main wake.",
          newMainPeriod: true,
        },
        owner,
      ).day,
    );
  return {
    store,
    conversations,
    daily,
    dynamic,
    add,
    model,
    delegate,
    wake,
    ownerWake,
    now,
    setTime: (value: string) => {
      clock = new Date(value);
    },
  };
}

test("daily scopes start off, preserve focus scopes, and old-tab saves cannot revoke them", () => {
  const f = fixture();
  expect(f.daily.overview()).toMatchObject({
    currentDay: null,
    days: [],
    behaviors: [],
    events: [],
    progress: [],
    windows: [],
  });
  const source = f.add("Good morning.");
  expect(() => f.wake(source)).toThrow(DynamicPermissionError);
  const settings = f.delegate();
  expect(settings.allowValerieManageWaking).toBe(true);
  expect(() =>
    f.daily.recordWakingReport(
      {
        report: "main_wake",
        mode: "current",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        occurred: reported(source.at),
        summary: source.text,
        sourceIds: [source.sourceId],
        evidenceQuote: source.text,
      },
      { ...f.model(source), permissions: { manageWaking: false, manageProgress: true } },
    ),
  ).toThrow(DynamicPermissionError);
  f.dynamic.saveSettings({
    expectedVersion: settings.version,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  expect(f.daily.getSettings()).toMatchObject({
    allowValerieManageWaking: true,
    allowValerieManageProgress: true,
  });
  expect(() =>
    f.daily.saveSettings({
      expectedVersion: settings.version,
      allowValerieManageWaking: false,
      allowValerieManageProgress: false,
    }),
  ).toThrow(DynamicConflictError);
  f.daily.saveSettings({
    expectedVersion: f.daily.getSettings().version,
    allowValerieManageWaking: false,
    allowValerieManageProgress: true,
  });
  expect(() => f.wake(source)).toThrow(DynamicPermissionError);
});

test("repeated configuration under different operation keys reuses an identical active subject", () => {
  const f = fixture();
  f.delegate();
  const source = f.add("Please track my meal reports.");
  const input = {
    name: "Meal Reports",
    unit: "meals",
    valueKind: "count" as const,
    sourceIds: [source.sourceId],
  };
  const first = f.daily.saveBehavior(input, f.model(source, "configure-first"));
  const repeated = f.daily.saveBehavior(
    { ...input, name: " meal   reports ", unit: "MEALS" },
    f.model(source, "configure-again"),
  );
  expect(repeated).toEqual(first);
  expect(f.daily.listBehaviors()).toHaveLength(1);
  expect(
    f.store.db.query("SELECT count(*) AS count FROM core_progress_behavior_revisions").get(),
  ).toEqual({ count: 1 });
  f.daily.saveBehavior({ ...input, id: first.id, expectedVersion: 1, state: "archived" }, owner);
  const later = f.daily.saveBehavior(input, f.model(source, "new-after-archive"));
  expect(later.id).not.toBe(first.id);
  expect(f.daily.overview().behaviors).toHaveLength(2);
});

test("exact behavior reads respect current-turn source visibility and preserve owner reads", () => {
  const f = fixture();
  f.delegate();
  const earlier = f.add("Let us choose a tracking subject.");
  f.setTime("2026-09-15T17:01:00.000Z");
  const source = f.add("Please track reading in minutes.");
  const behavior = f.daily.saveBehavior(
    {
      name: "Reading",
      unit: "minutes",
      valueKind: "count",
      sourceIds: [source.sourceId],
    },
    f.model(source),
  );
  expect(f.daily.readBehavior(behavior.id)).toEqual(behavior);
  expect(f.daily.readBehavior(behavior.id, { turnId: source.turnId })).toEqual(behavior);
  expect(f.daily.readBehavior(behavior.id, { turnId: earlier.turnId })).toBeNull();
  const foreign = f.add("A different conversation.", { chatId: "999" });
  expect(f.daily.readBehavior(behavior.id, { turnId: foreign.turnId })).toBeNull();
  f.setTime("2026-09-15T17:02:00.000Z");
  const revisionSource = f.add("Please call it recreational reading.");
  const revised = f.daily.saveBehavior(
    {
      id: behavior.id,
      expectedVersion: behavior.version,
      name: "Recreational reading",
      unit: behavior.unit,
      valueKind: behavior.valueKind,
      sourceIds: [source.sourceId, revisionSource.sourceId],
    },
    f.model(revisionSource),
  );
  expect(f.daily.readBehavior(behavior.id, { turnId: source.turnId })).toBeNull();
  expect(f.daily.readBehavior(behavior.id, { turnId: revisionSource.turnId })).toEqual(revised);
  expect(f.daily.readBehavior(behavior.id)).toEqual(revised);
});

test("same-source/new-operation and repeated greetings preserve one waking day and morning identity", () => {
  const f = fixture();
  f.delegate();
  const first = f.add("Good morning!");
  const saved = f.wake(first);
  expect(saved.effect).toBe("created");
  const again = f.wake(first, {}, "another-operation");
  expect(again.effect).toBe("already_recorded");
  expect(again.event?.id).toBe(saved.event?.id);
  f.setTime("2026-09-15T17:05:00.000Z");
  const greeting = f.add("Good morning again!");
  expect(f.wake(greeting, { newMainPeriod: true }).effect).toBe("needs_clarification");
  expect(f.daily.listDays()).toHaveLength(1);
  const update = f.wake(greeting, {}, "greeting-update");
  expect(update.day?.id).toBe(saved.day?.id);
  expect(update.event?.payload).toMatchObject({ report: "awake_update" });
  expect(update.day?.wakeEventId).toBe(saved.event?.id);
  expect(
    calculateCheckinWindow(required(update.day), "morning", { now: f.now() })?.sourceEventId,
  ).toBe(saved.event?.id);
});

test("a genuine bare morning after an unreported bedtime can begin a new day, while a two-minute repeat cannot", () => {
  const f = fixture();
  f.delegate();
  const first = f.wake(f.add("Good morning."));
  f.setTime("2026-09-16T11:00:00.000Z");
  const next = f.wake(f.add("Good morning."), { newMainPeriod: true });
  expect(next.effect).toBe("created");
  expect(next.day?.id).not.toBe(first.day?.id);
  f.setTime("2026-09-16T11:02:00.000Z");
  const repeat = f.wake(f.add("Good morning again."), { newMainPeriod: true });
  expect(repeat.effect).toBe("needs_clarification");
  expect(f.daily.listDays()).toHaveLength(2);
});

test("a future-dated accepted source cannot authorize completed facts before server time", () => {
  const f = fixture();
  f.delegate();
  const day = f.ownerWake();
  const behavior = f.daily.saveBehavior(
    { name: "Fictional count", unit: "reports", valueKind: "count" },
    owner,
  );
  f.setTime("2026-09-16T17:00:00.000Z");
  const future = f.add("I completed two actions.");
  f.setTime("2026-09-15T17:00:00.000Z");
  const input = {
    behaviorId: behavior.id,
    wakingDayId: day.id,
    summary: future.text,
    occurred: reported(future.at),
    sourceIds: [future.sourceId],
    mode: "occurrence" as const,
    value: 2,
  };
  expect(() => f.daily.recordProgressReport(input, f.model(future))).toThrow("Future intentions");
  expect(() =>
    f.daily.recordProgressReport(
      { ...input, occurred: reported(null), mode: "total_so_far", totalThroughAt: future.at },
      f.model(future, "future-total"),
    ),
  ).toThrow("future time belongs to a plan");
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).basis).toBe("not_reported");
});

test("nap waking and midnight preserve a day; short explicit main sleep needs no recorded bedtime or wake keyword", () => {
  const f = fixture();
  f.delegate();
  const first = f.wake(f.add("I woke up for the day."));
  f.setTime("2026-09-15T18:00:00.000Z");
  expect(f.wake(f.add("I am taking a nap."), { report: "nap_intent" }).day?.state).toBe(
    "nap_intended",
  );
  f.setTime("2026-09-15T19:00:00.000Z");
  expect(f.wake(f.add("Back from my nap."), { report: "nap_wake" }).day?.id).toBe(first.day?.id);
  f.setTime("2026-09-16T07:00:00.000Z");
  expect(f.wake(f.add("I'm still awake."), { report: "awake_update" }).day?.id).toBe(first.day?.id);
  f.setTime("2026-09-16T09:00:00.000Z");
  const second = f.wake(f.add("Morning, finally out of bed. That short sleep was my main sleep."), {
    newMainPeriod: true,
  });
  expect(second.day?.id).not.toBe(first.day?.id);
  f.setTime("2026-09-16T11:00:00.000Z");
  const third = f.wake(
    f.add("I got another short main sleep and I'm beginning my next waking period."),
    { newMainPeriod: true },
  );
  expect(third.day?.id).not.toBe(second.day?.id);
  expect(f.daily.readDay(required(second.day).id)).toMatchObject({
    current: false,
    closedReason: "next_main_wake_reported",
  });
});

test("forwarded, quoted, unknown, stale and historical evidence cannot start current work; a normal quoted reply can", () => {
  const f = fixture();
  f.delegate();
  for (const metadata of [
    { ...original, provenance: "forwarded" as const },
    { ...original, quotedRanges: [{ offset: 0, length: 13 }] },
    { ...original, incomplete: true },
    null,
  ]) {
    const source = f.add("Good morning!", { metadata });
    expect(f.wake(source).effect).toBe("needs_clarification");
    expect(f.daily.currentDay()).toBeNull();
  }
  const stale = f.add("I woke for the day.");
  f.add("That sentence was a story quote.");
  expect(f.wake(stale).effect).toBe("needs_clarification");
  const historical = f.add("Yesterday I woke early.");
  expect(
    f.wake(historical, { mode: "history", occurred: reported("2026-09-14T13:00:00.000Z") }).event
      ?.stateApplied,
  ).toBe(false);
  expect(f.daily.currentDay()).toBeNull();
  const reply = f.add("Good morning!", {
    metadata: { ...original, replyQuote: { text: "When do you wake?" } },
  });
  expect(f.wake(reply).effect).toBe("created");
  expect(() =>
    f.store.db
      .query("UPDATE core_telegram_inputs SET source_metadata_json=NULL WHERE id=?")
      .run(reply.id),
  ).toThrow("immutable");
});

test("fresh delivery of an older waking time cannot rewind state; elapsed silence never proves sleep", () => {
  const f = fixture();
  f.delegate();
  const first = f.wake(f.add("I woke six hours ago."), {
    occurred: reported("2026-09-15T11:00:00.000Z"),
  });
  expect(first.day?.morningEligible).toBe(false);
  f.setTime("2026-09-15T18:00:00.000Z");
  const plan = f.wake(f.add("I plan to sleep at two a.m."), {
    report: "sleep_plan",
    expectedSleepAt: "2026-09-16T07:00:00.000Z",
    sleepEstimateBasis: "owner_plan",
  });
  expect(plan.day?.state).toBe("awake_reported");
  f.setTime("2026-09-15T19:00:00.000Z");
  const routine = f.wake(f.add("My usual bedtime is five."), {
    report: "sleep_plan",
    expectedSleepAt: "2026-09-16T10:00:00.000Z",
    sleepEstimateBasis: "usual_routine",
  });
  expect(routine.day?.expectedSleepAt).toBe(plan.day?.expectedSleepAt);
  const old = f.add("Earlier yesterday, I was going to bed.");
  expect(
    f.wake(old, { report: "main_sleep_intent", occurred: reported("2026-09-14T23:00:00.000Z") })
      .effect,
  ).toBe("needs_clarification");
  f.setTime("2026-09-16T08:00:00.000Z");
  expect(f.daily.currentDay()?.state).toBe("awake_reported");
  const staying = f.wake(f.add("I stayed up and am still awake."), { report: "awake_update" });
  expect(staying.day).toMatchObject({ expectedSleepAt: null, sleepEstimateBasis: "none" });
});

test("reported totals cover earlier and late-reported actions while source and same-event claims prevent duplicate counts", () => {
  const f = fixture();
  f.delegate();
  const day = f.ownerWake(),
    behavior = f.daily.saveBehavior(
      { name: "Shared meal reports", unit: "meals", valueKind: "count" },
      owner,
    );
  const record = (text: string, input: Partial<ProgressReportInput> = {}) => {
    const source = f.add(text);
    return {
      source,
      result: f.daily.recordProgressReport(
        {
          behaviorId: behavior.id,
          wakingDayId: day.id,
          occurred: reported(source.at),
          summary: text,
          mode: "occurrence",
          value: 1,
          sourceIds: [source.sourceId],
          ...input,
        },
        f.model(source),
      ),
    };
  };
  f.setTime("2026-09-15T18:00:00.000Z");
  const lunch = record("I finished lunch.");
  expect(
    f.daily.recordProgressReport(
      {
        behaviorId: behavior.id,
        wakingDayId: day.id,
        occurred: reported(lunch.source.at),
        summary: lunch.source.text,
        mode: "occurrence",
        value: 1,
        sourceIds: [lunch.source.sourceId],
      },
      f.model(lunch.source, "new-operation"),
    ).effect,
  ).toBe("already_recorded");
  f.setTime("2026-09-15T20:00:00.000Z");
  record("I've had two meals so far.", { mode: "total_so_far", value: 2 });
  expect(f.daily.readBehaviorProgress(behavior.id, day.id)).toMatchObject({
    value: 2,
    basis: "reported_total",
    reportedTotal: 2,
  });
  f.setTime("2026-09-15T21:00:00.000Z");
  record("I forgot to mention breakfast earlier.", {
    occurred: reported("2026-09-15T17:00:00.000Z"),
  });
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).value).toBe(2);
  f.setTime("2026-09-15T23:00:00.000Z");
  record("Dinner is finished.");
  expect(f.daily.readBehaviorProgress(behavior.id, day.id)).toMatchObject({
    value: 3,
    basis: "reported_total_plus_occurrences",
  });
  f.setTime("2026-09-16T00:00:00.000Z");
  record("That lunch was the soup I mentioned.", {
    sameEventId: required(lunch.result.event).id,
    expectedEventVersion: 1,
  });
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).value).toBe(3);
  record("I also had a meal, but I don't remember when.", { occurred: reported(null) });
  expect(f.daily.readBehaviorProgress(behavior.id, day.id)).toMatchObject({
    value: null,
    basis: "uncertain",
    reportedTotal: 2,
  });
});

test("plans and interpretations never count; status outcomes remain distinct and absence is not failure", () => {
  const f = fixture(),
    day = f.ownerWake(),
    count = f.daily.saveBehavior(
      { name: "Reported glasses", unit: "glasses", valueKind: "count" },
      owner,
    ),
    status = f.daily.saveBehavior(
      { name: "A chosen creative practice", unit: "report", valueKind: "status" },
      owner,
    );
  const input = {
    behaviorId: count.id,
    wakingDayId: day.id,
    occurred: reported(f.now().toISOString()),
    summary: "A fictional intention.",
  };
  f.daily.recordProgressReport(
    { ...input, mode: "plan", value: 2, plannedFor: "2026-09-15T23:00:00.000Z" },
    owner,
  );
  f.daily.recordProgressReport(
    { ...input, mode: "interpretation", summary: "A quieter setting might help." },
    owner,
  );
  expect(f.daily.readBehaviorProgress(count.id, day.id)).toMatchObject({
    value: null,
    basis: "not_reported",
  });
  for (const [index, state] of (["done", "partial", "skipped", "excused"] as const).entries()) {
    f.setTime(`2026-09-15T${18 + index}:00:00.000Z`);
    f.daily.recordProgressReport(
      {
        ...input,
        behaviorId: status.id,
        occurred: reported(f.now().toISOString()),
        mode: "status",
        status: state,
      },
      owner,
    );
    expect(f.daily.readBehaviorProgress(status.id, day.id).status).toBe(state);
  }
  expect(() =>
    f.daily.recordProgressReport(
      { ...input, occurred: reported("2026-09-16T17:00:00.000Z"), mode: "occurrence", value: 1 },
      owner,
    ),
  ).toThrow("Future intentions");
  expect(() =>
    f.daily.recordProgressReport(
      {
        ...input,
        mode: "occurrence",
        value: 1,
        evidenceKind: "integration_observation" as "owner_report",
      },
      owner,
    ),
  ).toThrow("registered observation adapters");
});

test("event correction and voiding preserve history; editing a voided report does not restore its count", () => {
  const f = fixture(),
    day = f.ownerWake(),
    behavior = f.daily.saveBehavior(
      { name: "Meal reports", unit: "meals", valueKind: "count" },
      owner,
    );
  const saved = required(
    f.daily.recordProgressReport(
      {
        behaviorId: behavior.id,
        wakingDayId: day.id,
        occurred: reported(f.now().toISOString()),
        summary: "Two meals reported.",
        mode: "occurrence",
        value: 2,
      },
      owner,
    ).event,
  );
  const corrected = required(
    f.daily.reviseEvent(
      {
        id: saved.id,
        expectedVersion: 1,
        progress: { mode: "occurrence", value: 1 },
        summary: "Correction: one meal.",
      },
      owner,
    ).event,
  );
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).value).toBe(1);
  expect(f.daily.readEvent(saved.id, { revision: 1 })?.summary).toBe(saved.summary);
  expect(() => f.daily.voidEvent({ id: saved.id, expectedVersion: 1 }, owner)).toThrow(
    DynamicConflictError,
  );
  const voided = f.daily.voidEvent({ id: saved.id, expectedVersion: corrected.version }, owner);
  expect(voided.event?.state).toBe("voided");
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).basis).toBe("not_reported");
  const edited = f.daily.reviseEvent(
    {
      id: saved.id,
      expectedVersion: required(voided.event).version,
      summary: "A corrected explanation for a withdrawn report.",
    },
    owner,
  );
  expect(edited.event?.state).toBe("voided");
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).basis).toBe("not_reported");
  expect(() =>
    f.store.db.query("DELETE FROM core_dynamic_events WHERE id=?").run(saved.id),
  ).toThrow("retained");
  expect(() =>
    f.store.db
      .query("UPDATE core_dynamic_event_revisions SET record_json='{}' WHERE event_id=?")
      .run(saved.id),
  ).toThrow("immutable");
});

test("owner reassignment and merging mistaken days retain sources and recompute one shared count", () => {
  const f = fixture(),
    first = f.ownerWake(),
    behavior = f.daily.saveBehavior(
      { name: "Meal reports", unit: "meals", valueKind: "count" },
      owner,
    );
  const saved = required(
    f.daily.recordProgressReport(
      {
        behaviorId: behavior.id,
        wakingDayId: first.id,
        occurred: reported(f.now().toISOString()),
        summary: "One meal reported.",
        mode: "occurrence",
        value: 1,
      },
      owner,
    ).event,
  );
  f.setTime("2026-09-16T17:00:00.000Z");
  const second = f.ownerWake();
  const moved = required(
    f.daily.reviseEvent({ id: saved.id, expectedVersion: 1, wakingDayId: second.id }, owner).event,
  );
  expect(moved.sources).toEqual(saved.sources);
  expect(f.daily.readBehaviorProgress(behavior.id, first.id).basis).toBe("not_reported");
  expect(f.daily.readBehaviorProgress(behavior.id, second.id).value).toBe(1);
  const currentFirst = required(f.daily.readDay(first.id));
  const merge = f.daily.mergeDays(
    {
      fromId: second.id,
      expectedFromVersion: second.version,
      intoId: first.id,
      expectedIntoVersion: currentFirst.version,
    },
    owner,
  );
  expect(merge.day).toMatchObject({ id: first.id, current: true, morningEligible: false });
  expect(f.daily.readEvent(saved.id)?.wakingDayId).toBe(first.id);
  expect(f.daily.readDay(second.id)?.mergedIntoDayId).toBe(first.id);
  expect(f.daily.readBehaviorProgress(behavior.id, first.id).value).toBe(1);
});

test("daily revision stays stable over time and changes for evidence, behavior and permission edits", () => {
  const f = fixture();
  const initial = f.daily.capture();
  f.setTime("2026-09-15T18:00:00.000Z");
  expect(f.daily.capture().revision).toBe(initial.revision);
  f.delegate();
  expect(f.daily.capture().revision).not.toBe(initial.revision);
  const day = f.ownerWake(),
    before = f.daily.capture().revision,
    behavior = f.daily.saveBehavior(
      { name: "Optional reported practice", unit: "report", valueKind: "status" },
      owner,
    );
  expect(f.daily.capture().revision).not.toBe(before);
  const event = required(
    f.daily.recordProgressReport(
      {
        behaviorId: behavior.id,
        wakingDayId: day.id,
        occurred: reported(f.now().toISOString()),
        summary: "A partial report.",
        mode: "status",
        status: "partial",
      },
      owner,
    ).event,
  );
  const saved = f.daily.capture().revision;
  f.daily.reviseEvent(
    { id: event.id, expectedVersion: 1, summary: "A corrected partial report." },
    owner,
  );
  expect(f.daily.capture().revision).not.toBe(saved);
  expect(f.daily.capture().content).toContain("Optional reported practice");
});

test("daily evidence cannot cross conversations or expose a later correction through duplicate-claim lookup", () => {
  const f = fixture();
  f.delegate();
  const day = f.ownerWake();
  const behavior = f.daily.saveBehavior(
    { name: "Fictional actions", unit: "actions", valueKind: "count" },
    owner,
  );
  const earlier = f.add("I completed one action.");
  const input = {
    behaviorId: behavior.id,
    wakingDayId: day.id,
    occurred: reported(earlier.at),
    summary: earlier.text,
    mode: "occurrence" as const,
    value: 1,
    sourceIds: [earlier.sourceId],
  };
  const saved = required(f.daily.recordProgressReport(input, f.model(earlier)).event);
  const foreign = f.add("A different chat's claim.", { chatId: "999" });
  const current = f.add("Correction: it was two actions.");
  expect(() =>
    f.daily.recordProgressReport(
      { ...input, sourceIds: [foreign.sourceId] },
      f.model(current, "wrong-chat"),
    ),
  ).toThrow("Use owner messages from this conversation");
  f.daily.reviseEvent(
    {
      id: saved.id,
      expectedVersion: 1,
      progress: { mode: "occurrence", value: 2 },
      summary: current.text,
      sourceIds: [current.sourceId],
    },
    f.model(current, "correct"),
  );
  expect(f.daily.readEvent(saved.id, { turnId: earlier.turnId })).toBeNull();
  expect(() => f.daily.recordProgressReport(input, f.model(earlier, "older-duplicate"))).toThrow(
    "revision unavailable to this turn",
  );
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).value).toBe(2);
});

test("daily operation receipts and source-claim dedupe survive reopening without another waking day", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-daily-persistence-"));
  directories.push(directory);
  const path = join(directory, "fictional.sqlite"),
    f = fixture(path);
  f.delegate();
  const source = f.add("Good morning."),
    saved = f.wake(source);
  const reopenedStore = openStore(path);
  stores.push(reopenedStore);
  const reopened = createDailyService(reopenedStore, { now: f.now });
  const input: WakingReportInput = {
    report: "main_wake",
    expectedCurrentDayId: null,
    expectedDayVersion: null,
    mode: "current",
    occurred: reported(source.at, "message_time"),
    summary: source.text,
    sourceIds: [source.sourceId],
    evidenceQuote: source.text,
  };
  expect(reopened.recordWakingReport(input, f.model(source))).toEqual(saved);
  expect(
    reopened.recordWakingReport(input, f.model(source, "new-operation-after-reopen")),
  ).toMatchObject({ effect: "already_recorded", event: { id: saved.event?.id } });
  expect(() =>
    reopened.recordWakingReport(
      { ...input, summary: "Changed content under a retained key." },
      f.model(source),
    ),
  ).toThrow("different edit");
  expect(reopened.listDays()).toHaveLength(1);
  expect(reopened.listEvents().items).toHaveLength(1);
  expect(reopened.capture().revision).toBe(f.daily.capture().revision);
});

test("owner overview includes an older reported subject beyond the first twenty while routine context stays bounded", () => {
  const f = fixture(),
    day = f.ownerWake();
  const oldest = f.daily.saveBehavior(
    { name: "Oldest tracked subject", unit: "report", valueKind: "status" },
    owner,
  );
  f.daily.recordProgressReport(
    {
      behaviorId: oldest.id,
      wakingDayId: day.id,
      occurred: reported(f.now().toISOString()),
      summary: "The owner reported this subject done.",
      mode: "status",
      status: "done",
    },
    owner,
  );
  for (let index = 1; index <= 20; index++)
    f.daily.saveBehavior(
      { name: `Later tracked subject ${index}`, unit: "report", valueKind: "status" },
      owner,
    );
  const overview = f.daily.overview();
  expect(overview.behaviors.filter((behavior) => behavior.state === "active")).toHaveLength(21);
  expect(overview.progress).toHaveLength(21);
  expect(overview.progress.find((item) => item.behaviorId === oldest.id)).toMatchObject({
    status: "done",
    basis: "status_report",
  });
  expect(f.daily.capture().progress).toHaveLength(8);
});

test("materially different same-source progress asks for correction and withdrawn claims stay withdrawn", () => {
  const f = fixture();
  f.delegate();
  const day = f.ownerWake();
  const behavior = f.daily.saveBehavior(
    { name: "Shared report count", unit: "actions", valueKind: "count" },
    owner,
  );
  const source = f.add("I completed one action.");
  const input: ProgressReportInput = {
    behaviorId: behavior.id,
    wakingDayId: day.id,
    occurred: reported(source.at),
    summary: source.text,
    mode: "occurrence",
    value: 1,
    sourceIds: [source.sourceId],
  };
  const saved = required(f.daily.recordProgressReport(input, f.model(source)).event);
  expect(
    f.daily.recordProgressReport({ ...input, value: 2 }, f.model(source, "different-value")),
  ).toMatchObject({
    effect: "needs_clarification",
    reason: "source_claim_requires_correction",
    event: { id: saved.id },
  });
  expect(
    f.daily.recordProgressReport({ ...input, wakingDayId: null }, f.model(source, "different-day")),
  ).toMatchObject({ effect: "needs_clarification", reason: "source_claim_requires_correction" });
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).value).toBe(1);
  f.daily.voidEvent({ id: saved.id, expectedVersion: saved.version }, owner);
  expect(f.daily.recordProgressReport(input, f.model(source, "withdrawn-repeat"))).toMatchObject({
    effect: "needs_clarification",
    reason: "source_claim_withdrawn",
    event: { state: "voided" },
  });
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).basis).toBe("not_reported");
  const plannedSource = f.add("I intend to do one action later.");
  const planned: ProgressReportInput = {
    ...input,
    summary: plannedSource.text,
    mode: "plan",
    sourceIds: [plannedSource.sourceId],
  };
  const plan = required(f.daily.recordProgressReport(planned, f.model(plannedSource)).event);
  expect(
    f.daily.recordProgressReport(
      { ...planned, mode: "occurrence" },
      f.model(plannedSource, "plan-is-not-completion"),
    ),
  ).toMatchObject({
    effect: "needs_clarification",
    reason: "source_claim_requires_correction",
    event: { id: plan.id, payload: { mode: "plan" } },
  });
  expect(f.daily.readBehaviorProgress(behavior.id, day.id).basis).toBe("not_reported");
  expect(
    f.store.db.query("SELECT count(*) AS count FROM core_dynamic_event_sources").get(),
  ).toEqual({ count: 2 });
});

test("different same-source waking reports ask for correction without advancing state or reviving withdrawals", () => {
  const f = fixture();
  f.delegate();
  const source = f.add("Good morning."),
    saved = f.wake(source);
  expect(f.wake(source, { report: "main_sleep_intent" }, "different-waking-claim")).toMatchObject({
    effect: "needs_clarification",
    reason: "source_claim_requires_correction",
  });
  expect(f.daily.currentDay()?.state).toBe("awake_reported");
  const event = required(saved.event);
  f.daily.voidEvent({ id: event.id, expectedVersion: event.version }, owner);
  expect(f.wake(source, {}, "withdrawn-wake-repeat")).toMatchObject({
    effect: "needs_clarification",
    reason: "source_claim_withdrawn",
    event: { state: "voided" },
  });
  expect(f.daily.currentDay()?.state).toBe("unknown");
  expect(f.daily.listDays()).toHaveLength(1);
  expect(
    f.store.db.query("SELECT count(*) AS count FROM core_dynamic_event_sources").get(),
  ).toEqual({ count: 1 });
});

test("a current album's earlier waking caption remains usable when its latest caption is empty", () => {
  const f = fixture();
  f.delegate();
  const common = {
    chatId: "123",
    senderId: "123",
    mediaGroupId: "fictional-album",
    receivedAt: f.now().toISOString(),
    sourceMetadata: original,
  };
  f.conversations.acceptTelegramBatch({
    nextOffset: 12,
    inputs: [
      {
        ...common,
        updateId: 10,
        messageId: "10",
        text: "Good morning.",
        images: [{ fileId: "fictional-a", fileUniqueId: "fictional-a" }],
      },
      {
        ...common,
        updateId: 11,
        messageId: "11",
        text: "",
        images: [{ fileId: "fictional-b", fileUniqueId: "fictional-b" }],
      },
    ],
  });
  const first = required(
    f.store.db
      .query<{ id: string; turnId: string; position: number }, [number]>(
        "SELECT id,turn_id AS turnId,rowid AS position FROM core_telegram_inputs WHERE update_id=?",
      )
      .get(10),
  );
  const latest = required(
    f.store.db
      .query<{ turnId: string; position: number }, [number]>(
        "SELECT turn_id AS turnId,rowid AS position FROM core_telegram_inputs WHERE update_id=?",
      )
      .get(11),
  );
  expect(first.turnId).toBe(latest.turnId);
  const source = {
    ...first,
    text: "Good morning.",
    at: f.now().toISOString(),
    sourceId: `conversation:${first.id}`,
  };
  const result = f.wake(source, { occurred: reported(null, "message_time") });
  expect(result).toMatchObject({
    effect: "created",
    event: { occurred: { at: source.at }, inputWatermark: latest.position },
    day: { inputWatermark: latest.position },
  });
  expect(
    f.store.db.query("SELECT source_ref AS source FROM core_dynamic_event_sources").all(),
  ).toEqual([{ source: source.sourceId }]);
});

test("two current wakes may cite the same older routine without claiming the routine as either wake", () => {
  const f = fixture();
  f.delegate();
  f.setTime("2026-09-14T17:00:00.000Z");
  const routine = f.add("My usual routine is sleeping late and waking around noon.");
  f.setTime("2026-09-15T17:00:00.000Z");
  const first = f.add("Good morning."),
    initial = f.wake(first, { sourceIds: [routine.sourceId, first.sourceId] });
  f.setTime("2026-09-16T11:00:00.000Z");
  const second = f.add("Good morning."),
    next = f.wake(second, { sourceIds: [routine.sourceId, second.sourceId], newMainPeriod: true });
  expect(next.effect).toBe("created");
  expect(next.day?.id).not.toBe(initial.day?.id);
  expect(initial.event?.sources.map((source) => source.id)).toContain(routine.sourceId);
  expect(next.event?.sources.map((source) => source.id)).toContain(routine.sourceId);
  expect(
    f.store.db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM core_dynamic_event_sources WHERE source_ref=?",
      )
      .get(routine.sourceId)?.count,
  ).toBe(0);
  expect(
    f.store.db.query("SELECT count(*) AS count FROM core_dynamic_event_sources").get(),
  ).toEqual({ count: 2 });
});

test("daily freshness follows accepted append order even when a later input has a lower transport update ID", () => {
  const f = fixture();
  f.delegate();
  f.conversations.acceptTelegramBatch({
    nextOffset: 100,
    inputs: [
      {
        updateId: 99,
        messageId: "99",
        chatId: "123",
        senderId: "123",
        text: "Good morning.",
        receivedAt: f.now().toISOString(),
        sourceMetadata: original,
      },
    ],
  });
  const row = required(
    f.store.db
      .query<{ id: string; turnId: string }, [number]>(
        "SELECT id,turn_id AS turnId FROM core_telegram_inputs WHERE update_id=?",
      )
      .get(99),
  );
  const high = {
    ...row,
    text: "Good morning.",
    at: f.now().toISOString(),
    sourceId: `conversation:${row.id}`,
  };
  const first = f.wake(high);
  expect(first.day?.inputWatermark).toBe(1);
  f.setTime("2026-09-16T11:00:00.000Z");
  const low = f.add("Good morning.");
  expect(f.wake(high, {}, "stale-high-update")).toMatchObject({
    effect: "needs_clarification",
    reason: "historical_or_stale_source",
  });
  const latest = f.wake(low, { newMainPeriod: true });
  expect(latest.effect).toBe("created");
  expect(latest.day?.inputWatermark).toBe(2);
  expect(latest.day?.id).not.toBe(first.day?.id);
});

test("day_start establishes a reported day boundary without a sleep claim or newMainPeriod flag", () => {
  const f = fixture();
  f.delegate();
  const firstSource = f.add("Good morning."),
    first = f.wake(firstSource, { report: "day_start" });
  expect(first).toMatchObject({
    effect: "created",
    event: { payload: { kind: "waking", report: "day_start" } },
    day: { state: "awake_reported", startReport: "day_start", morningEligible: true },
  });
  expect(f.wake(firstSource, { report: "day_start" }, "same-day-start-source").effect).toBe(
    "already_recorded",
  );
  f.setTime("2026-09-16T11:00:00.000Z");
  const next = f.wake(f.add("Good morning."), { report: "day_start" });
  expect(next.effect).toBe("created");
  expect(next.day?.id).not.toBe(first.day?.id);
  expect(f.daily.readDay(required(first.day).id)?.closedReason).toBe("next_day_start_reported");
  expect(f.daily.capture().currentDay?.startReport).toBe("day_start");
  expect(
    f.daily
      .listEvents()
      .items.map((event) => (event.payload.kind === "waking" ? event.payload.report : null)),
  ).toEqual(["day_start", "day_start"]);
  f.setTime("2026-09-16T11:02:00.000Z");
  const repeat = f.wake(f.add("Good morning again."), { report: "day_start" });
  expect(repeat.effect).toBe("needs_clarification");
  expect(f.daily.currentDay()?.id).toBe(next.day?.id);
  expect(f.daily.listDays()).toHaveLength(2);
});

test("day_start preserves continued-day and nap reports and protects a recent nap greeting", () => {
  const f = fixture();
  f.delegate();
  const start = f.wake(f.add("I'm starting my day."), { report: "day_start" });
  f.setTime("2026-09-16T07:00:00.000Z");
  const continuing = f.wake(f.add("I'm still awake and continuing this same day."), {
    report: "awake_update",
  });
  expect(continuing.day?.id).toBe(start.day?.id);
  f.setTime("2026-09-16T08:00:00.000Z");
  f.wake(f.add("I am taking a short nap."), { report: "nap_intent" });
  f.setTime("2026-09-16T08:15:00.000Z");
  const greeting = f.wake(f.add("Good morning."), { report: "day_start" });
  expect(greeting).toMatchObject({
    effect: "created",
    event: { payload: { report: "nap_wake" } },
    day: { id: required(start.day).id, state: "awake_reported" },
  });
  f.setTime("2026-09-16T09:00:00.000Z");
  f.wake(f.add("I'm taking another nap."), { report: "nap_intent" });
  f.setTime("2026-09-16T11:00:00.000Z");
  expect(f.wake(f.add("I'm back from my nap."), { report: "nap_wake" }).day?.id).toBe(
    start.day?.id,
  );
  expect(f.daily.listDays()).toHaveLength(1);
});
