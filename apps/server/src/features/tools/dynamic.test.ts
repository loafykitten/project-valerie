import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createDynamicService,
  type DynamicPermissions,
  openStore,
  type Store,
} from "@valerie/core";
import { createDynamicTools } from "./dynamic";
import { createToolJournal } from "./journal";
import { createToolRegistry, type ToolOutcome } from "./registry";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const fields = {
  title: "Enjoy creative practice",
  reason: "Make room for enjoyment without judging every result.",
  startDate: "2026-09-15",
  reviewDate: "2026-10-27",
  practices: ["Notice an enjoyable part of making things."],
  indicators: [],
};
function fixture(permissions?: DynamicPermissions) {
  const store = openStore(":memory:");
  stores.push(store);
  const dynamic = createDynamicService(store);
  const conversations = createConversationService(store);
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "123",
        senderId: "123",
        text: "I'd like to enjoy pottery without judging the result.",
      },
    ],
  });
  const source = store.db
    .query<{ id: string; turnId: string }, []>(
      "SELECT id,turn_id AS turnId FROM core_telegram_inputs",
    )
    .get();
  if (!source) throw new Error("Missing fictional source.");
  const registry = createToolRegistry(store, createDynamicTools(store, { permissions }));
  let index = 0;
  const call = (name: string, input: unknown, extra: Record<string, unknown> = {}) =>
    registry.execute(
      { id: `call-${index}`, name, arguments: JSON.stringify(input) },
      {
        turnId: source.turnId,
        operationKey: `operation-${index++}`,
        signal: new AbortController().signal,
        ...extra,
      },
      () => {},
    );
  return {
    store,
    dynamic,
    source,
    registry,
    call,
    input: { ...fields, sourceIds: [`conversation:${source.id}`] },
  };
}

