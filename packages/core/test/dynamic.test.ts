import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConversationService,
  createDynamicService,
  DynamicConflictError,
  type DynamicMutationContext,
  DynamicOperationConflictError,
  DynamicPermissionError,
  type GrowthFocusFields,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const fields: GrowthFocusFields = {
  title: "Enjoying creative practice",
  reason: "Make room for the pleasure of making things without rating every result.",
  startDate: "2026-09-15",
  reviewDate: "2026-10-27",
  practices: ["Notice one part of making that was enjoyable."],
  indicators: ["Reported enjoyment and obstacles, when shared."],
};
const owner: DynamicMutationContext = { actor: "owner" };

function fixture(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  let time = new Date("2026-09-15T17:00:00.000Z");
  const now = () => new Date(time);
  const dynamic = createDynamicService(store, { now });
  const conversations = createConversationService(store, { now });
  const add = (
    updateId: number,
    text = "I want to enjoy making pottery.",
    chatId = "123",
    senderId = "123",
  ) => {
    conversations.acceptTelegramBatch({
      nextOffset: updateId + 1,
      inputs: [
        {
          updateId,
          messageId: String(updateId),
          chatId,
          senderId,
          text,
          receivedAt: now().toISOString(),
        },
      ],
    });
    const row = store.db
      .query<{ id: string; turnId: string }, [number]>(
        "SELECT id,turn_id AS turnId FROM core_telegram_inputs WHERE update_id=?",
      )
      .get(updateId);
    if (!row) throw new Error("Missing fictional source.");
    return { ...row, sourceId: `conversation:${row.id}` };
  };
  const delegate = (manageFocus = true, logNotes = true) =>
    dynamic.saveSettings({
      expectedVersion: dynamic.getSettings().version,
      allowValerieManageFocus: manageFocus,
      allowValerieLogNotes: logNotes,
    });
  const model = (turnId: string, operationKey: string): DynamicMutationContext => ({
    actor: "valerie",
    turnId,
    operationKey,
    permissions: { manageFocus: true, logNotes: true },
  });
  return {
    store,
    dynamic,
    add,
    delegate,
    model,
    setTime: (value: string) => {
      time = new Date(value);
    },
  };
}

test("permissions are absent by default, independently delegated, pinned per turn and rechecked live", () => {
  const f = fixture();
  const source = f.add(1);
  const input = { ...fields, sourceIds: [source.sourceId] };
  expect(f.dynamic.current()).toBeNull();
  expect(f.dynamic.capture()).toMatchObject({
    focus: null,
    content: "",
    permissions: { manageFocus: false, logNotes: false },
  });
  expect(() => f.dynamic.saveFocus(input, f.model(source.turnId, "not-delegated"))).toThrow(
    DynamicPermissionError,
  );
  f.delegate(true, false);
  expect(() =>
    f.dynamic.saveFocus(input, {
      ...f.model(source.turnId, "old-turn"),
      permissions: { manageFocus: false, logNotes: true },
    }),
  ).toThrow(DynamicPermissionError);
  expect(() =>
    f.dynamic.saveFocus(input, { ...f.model(source.turnId, "no-pinned"), permissions: undefined }),
  ).toThrow(DynamicPermissionError);
  const focus = f.dynamic.saveFocus(input, f.model(source.turnId, "create"));
  const note = {
    focusId: focus.id,
    expectedFocusVersion: focus.version,
    body: "Making the bowl was enjoyable.",
    kind: "owner_report" as const,
    sourceIds: [source.sourceId],
  };
  expect(() => f.dynamic.addNote(note, f.model(source.turnId, "no-notes"))).toThrow(
    DynamicPermissionError,
  );
  f.delegate(false, true);
  expect(f.dynamic.addNote(note, f.model(source.turnId, "notes-allowed")).kind).toBe(
    "owner_report",
  );
  expect(() =>
    f.dynamic.saveFocus(
      { ...input, id: focus.id, expectedVersion: focus.version },
      f.model(source.turnId, "withdrawn"),
    ),
  ).toThrow(DynamicPermissionError);
  expect(() => f.dynamic.saveFocus(input, f.model(source.turnId, "create"))).toThrow(
    DynamicPermissionError,
  );
  expect(f.dynamic.current()?.version).toBe(1);
});

