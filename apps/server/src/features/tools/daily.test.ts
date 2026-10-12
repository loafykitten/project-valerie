import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createDailyService,
  type DailyPermissions,
  openStore,
  type Store,
  type TelegramSourceMetadata,
} from "@valerie/core";
import { createDailyTools } from "./daily";
import { createToolRegistry } from "./registry";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const original: TelegramSourceMetadata = {
  version: 1,
  provenance: "original",
  quotedRanges: [],
  replyQuote: null,
  incomplete: false,
};
function fixture(permissions: DailyPermissions = { manageWaking: true, manageProgress: true }) {
  const store = openStore(":memory:");
  stores.push(store);
  const daily = createDailyService(store);
  daily.saveSettings({
    expectedVersion: daily.getSettings().version,
    allowValerieManageWaking: true,
    allowValerieManageProgress: true,
  });
  const conversations = createConversationService(store);
  let input = 0;
  let operation = 0;
  const source = (
    text: string,
    metadata: TelegramSourceMetadata | null = original,
    chatId = "42",
  ) => {
    input++;
    conversations.acceptTelegramBatch({
      nextOffset: input + 1,
      inputs: [
        {
          updateId: input,
          messageId: String(input),
          chatId,
          senderId: chatId,
          text,
          sourceMetadata: metadata,
          receivedAt: new Date(Date.now() - 1000 + input).toISOString(),
        },
      ],
    });
    const row = store.db
      .query<{ id: string; turnId: string; at: string }, [number]>(
        "SELECT id,turn_id AS turnId,received_at AS at FROM core_telegram_inputs WHERE update_id=?",
      )
      .get(input);
    if (!row) throw new Error("Missing fixture source.");
    return { ...row, sourceId: `conversation:${row.id}` };
  };
  const tools = createDailyTools(store, { permissions });
  const registry = createToolRegistry(store, tools);
  const call = (
    name: string,
    args: Record<string, unknown>,
    from: ReturnType<typeof source>,
    extra: Record<string, unknown> = {},
  ) =>
    registry.execute(
      { id: `call-${operation}`, name, arguments: JSON.stringify(args) },
      {
        turnId: from.turnId,
        operationKey: `op-${operation++}`,
        signal: new AbortController().signal,
        ...extra,
      },
      () => {},
    );
  return { store, daily, source, tools, registry, call };
}
const wake = (sourceId: string) => ({
  action: "report",
  report: "main_wake",
  summary: "The owner reports waking for her day.",
  evidenceQuote: "I woke up for the day.",
  sourceIds: [sourceId],
});

test("three daily capabilities fit the existing tool count and reserved schema allowance", () => {
  const f = fixture();
  expect(f.registry.schemas.map((item) => item.name)).toEqual([
    "daily_read",
    "daily_waking",
    "daily_progress",
  ]);
  expect(f.registry.schemas.length + 8 + 4 + 1).toBe(16);
  expect(Buffer.byteLength(JSON.stringify(f.registry.schemas)) + 512).toBeLessThanOrEqual(10240);
});

test("time without a local or relative request returns only the labeled server clock", async () => {
  const f = fixture(),
    source = f.source("What time is it?"),
    at = "2026-11-01T07:30:00.000Z";
  const registry = createToolRegistry(
    f.store,
    createDailyTools(f.store, { now: () => new Date(at) }),
  );
  const context = {
    turnId: source.turnId,
    operationKey: "clock",
    signal: new AbortController().signal,
  };
  const clock = await registry.execute(
    { id: "clock", name: "daily_read", arguments: '{"mode":"time","timezone":"America/Chicago"}' },
    context,
    () => {},
  );
  expect(clock).toMatchObject({
    status: "succeeded",
    result: {
      time: { at, timezone: "America/Chicago", basis: "exact", reference: "current_server_clock" },
    },
  });
  expect(f.daily.currentDay()).toBeNull();
  expect(f.daily.listEvents().items).toHaveLength(0);
  expect(f.store.db.query("SELECT id FROM core_reminders").all()).toHaveLength(0);
  const missingSource = await registry.execute(
    { id: "relative", name: "daily_read", arguments: '{"mode":"time","relativeMinutes":5}' },
    { ...context, operationKey: "relative" },
    () => {},
  );
  expect(missingSource).toMatchObject({
    status: "rejected",
    field: "sourceId",
    reason: "source_unavailable",
  });
  const invalidLocal = await registry.execute(
    { id: "local", name: "daily_read", arguments: '{"mode":"time","localDateTime":"2026-09-15"}' },
    { ...context, operationKey: "local" },
    () => {},
  );
  expect(invalidLocal).toMatchObject({ status: "rejected", code: "invalid_arguments" });
});