test("focus tools stay discoverable with permission feedback and cannot expand a pinned turn", async () => {
  const pinned = { manageFocus: false, logNotes: false };
  const f = fixture(pinned);
  expect(f.registry.schemas.map((schema) => schema.name)).toEqual([
    "growth_focus_read",
    "growth_focus_save",
    "growth_focus_set_state",
    "growth_focus_log_note",
  ]);
  f.dynamic.saveSettings({
    expectedVersion: 1,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  // Mutating an options object after tool construction cannot retroactively grant access.
  pinned.manageFocus = true;
  expect(await f.call("growth_focus_read", {})).toMatchObject({
    status: "succeeded",
    result: { found: false, permissions: { manageFocus: false, logNotes: false } },
  });
  expect(await f.call("growth_focus_save", f.input)).toMatchObject({
    status: "rejected",
    code: "permission_denied",
  });
  expect(f.dynamic.current()).toBeNull();
  const defaults = fixture();
  defaults.dynamic.saveSettings({
    expectedVersion: 1,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  expect(await defaults.call("growth_focus_save", defaults.input)).toMatchObject({
    code: "permission_denied",
  });
});

test("actual tool receipts match saved records and schema, evidence, turn-kind and version failures make no edit", async () => {
  const f = fixture({ manageFocus: true, logNotes: true });
  f.dynamic.saveSettings({
    expectedVersion: 1,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  expect(await f.call("growth_focus_save", { ...f.input, authoredBy: "owner" })).toMatchObject({
    status: "rejected",
    code: "invalid_arguments",
  });
  expect(await f.call("growth_focus_save", f.input, { turnKind: "heartbeat" })).toMatchObject({
    status: "rejected",
    code: "unavailable_tool",
  });
  expect(
    await f.call("growth_focus_save", { ...f.input, sourceIds: ["delivery:made-up"] }),
  ).toMatchObject({ status: "rejected", field: "sourceIds", reason: "source_unavailable" });
  const saved = await f.call("growth_focus_save", f.input);
  const focus = f.dynamic.current();
  expect(focus).not.toBeNull();
  expect(saved).toMatchObject({
    status: "succeeded",
    result: { id: focus?.id, version: 1, state: "active", sourceCount: 1 },
  });
  const noteInput = {
    focusId: focus?.id,
    expectedFocusVersion: 1,
    body: "The owner wants to enjoy pottery without judging the result.",
    kind: "owner_report",
    sourceIds: f.input.sourceIds,
  };
  const note = await f.call("growth_focus_log_note", noteInput);
  expect(note).toMatchObject({
    status: "succeeded",
    result: { focusId: focus?.id, kind: "owner_report", sourceCount: 1 },
  });
  expect(await f.call("growth_focus_read", {})).toMatchObject({
    status: "succeeded",
    result: { focus: { id: focus?.id }, notes: { items: [{ body: noteInput.body }] } },
  });
  expect(
    await f.call("growth_focus_set_state", {
      id: focus?.id,
      expectedVersion: 1,
      state: "paused",
      sourceIds: f.input.sourceIds,
    }),
  ).toMatchObject({ status: "succeeded", result: { version: 2, phase: "paused" } });
  expect(await f.call("growth_focus_log_note", noteInput)).toMatchObject({
    status: "rejected",
    reason: "focus_conflict",
  });
  expect(
    await f.call("growth_focus_save", { ...f.input, id: focus?.id, expectedVersion: 1 }),
  ).toMatchObject({ status: "rejected", field: "expectedVersion" });
  f.dynamic.saveSettings({
    expectedVersion: 2,
    allowValerieManageFocus: false,
    allowValerieLogNotes: false,
  });
  expect(
    await f.call("growth_focus_set_state", {
      id: focus?.id,
      expectedVersion: 2,
      state: "active",
      sourceIds: f.input.sourceIds,
    }),
  ).toMatchObject({ status: "rejected", code: "permission_denied" });
  expect(f.dynamic.current()?.version).toBe(2);
  expect(f.dynamic.notes(focus?.id ?? "").items).toHaveLength(1);
});

test("a tool mutation and its journal outcome commit together and roll back together", async () => {
  const f = fixture({ manageFocus: true, logNotes: true });
  f.dynamic.saveSettings({
    expectedVersion: 1,
    allowValerieManageFocus: true,
    allowValerieLogNotes: true,
  });
  const journal = createToolJournal(f.store, f.source.turnId);
  journal.saveRound(0, {
    text: "",
    finishReason: "tool_calls",
    complete: false,
    requestId: "fictional-receipt",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: null,
    toolCalls: [{ id: "create", name: "growth_focus_save", arguments: JSON.stringify(f.input) }],
  });
  const call = { id: "create", name: "growth_focus_save", arguments: JSON.stringify(f.input) };
  const context = {
    turnId: f.source.turnId,
    operationKey: "journal-create",
    signal: new AbortController().signal,
  };
  const failed = await f.registry.execute(call, context, (outcome, effect) => {
    journal.saveOutcome(0, 0, call.name, outcome, effect);
    if (outcome.status === "succeeded") throw new Error("A fictional journal transaction failure.");
  });
  expect(failed).toMatchObject({ status: "failed", code: "tool_failed" });
  expect(journal.readOutcome(0, 0)).toEqual(failed);
  expect(f.dynamic.current()).toBeNull();
  expect(f.store.db.query("SELECT count(*) AS count FROM core_dynamic_operations").get()).toEqual({
    count: 0,
  });
  const succeeded = await f.registry.execute(call, context, (outcome, effect) =>
    journal.saveOutcome(0, 1, call.name, outcome, effect),
  );
  expect(succeeded.status).toBe("succeeded");
  expect(journal.readOutcome(0, 1)).toEqual(succeeded);
  expect(f.dynamic.current()?.version).toBe(1);
});

test("focus reads remain bounded for maximum authored fields and paginated notes", async () => {
  const f = fixture({ manageFocus: false, logNotes: false });
  const focus = f.dynamic.saveFocus(
    {
      ...fields,
      title: "\\".repeat(120),
      reason: "\\".repeat(800),
      practices: Array.from({ length: 5 }, () => "\\".repeat(160)),
      indicators: Array.from({ length: 5 }, () => "\\".repeat(160)),
    },
    { actor: "owner" },
  );
  for (let i = 0; i < 5; i++)
    f.dynamic.addNote(
      { focusId: focus.id, expectedFocusVersion: 1, body: "\\".repeat(1200), kind: "owner_report" },
      { actor: "owner" },
    );
  const read = await f.call("growth_focus_read", { limit: 4 });
  expect(read.status).toBe("succeeded");
  const result = read.result as { notes: { items: unknown[]; nextCursor: string } };
  expect(result.notes.items).toHaveLength(4);
  expect(result.notes.nextCursor).toBeString();
  expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThan(24000);
  const next: ToolOutcome = await f.call("growth_focus_read", {
    limit: 4,
    cursor: result.notes.nextCursor,
  });
  expect((next.result as { notes: { items: unknown[] } }).notes.items).toHaveLength(1);
});