test("a future or paused focus reserves the single focus and the review date never ends it", () => {
  const f = fixture();
  f.setTime("2026-09-16T04:59:59.000Z");
  const focus = f.dynamic.saveFocus({ ...fields, startDate: "2026-09-16" }, owner);
  expect(focus.phase).toBe("scheduled");
  expect(f.dynamic.capture().content).toContain("has not started");
  expect(() => f.dynamic.saveFocus(fields, owner)).toThrow(DynamicConflictError);
  f.setTime("2026-09-16T05:00:00.000Z");
  expect(f.dynamic.current()?.phase).toBe("active");
  const snapshot = f.dynamic.capture();
  f.setTime("2026-10-27T05:00:00.000Z");
  expect(f.dynamic.current()).toMatchObject({ state: "active", reviewDue: true });
  const paused = f.dynamic.setFocusState(
    { id: focus.id, expectedVersion: focus.version, state: "paused" },
    owner,
  );
  expect(paused).toMatchObject({ phase: "paused", reviewDue: false });
  expect(f.dynamic.capture().content).toContain("Do not press its practices");
  expect(() => f.dynamic.saveFocus(fields, owner)).toThrow(DynamicConflictError);
  expect(snapshot.focus).toMatchObject({ version: 1, phase: "active", reviewDue: false });
  const resumed = f.dynamic.setFocusState(
    { id: focus.id, expectedVersion: paused.version, state: "active" },
    owner,
  );
  expect(resumed).toMatchObject({ version: 3, phase: "active", reviewDue: true });
});

test("owner revisions reject stale focus, state and note edits while preserving original authored fields", () => {
  const f = fixture();
  const original = f.dynamic.saveFocus(fields, owner);
  const changed = f.dynamic.saveFocus(
    {
      ...fields,
      id: original.id,
      expectedVersion: original.version,
      reason: "Revised by the owner.\nKeep these exact line breaks.",
    },
    owner,
  );
  expect(changed.version).toBe(2);
  expect(f.dynamic.read(original.id, { revision: 1 })).toMatchObject(fields);
  expect(() => f.dynamic.read(original.id, { revision: 0 })).toThrow("current saved version");
  expect(() =>
    f.dynamic.saveFocus({ ...fields, id: original.id, expectedVersion: 1 }, owner),
  ).toThrow(DynamicConflictError);
  expect(() =>
    f.dynamic.setFocusState({ id: original.id, expectedVersion: 1, state: "paused" }, owner),
  ).toThrow(DynamicConflictError);
  expect(() =>
    f.dynamic.addNote(
      { focusId: original.id, expectedFocusVersion: 1, body: "A report.", kind: "owner_report" },
      owner,
    ),
  ).toThrow(DynamicConflictError);
  expect(f.dynamic.read(original.id)?.reason).toBe(changed.reason);
  const settings = f.dynamic.getSettings();
  f.delegate();
  expect(() => f.dynamic.saveSettings({ ...settings, expectedVersion: settings.version })).toThrow(
    DynamicConflictError,
  );
});

