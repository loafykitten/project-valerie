import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createHeartbeatContextService,
  createMemoryService,
  type Store,
} from "@valerie/core";
import { captureToolCatalog } from "../tools/catalog";
import { createDailyTools } from "../tools/daily";
import { createToolRegistry } from "../tools/registry";
import { createReminderTools } from "../tools/reminders";
import { required, scheduledFixture } from "./test-fixture";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const f = scheduledFixture();
  stores.push(f.store);
  f.conversations.acquireTelegramLease("fixture", "2026-09-16T18:00:00.000Z");
  return f;
}

test("only confirmed scheduled messages enter assistant history, bounded to the correct chat and subsequent turns", () => {
  const f = fixture(),
    earlier = f.accept("I am making a fictional lantern.");
  f.reply();
  const reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" }),
    claim = required(f.reminders.claimDelivery({ chatId: "42", leaseOwner: "fixture" }));
  f.advance(1000);
  f.reminders.recordDelivery(claim, { status: "sent", messageId: "900" });
  const text = required(f.reminders.readOccurrence(reminder.currentOccurrenceId)?.text),
    id = `scheduled:${claim.id}`;
  expect(
    f.store.db.query("SELECT role,text FROM core_conversation_search WHERE id=?").get(id),
  ).toEqual({ role: "assistant", text });
  expect(f.store.db.query("SELECT count(*) AS count FROM core_telegram_inputs").get()).toEqual({
    count: 1,
  });
  expect(f.store.db.query("SELECT count(*) AS count FROM core_conversation_turns").get()).toEqual({
    count: 1,
  });
  const memories = createMemoryService(f.store, { now: f.now });
  expect(memories.conversationRead({ id, turnId: earlier.turnId })).toBeNull();
  f.advance(1000);
  const later = f.accept("I remember your fern reminder.");
  expect(memories.conversationRead({ id, turnId: later.turnId })).toMatchObject({
    role: "assistant",
    text,
  });
  expect(
    memories
      .conversationSearch({ query: "fern", turnId: later.turnId })
      .items.some((item) => item.id === id),
  ).toBe(true);
  const turn = required(f.conversations.startNextTurn());
  expect(turn.id).toBe(later.turnId);
  expect(turn.snapshot.history.includedScheduled).toBe(1);
  expect(
    turn.snapshot.messages.some(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Following explicit scheduled reminder"),
    ),
  ).toBe(true);
  expect(turn.snapshot.messages).toContainEqual({ role: "assistant", content: text });
  const heartbeat = createHeartbeatContextService(f.store, { now: f.now }).capture({
    chatId: "42",
  });
  expect(heartbeat.messages).toContainEqual({ role: "assistant", content: text });
  const foreign = f.accept("Another private conversation.", { chatId: "999" });
  expect(memories.conversationRead({ id, turnId: foreign.turnId })).toBeNull();
  expect(
    createHeartbeatContextService(f.store, { now: f.now })
      .capture({ chatId: "999" })
      .messages.some((message) => message.content === text),
  ).toBe(false);
});

test("an unknown scheduled send is absent from history until an exact late positive receipt arrives", () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" }),
    claim = required(f.reminders.claimDelivery({ chatId: "42", leaseOwner: "fixture" }));
  f.reminders.recordDelivery(claim, { status: "unknown", code: "network" });
  expect(
    f.store.db.query("SELECT id FROM core_conversation_search WHERE id LIKE 'scheduled:%'").all(),
  ).toHaveLength(0);
  expect(f.reminders.claimDelivery({ chatId: "42", leaseOwner: "fixture" })).toBeNull();
  f.reminders.cancel({ id: reminder.id, expectedVersion: reminder.version }, { actor: "owner" });
  f.advance(1000);
  expect(f.reminders.recordDelivery(claim, { status: "sent", messageId: "901" })).toBe(true);
  f.advance(1000);
  const source = f.accept("I saw that message.");
  expect(
    createMemoryService(f.store).conversationRead({
      id: `scheduled:${claim.id}`,
      turnId: source.turnId,
    }),
  ).toMatchObject({ role: "assistant" });
  expect(f.reminders.read(reminder.id)?.state).toBe("cancelled");
});