test("waking tools apply exact receipts, message timing, and source deduplication without scheduling", async () => {
  const f = fixture(),
    source = f.source("I woke up for the day.");
  const first = await f.call("daily_waking", wake(source.sourceId), source);
  expect(first.status).toBe("succeeded");
  const result = first.result as {
    effect: string;
    event: { id: string; occurred: { at: string } };
    day: { id: string };
    schedulingAvailable: boolean;
  };
  expect(result.effect).toBe("created");
  expect(result.event.occurred.at).toBe(source.at);
  expect(result.schedulingAvailable).toBe(false);
  const repeated = await f.call("daily_waking", wake(source.sourceId), source);
  expect(repeated).toMatchObject({
    status: "succeeded",
    result: {
      effect: "already_recorded",
      event: { id: result.event.id },
      day: { id: result.day.id },
    },
  });
  expect(f.daily.listDays()).toHaveLength(1);
  expect(f.daily.listEvents().items).toHaveLength(1);
  expect(f.store.db.query("SELECT id FROM core_conversation_outbox").all()).toHaveLength(0);
});

test("forwarded, marked quoted, unknown and stale inputs cannot become a current wake", async () => {
  for (const metadata of [
    null,
    { ...original, provenance: "forwarded" as const },
    { ...original, quotedRanges: [{ offset: 0, length: 22 }] },
  ]) {
    const f = fixture(),
      source = f.source("I woke up for the day.", metadata);
    expect(await f.call("daily_waking", wake(source.sourceId), source)).toMatchObject({
      status: "succeeded",
      result: { effect: "needs_clarification", event: null },
    });
    expect(f.daily.currentDay()).toBeNull();
  }
  const f = fixture(),
    old = f.source("I woke up for the day.");
  f.source("Actually, I am still going to bed.");
  expect(await f.call("daily_waking", wake(old.sourceId), old)).toMatchObject({
    result: { effect: "needs_clarification", reason: "historical_or_stale_source" },
  });
  expect(f.daily.currentDay()).toBeNull();
});