test("model evidence cannot cross chat, sender, later-turn or assistant boundaries", () => {
  const f = fixture();
  f.delegate();
  const earlier = f.add(1);
  const otherChat = f.add(2, "A different conversation.", "999", "123");
  const otherSender = f.add(3, "Another sender.", "123", "999");
  const current = f.add(4, "Please keep that as our focus.");
  const later = f.add(5, "A later correction.");
  for (const source of [
    otherChat.sourceId,
    otherSender.sourceId,
    later.sourceId,
    "delivery:fictional",
    "vault:fictional",
    "conversation:missing",
  ]) {
    expect(() =>
      f.dynamic.saveFocus({ ...fields, sourceIds: [source] }, f.model(current.turnId, source)),
    ).toThrow("available owner message IDs");
  }
  expect(() => f.dynamic.saveFocus(fields, f.model(current.turnId, "missing-evidence"))).toThrow(
    "one to five original owner message IDs",
  );
  expect(() =>
    f.dynamic.saveFocus(
      { ...fields, sourceIds: [earlier.sourceId] },
      f.model("missing-turn", "invalid-turn"),
    ),
  ).toThrow("source turn is unavailable");
  const focus = f.dynamic.saveFocus(
    { ...fields, sourceIds: [earlier.sourceId, current.sourceId] },
    f.model(current.turnId, "supported"),
  );
  expect(focus.sources.map((source) => source.id)).toEqual([earlier.sourceId, current.sourceId]);
  expect(focus.authoredBy).toBe("valerie");
  expect(f.dynamic.current({ turnId: otherChat.turnId })).toBeNull();
  expect(() =>
    f.dynamic.saveFocus(
      { ...fields, id: focus.id, expectedVersion: 1, sourceIds: [otherChat.sourceId] },
      f.model(otherChat.turnId, "cross-focus-edit"),
    ),
  ).toThrow("current, available Growth Focus");
});

test("state changes retain content evidence, replace state evidence and hide future decisions from older turns", () => {
  const f = fixture();
  f.delegate();
  const choosing = f.add(1);
  const focus = f.dynamic.saveFocus(
    { ...fields, sourceIds: [choosing.sourceId] },
    f.model(choosing.turnId, "choose-focus"),
  );
  expect(focus.stateSources).toEqual(focus.sources);
  const pausing = f.add(2, "Please pause our focus for now.");
  const paused = f.dynamic.setFocusState(
    { id: focus.id, expectedVersion: 1, state: "paused", sourceIds: [pausing.sourceId] },
    f.model(pausing.turnId, "pause-focus"),
  );
  expect(paused.sources).toEqual(focus.sources);
  expect(paused.stateSources.map((source) => source.id)).toEqual([pausing.sourceId]);
  expect(f.dynamic.read(focus.id, { turnId: choosing.turnId })).toBeNull();
  expect(f.dynamic.current({ turnId: choosing.turnId })).toBeNull();
  expect(f.dynamic.list({ turnId: choosing.turnId })).toEqual([]);
  expect(f.dynamic.read(focus.id, { revision: 1, turnId: choosing.turnId })?.state).toBe("active");
  expect(() =>
    f.dynamic.setFocusState(
      { id: focus.id, expectedVersion: 2, state: "active", sourceIds: [choosing.sourceId] },
      f.model(choosing.turnId, "stale-turn-resume"),
    ),
  ).toThrow("current, available Growth Focus");
  const resuming = f.add(3, "I am ready to resume our focus.");
  const resumed = f.dynamic.setFocusState(
    { id: focus.id, expectedVersion: 2, state: "active", sourceIds: [resuming.sourceId] },
    f.model(resuming.turnId, "resume-focus"),
  );
  expect(resumed.sources).toEqual(focus.sources);
  expect(resumed.stateSources.map((source) => source.id)).toEqual([resuming.sourceId]);
  const revising = f.add(4, "Let's give this focus a more playful title.");
  const edited = f.dynamic.saveFocus(
    {
      ...fields,
      id: focus.id,
      expectedVersion: 3,
      title: "Playful creative practice",
      sourceIds: [choosing.sourceId, revising.sourceId],
    },
    f.model(revising.turnId, "revise-focus"),
  );
  expect(edited.stateSources).toEqual(resumed.stateSources);
  expect(edited.sources.map((source) => source.id)).toEqual([choosing.sourceId, revising.sourceId]);
  expect(f.dynamic.read(focus.id, { turnId: resuming.turnId })).toBeNull();
  const snapshot = f.dynamic.capture();
  expect(snapshot.focus).not.toHaveProperty("sources");
  expect(snapshot.focus).not.toHaveProperty("stateSources");
  expect(snapshot.content).not.toContain(choosing.sourceId);
  expect(snapshot.content).not.toContain(resuming.sourceId);
});