test("replying done to an older delivery resolves the current snoozed task without guessing or completing from delivery", async () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" }),
    claim = required(f.reminders.claimDelivery({ chatId: "42", leaseOwner: "fixture" }));
  f.reminders.recordDelivery(claim, { status: "sent", messageId: "902" });
  expect(f.reminders.read(reminder.id)?.state).toBe("active");
  const snoozed = f.reminders.snooze(
    {
      id: reminder.id,
      expectedVersion: reminder.version,
      occurrenceId: claim.id,
      dueAt: "2026-09-15T19:00:00.000Z",
      originalTimeIntent: "An hour later",
    },
    { actor: "owner" },
  );
  f.advance(1000);
  f.reminders.savePermissions({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageReminders: true,
  });
  const source = f.accept("Done, the fern has water now.", {
    metadata: {
      version: 1,
      provenance: "original",
      quotedRanges: [],
      replyQuote: null,
      replyToMessageId: "902",
      incomplete: false,
    },
  });
  const registry = createToolRegistry(f.store, [
    ...createDailyTools(f.store, {
      extended: true,
      now: f.now,
      reminderPermissions: { manageReminders: true },
      offeredToolNames: ["daily_read", "reminder_write"],
    }).filter((tool) => tool.name === "daily_read"),
    ...createReminderTools(f.store, { permissions: { manageReminders: true }, now: f.now }),
  ]);
  const context = {
    turnId: source.turnId,
    operationKey: "read-reply",
    signal: new AbortController().signal,
  };
  const read = await registry.execute(
    { id: "read", name: "daily_read", arguments: '{"mode":"reply_reminder"}' },
    context,
    () => {},
  );
  expect(read).toMatchObject({
    status: "succeeded",
    result: {
      match: {
        reminder: {
          id: reminder.id,
          version: snoozed.version,
          currentOccurrenceId: snoozed.currentOccurrenceId,
        },
        occurrence: { id: claim.id, telegramMessageId: "902", snapshot: null, result: null },
      },
    },
  });
  const changed = await registry.execute(
    {
      id: "complete",
      name: "reminder_write",
      arguments: JSON.stringify({
        action: "complete",
        id: reminder.id,
        expectedVersion: snoozed.version,
        occurrenceId: snoozed.currentOccurrenceId,
        sourceIds: [source.sourceId],
      }),
    },
    { ...context, operationKey: "complete-current-task" },
    () => {},
  );
  expect(changed).toMatchObject({
    status: "succeeded",
    result: { reminder: { state: "completed" } },
  });
  expect(f.reminders.readOccurrence(claim.id)?.telegramMessageId).toBe("902");
  expect(f.reminders.readOccurrence(snoozed.currentOccurrenceId)?.status).toBe("cancelled");
});

test("ordinary reply snapshots conditionally pin the delivered target and current task without completing it", () => {
  for (const purposeChanged of [false, true]) {
    const f = fixture(),
      reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" }),
      sent = required(f.reminders.claimDelivery({ chatId: "42", leaseOwner: "fixture" }));
    f.reminders.recordDelivery(sent, { status: "sent", messageId: "903" });
    const current = purposeChanged
      ? f.reminders.saveReminder(
          {
            ...f.fields({
              title: "A different fictional plant",
              purpose: "Water the fictional cactus.",
              dueAt: "2026-09-15T19:00:00.000Z",
            }),
            id: reminder.id,
            expectedVersion: reminder.version,
          },
          { actor: "owner" },
        )
      : f.reminders.snooze(
          {
            id: reminder.id,
            expectedVersion: reminder.version,
            occurrenceId: sent.id,
            dueAt: "2026-09-15T19:00:00.000Z",
            originalTimeIntent: "An hour later",
          },
          { actor: "owner" },
        );
    f.advance(1000);
    f.accept("Done, thanks.", {
      metadata: {
        version: 1,
        provenance: "original",
        quotedRanges: [],
        replyQuote: null,
        replyToMessageId: "903",
        incomplete: false,
      },
    });
    const conversations = createConversationService(f.store, {
      now: f.now,
      reminderTools: true,
      captureToolCatalog: (flags) => captureToolCatalog(f.store, flags),
    });
    const turn = required(conversations.startNextTurn());
    expect(turn.snapshot.reminders?.replyTarget).toMatchObject({
      matchedDelivery: { occurrenceId: sent.id, telegramMessageId: "903" },
      currentReminder: {
        id: reminder.id,
        version: current.version,
        currentOccurrenceId: current.currentOccurrenceId,
        state: "active",
      },
      purposeChanged,
      titleChanged: purposeChanged,
    });
    expect(JSON.stringify(turn.snapshot.messages)).toContain("unambiguous report such as done");
    expect(JSON.stringify(turn.snapshot.messages)).toContain("Replying alone");
    expect(f.reminders.read(reminder.id)?.state).toBe("active");
    const before = JSON.stringify(turn.snapshot.reminders?.replyTarget);
    f.reminders.cancel({ id: reminder.id, expectedVersion: current.version }, { actor: "owner" });
    conversations.failGeneration(turn.id, {
      code: "fictional_retry",
      retryAt: f.now().toISOString(),
    });
    expect(
      JSON.stringify(required(conversations.startNextTurn()).snapshot.reminders?.replyTarget),
    ).toBe(before);
  }
  const noMatch = fixture();
  noMatch.accept("Just a normal conversation.");
  const conversations = createConversationService(noMatch.store, {
    now: noMatch.now,
    reminderTools: true,
    captureToolCatalog: (flags) => captureToolCatalog(noMatch.store, flags),
  });
  const turn = required(conversations.startNextTurn());
  expect(turn.snapshot.reminders?.replyTarget).toBeUndefined();
  expect(JSON.stringify(turn.snapshot.messages)).not.toContain(
    "Matched delivery and CURRENT reminder",
  );
});