test("historical records stay history while future or foreign references cannot support facts", async () => {
  const f = fixture(),
    old = f.source("I woke up for the day.", null),
    current = f.source("That was yesterday's wake, not a new one.");
  const historical = await f.call(
    "daily_waking",
    { ...wake(old.sourceId), mode: "history" },
    current,
  );
  expect(historical).toMatchObject({
    status: "succeeded",
    result: { effect: "created", event: { stateApplied: false, wakingDayId: null }, day: null },
  });
  expect(f.daily.overview().windows).toHaveLength(0);
  const foreign = f.source("I woke up for the day.", original, "999");
  expect(await f.call("daily_waking", wake(foreign.sourceId), current)).toMatchObject({
    status: "rejected",
    code: "invalid_arguments",
  });
  expect(
    await f.call(
      "daily_read",
      { mode: "time", sourceId: foreign.sourceId, relativeMinutes: -60 },
      current,
    ),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  expect(
    await f.call(
      "daily_waking",
      { ...wake(current.sourceId), timeBasis: "exact", occurredAt: "2099-01-01T00:00:00Z" },
      current,
    ),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
});

test("pinned and current permissions both constrain daily writes, including operation replay", async () => {
  const pinned = { manageWaking: false, manageProgress: false },
    f = fixture(pinned),
    source = f.source("I woke up for the day.");
  pinned.manageWaking = true;
  expect(await f.call("daily_waking", wake(source.sourceId), source)).toMatchObject({
    status: "rejected",
    code: "permission_denied",
  });
  expect(await f.call("daily_read", {}, source)).toMatchObject({
    result: { permissions: { manageWaking: false, manageProgress: false } },
  });
  const allowed = fixture(),
    owner = allowed.source("I woke up for the day.");
  expect(
    (
      await allowed.call("daily_waking", wake(owner.sourceId), owner, {
        operationKey: "saved-operation",
      })
    ).status,
  ).toBe("succeeded");
  allowed.daily.saveSettings({
    expectedVersion: allowed.daily.getSettings().version,
    allowValerieManageWaking: false,
    allowValerieManageProgress: true,
  });
  expect(
    await allowed.call("daily_waking", wake(owner.sourceId), owner, {
      operationKey: "saved-operation",
    }),
  ).toMatchObject({ status: "rejected", code: "permission_denied" });
});

test("progress totals and corrections remain shared facts; forged observations and wrong-action fields are rejected", async () => {
  const f = fixture(),
    source = f.source("Please track meals. I have eaten two meals today.");
  const configured = await f.call(
    "daily_progress",
    {
      action: "configure_behavior",
      name: "Meals",
      unit: "meals",
      valueKind: "count",
      sourceIds: [source.sourceId],
    },
    source,
  );
  expect(configured.status).toBe("succeeded");
  const behavior = (configured.result as { behavior: { id: string } }).behavior;
  const recorded = await f.call(
    "daily_progress",
    {
      action: "report",
      behaviorId: behavior.id,
      mode: "total_so_far",
      value: 2,
      summary: "The owner reports two meals.",
      sourceIds: [source.sourceId],
    },
    source,
  );
  expect(recorded).toMatchObject({
    status: "succeeded",
    result: {
      effect: "created",
      event: { payload: { mode: "total_so_far", value: 2 }, evidenceKind: "owner_report" },
      schedulingAvailable: false,
    },
  });
  const event = (recorded.result as { event: { id: string; version: number } }).event;
  const correction = f.source("Actually I counted wrong; just one meal.");
  expect(
    await f.call(
      "daily_progress",
      {
        action: "correct",
        id: event.id,
        expectedVersion: event.version,
        mode: "total_so_far",
        value: 1,
        summary: "The owner corrects the total to one meal.",
        sourceIds: [correction.sourceId],
      },
      correction,
    ),
  ).toMatchObject({
    status: "succeeded",
    result: { effect: "updated", event: { version: 2, payload: { value: 1 } } },
  });
  expect(f.daily.readEvent(event.id, { revision: 1 })?.payload).toMatchObject({ value: 2 });
  expect(
    await f.call(
      "daily_progress",
      {
        action: "report",
        behaviorId: behavior.id,
        mode: "occurrence",
        value: 1,
        summary: "A claimed observation.",
        evidenceKind: "integration_observation",
        sourceIds: [correction.sourceId],
      },
      correction,
    ),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  expect(
    await f.call(
      "daily_progress",
      {
        action: "void",
        id: event.id,
        expectedVersion: 2,
        value: 7,
        sourceIds: [correction.sourceId],
      },
      correction,
    ),
  ).toMatchObject({ status: "rejected", field: "action" });
  expect(
    await f.call(
      "daily_waking",
      {
        action: "correct",
        id: event.id,
        expectedVersion: 2,
        summary: "Wrong record kind.",
        sourceIds: [correction.sourceId],
      },
      correction,
    ),
  ).toMatchObject({ status: "rejected", reason: "event_unavailable" });
});

test("event and behavior reads remain bounded and distinguish all reports from unassigned", async () => {
  const f = fixture(),
    source = f.source("Show me the records.");
  const day = f.daily.recordWakingReport(
    {
      report: "main_wake",
      mode: "current",
      expectedCurrentDayId: null,
      expectedDayVersion: null,
      summary: "A fictional wake.",
      occurred: { at: null, basis: "unknown", timezone: "America/Chicago" },
    },
    { actor: "owner" },
  ).day;
  if (!day) throw new Error("Missing day.");
  const behaviors = Array.from({ length: 6 }, (_, i) =>
    f.daily.saveBehavior(
      { name: `Fictional subject ${i}`, unit: "events", valueKind: "count" },
      { actor: "owner" },
    ),
  );
  const behavior = behaviors[0];
  if (!behavior) throw new Error("Missing behavior.");
  f.daily.recordProgressReport(
    {
      behaviorId: behavior.id,
      wakingDayId: null,
      occurred: { at: null, basis: "unknown", timezone: "America/Chicago" },
      summary: "Unassigned report.",
      mode: "occurrence",
      value: 1,
    },
    { actor: "owner" },
  );
  const all = await f.call("daily_read", { mode: "events" }, source);
  expect((all.result as { items: unknown[] }).items).toHaveLength(2);
  const unassigned = await f.call("daily_read", { mode: "events", unassigned: true }, source);
  expect((unassigned.result as { items: unknown[] }).items).toHaveLength(1);
  const page = await f.call("daily_read", { mode: "behaviors", limit: 4 }, source);
  const first = page.result as { items: unknown[]; nextCursor: string };
  expect(first.items).toHaveLength(4);
  const next = await f.call(
    "daily_read",
    { mode: "behaviors", limit: 4, cursor: first.nextCursor },
    source,
  );
  expect((next.result as { items: unknown[] }).items).toHaveLength(2);
});

test("waking repair feedback includes required report fields and names the daily version conflict", async () => {
  const f = fixture(),
    source = f.source("I woke up for the day.");
  await f.call("daily_waking", wake(source.sourceId), source);
  const nap = f.source("I'm back from a little nap.");
  const input = {
    action: "report",
    report: "nap_wake",
    evidenceQuote: "I'm back from a little nap.",
    sourceIds: [nap.sourceId],
  };
  const incomplete = await f.call("daily_waking", input, nap);
  expect(incomplete).toMatchObject({
    status: "rejected",
    field: "summary",
    reason: "missing_fields",
  });
  expect(incomplete.message).toContain("expectedCurrentDayId");
  expect(incomplete.message).toContain("expectedDayVersion");
  const conflict = await f.call(
    "daily_waking",
    { ...input, summary: "The owner reports returning from a nap." },
    nap,
  );
  expect(conflict).toMatchObject({
    status: "rejected",
    field: "expectedDayVersion",
    reason: "daily_conflict",
  });
  expect(conflict.message).not.toContain("Growth Focus");
  expect(f.daily.listEvents().items).toHaveLength(1);
});

test("omitted waking versions use copied snapshot defaults and never follow concurrent owner changes", async () => {
  const setupDay = (f: ReturnType<typeof fixture>) =>
    f.daily.recordWakingReport(
      {
        report: "main_wake",
        mode: "current",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        occurred: {
          at: new Date(Date.now() - 300000).toISOString(),
          basis: "exact",
          timezone: "America/Chicago",
        },
        summary: "A fictional earlier waking report.",
      },
      { actor: "owner" },
    ).day;
  const f = fixture();
  const day = setupDay(f);
  if (!day) throw new Error("Missing day.");
  const source = f.source("I'm back from a little nap.");
  const pinned = { id: day.id, version: day.version };
  const registry = createToolRegistry(
    f.store,
    createDailyTools(f.store, {
      permissions: { manageWaking: true, manageProgress: true },
      currentDay: pinned,
    }),
  );
  pinned.version = 999;
  const result = await registry.execute(
    {
      id: "nap",
      name: "daily_waking",
      arguments: JSON.stringify({
        action: "report",
        report: "nap_wake",
        summary: "Returning from a nap in the same day.",
        evidenceQuote: "I'm back from a little nap.",
        sourceIds: [source.sourceId],
      }),
    },
    { turnId: source.turnId, operationKey: "pinned-nap", signal: new AbortController().signal },
    () => {},
  );
  expect(result).toMatchObject({
    status: "succeeded",
    result: { effect: "created", day: { id: day.id } },
  });

  for (const existed of [true, false]) {
    const next = fixture(),
      prior = existed ? setupDay(next) : null;
    const message = next.source("Good morning");
    const tools = createToolRegistry(
      next.store,
      createDailyTools(next.store, {
        permissions: { manageWaking: true, manageProgress: true },
        currentDay: prior,
      }),
    );
    const changed = prior
      ? next.daily.recordWakingReport(
          {
            report: "sleep_plan",
            mode: "current",
            expectedCurrentDayId: prior.id,
            expectedDayVersion: prior.version,
            occurred: { at: null, basis: "message_time", timezone: "America/Chicago" },
            summary: "The owner changed the sleep plan during generation.",
            expectedSleepAt: new Date(Date.now() + 3600000).toISOString(),
          },
          { actor: "owner" },
        ).day
      : setupDay(next);
    if (!changed) throw new Error("Missing changed day.");
    const stale = await tools.execute(
      {
        id: "late",
        name: "daily_waking",
        arguments: JSON.stringify({
          action: "report",
          report: "day_start",
          summary: "A declared new waking day.",
          evidenceQuote: "Good morning",
          sourceIds: [message.sourceId],
        }),
      },
      {
        turnId: message.turnId,
        operationKey: "stale-default",
        signal: new AbortController().signal,
      },
      () => {},
    );
    expect(stale).toMatchObject({ status: "rejected", reason: "daily_conflict" });
    expect(next.daily.currentDay()?.id).toBe(changed.id);
    expect(next.daily.currentDay()?.version).toBe(changed.version);
  }
});