test("notes retain evidence and separate interpretations; corrections append without silently converting reports", () => {
  const f = fixture();
  f.delegate();
  const source = f.add(1, "I felt discouraged, then enjoyed painting a small tile.");
  const focus = f.dynamic.saveFocus(fields, owner);
  const input = {
    focusId: focus.id,
    expectedFocusVersion: focus.version,
    body: "The owner enjoyed painting a tile after feeling discouraged.",
    kind: "owner_report" as const,
    sourceIds: [source.sourceId],
  };
  const original = f.dynamic.addNote(input, f.model(source.turnId, "report"));
  const thought = f.dynamic.addNote(
    {
      ...input,
      body: "A smaller starting task may have helped; this is an interpretation.",
      kind: "valerie_interpretation",
    },
    f.model(source.turnId, "thought"),
  );
  expect(original.sources).toEqual([
    {
      type: "conversation",
      id: source.sourceId,
      role: "user",
      observedAt: "2026-09-15T17:00:00.000Z",
    },
  ]);
  expect(() =>
    f.dynamic.addNote(
      { ...input, kind: "valerie_interpretation", supersedesNoteId: original.id },
      f.model(source.turnId, "reclassify"),
    ),
  ).toThrow("Correct a report with a report");
  const update = f.add(2, "It was a coaster, not a tile.");
  const corrected = f.dynamic.addNote(
    {
      ...input,
      body: "The owner enjoyed painting a coaster.",
      sourceIds: [source.sourceId, update.sourceId],
      supersedesNoteId: original.id,
    },
    f.model(update.turnId, "correction"),
  );
  expect(corrected.supersedesNoteId).toBe(original.id);
  expect(f.dynamic.notes(focus.id).items).toEqual([
    corrected,
    thought,
    { ...original, superseded: true },
  ]);
  expect(() =>
    f.dynamic.addNote(
      { ...input, supersedesNoteId: original.id },
      f.model(update.turnId, "second-correction"),
    ),
  ).toThrow(DynamicConflictError);
  expect(() =>
    f.store.db
      .query("UPDATE core_dynamic_progress_notes SET record_json='{}' WHERE id=?")
      .run(original.id),
  ).toThrow("immutable");
  expect(() =>
    f.store.db.query("DELETE FROM core_dynamic_progress_notes WHERE id=?").run(original.id),
  ).toThrow("retained");
  expect(f.dynamic.current()?.version).toBe(1);
});

test("operation receipts survive reopening, reject key reuse for another edit and preserve original outcomes", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-dynamic-test-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const f = fixture(path);
  f.delegate();
  const source = f.add(1);
  const context = f.model(source.turnId, "persistent-create");
  const input = { ...fields, sourceIds: [source.sourceId] };
  const original = f.dynamic.saveFocus(input, context);
  const reopened = fixture(path);
  expect(reopened.dynamic.saveFocus(input, context)).toEqual(original);
  expect(() =>
    reopened.dynamic.saveFocus({ ...input, title: "A different operation" }, context),
  ).toThrow(DynamicOperationConflictError);
  expect(reopened.dynamic.list()).toHaveLength(1);
  expect(
    reopened.store.db.query("SELECT count(*) AS count FROM core_growth_focus_revisions").get(),
  ).toEqual({ count: 1 });
  expect(() => reopened.dynamic.saveFocus(input, { ...context, operationKey: undefined })).toThrow(
    "operationKey",
  );
  const noteInput = {
    focusId: original.id,
    expectedFocusVersion: 1,
    body: "A supported progress report.",
    kind: "owner_report" as const,
    sourceIds: [source.sourceId],
  };
  const noteContext = f.model(source.turnId, "persistent-note");
  const note = reopened.dynamic.addNote(noteInput, noteContext);
  expect(f.dynamic.addNote(noteInput, noteContext)).toEqual(note);
  expect(f.dynamic.notes(original.id).items).toHaveLength(1);
});

test("archived focus and its notes stay immutable while a distinct current focus may begin", () => {
  const f = fixture();
  const original = f.dynamic.saveFocus(fields, owner);
  const note = f.dynamic.addNote(
    {
      focusId: original.id,
      expectedFocusVersion: 1,
      body: "An owner report.",
      kind: "owner_report",
    },
    owner,
  );
  const archived = f.dynamic.setFocusState(
    { id: original.id, expectedVersion: 1, state: "archived" },
    owner,
  );
  expect(f.dynamic.current()).toBeNull();
  expect(f.dynamic.capture().content).toBe("");
  expect(() =>
    f.dynamic.setFocusState(
      { id: original.id, expectedVersion: archived.version, state: "active" },
      owner,
    ),
  ).toThrow("Archived history remains unchanged");
  expect(() =>
    f.dynamic.addNote(
      {
        focusId: original.id,
        expectedFocusVersion: archived.version,
        body: "A later report.",
        kind: "owner_report",
      },
      owner,
    ),
  ).toThrow("Archived history remains unchanged");
  const current = f.dynamic.saveFocus({ ...fields, title: "A distinct focus" }, owner);
  expect(() =>
    f.dynamic.addNote(
      {
        focusId: current.id,
        expectedFocusVersion: current.version,
        body: "A correction from another focus.",
        kind: "owner_report",
        supersedesNoteId: note.id,
      },
      owner,
    ),
  ).toThrow("available note from this focus");
  expect(f.dynamic.detail(archived.id)?.notes).toEqual([note]);
  expect(() =>
    f.store.db.query("UPDATE core_growth_focus SET state='active' WHERE id=?").run(archived.id),
  ).toThrow("immutable");
  expect(() =>
    f.store.db.query("DELETE FROM core_growth_focus WHERE id=?").run(archived.id),
  ).toThrow("retained");
});

test("note paging remains stable when a newer note arrives and rejects a cursor from another focus", () => {
  const f = fixture();
  const focus = f.dynamic.saveFocus(fields, owner);
  const input = {
    focusId: focus.id,
    expectedFocusVersion: 1,
    body: "A fictional report.",
    kind: "owner_report" as const,
  };
  const first = f.dynamic.addNote(input, owner);
  const second = f.dynamic.addNote(input, owner);
  const third = f.dynamic.addNote(input, owner);
  const page = f.dynamic.notes(focus.id, { limit: 2 });
  expect(page.items.map((note) => note.id)).toEqual([third.id, second.id]);
  expect(page.nextCursor).toBe(second.id);
  f.dynamic.addNote(input, owner);
  expect(f.dynamic.notes(focus.id, { limit: 2, cursor: page.nextCursor ?? undefined })).toEqual({
    items: [first],
    nextCursor: null,
  });
  f.dynamic.setFocusState({ id: focus.id, expectedVersion: 1, state: "archived" }, owner);
  const next = f.dynamic.saveFocus(fields, owner);
  expect(() => f.dynamic.notes(next.id, { cursor: second.id })).toThrow("Reload notes");
});

test("bounded fields reject impossible dates and preserve meaningful empty optional lists", () => {
  const f = fixture();
  for (const replacement of [
    { startDate: "2026-02-30" },
    { reviewDate: fields.startDate },
    { reviewDate: "2026-09-14" },
    { title: "é".repeat(61) },
    { reason: "" },
    { practices: Array.from({ length: 6 }, () => "A practice.") },
    { indicators: [" "] },
  ])
    expect(() => f.dynamic.saveFocus({ ...fields, ...replacement }, owner)).toThrow();
  expect(f.dynamic.list()).toEqual([]);
  const focus = f.dynamic.saveFocus({ ...fields, practices: [], indicators: [] }, owner);
  expect(focus.practices).toEqual([]);
  expect(focus.indicators).toEqual([]);
  expect(focus.sources[0]).toMatchObject({ type: "owner_entry", role: "owner" });
});
