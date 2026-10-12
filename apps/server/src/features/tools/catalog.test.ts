import { afterEach, expect, test } from "bun:test";
import {
  type ConversationToolCapabilities,
  createContextHealthService,
  createConversationService,
  type Store,
} from "@valerie/core";
import { InferenceError } from "@valerie/inference";
import { measureCompletion } from "../context-health/measure";
import { completion, required, scheduledFixture } from "../reminders/test-fixture";
import { bindConversationTools, CURRENT_TOOL_CATALOG, captureToolCatalog } from "./catalog";
import legacy016 from "./catalog/legacy-016.json";
import { createDailyTools } from "./daily";
import { createToolRegistry } from "./registry";
import { createReminderTools } from "./reminders";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const all: ConversationToolCapabilities = {
  imageGeneration: true,
  memoryTools: true,
  dynamicTools: true,
  dailyTools: true,
  agreementTools: true,
  reminderTools: true,
};
const schema = ({
  name,
  description,
  parameters,
}: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}) => ({ name, description, parameters });
function fixture() {
  const f = scheduledFixture();
  stores.push(f.store);
  return f;
}

test("the complete catalog fits 16 tools without removing memory, with grouped focus writes and discoverable daily reads", () => {
  const f = fixture(),
    catalog = captureToolCatalog(f.store, all);
  expect(catalog.revision).toBe(CURRENT_TOOL_CATALOG);
  expect(catalog.schemas.map((tool) => tool.name)).toEqual([
    "generate_image",
    "memory_search",
    "memory_read",
    "memory_related",
    "topics_list",
    "conversation_search",
    "conversation_read",
    "activity_search",
    "memory_save",
    "growth_focus_read",
    "growth_focus_write",
    "daily_read",
    "daily_waking",
    "daily_progress",
    "agreement_write",
    "reminder_write",
  ]);
  expect(catalog.schemas).toHaveLength(16);
  const onlyReminders = captureToolCatalog(f.store, {
    ...all,
    imageGeneration: false,
    memoryTools: false,
    dynamicTools: false,
    dailyTools: false,
    agreementTools: false,
  });
  expect(onlyReminders.schemas.map((tool) => tool.name)).toEqual(["daily_read", "reminder_write"]);
  expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(128 * 1024);
});

test("new snapshots copy exact offered schemas and keep them across retries after runtime capabilities change", async () => {
  const f = fixture(),
    offered = captureToolCatalog(f.store, all);
  const marker = "Pinned fictional discovery wording.";
  required(offered.schemas.find((tool) => tool.name === "daily_read")).description = marker;
  const service = createConversationService(f.store, {
    ...all,
    now: f.now,
    captureToolCatalog: () => offered,
  });
  f.accept("Please show my fictional agreements.");
  const turn = required(service.startNextTurn());
  const serialized = JSON.stringify(turn.snapshot.toolCatalog);
  required(offered.schemas[0]).description = "Changed after capture.";
  expect(JSON.stringify(turn.snapshot.toolCatalog)).toBe(serialized);
  service.failGeneration(turn.id, { code: "fictional_retry", retryAt: f.now().toISOString() });
  const later = createConversationService(f.store, {
    now: f.now,
    captureToolCatalog: () => ({ revision: CURRENT_TOOL_CATALOG, schemas: [] }),
  });
  const retried = required(later.startNextTurn());
  expect(retried.id).toBe(turn.id);
  expect(JSON.stringify(retried.snapshot.toolCatalog)).toBe(serialized);
  const bound = bindConversationTools(f.store, retried.snapshot, { now: f.now });
  expect(bound.tools.map(schema)).toEqual(required(turn.snapshot.toolCatalog).schemas);
  const result = await createToolRegistry(f.store, bound.tools).execute(
    { id: "help", name: "daily_read", arguments: '{"mode":"help"}' },
    { turnId: turn.id, operationKey: "help", signal: new AbortController().signal },
    () => {},
  );
  expect(result).toMatchObject({
    status: "succeeded",
    result: {
      writeCapabilities: [
        "growth_focus_write",
        "daily_waking",
        "daily_progress",
        "agreement_write",
        "reminder_write",
      ],
    },
  });
});

test("pre-catalog snapshots retain the deployed legacy 16 contracts and cannot gain grouped writes", async () => {
  const f = fixture(),
    service = createConversationService(f.store, {
      now: f.now,
      memoryTools: true,
      dynamicTools: true,
      dailyTools: true,
      imageGeneration: true,
    });
  f.accept("A fictional legacy request.");
  const turn = required(service.startNextTurn());
  expect(turn.snapshot.toolCatalog).toBeUndefined();
  const bound = bindConversationTools(f.store, turn.snapshot, { now: f.now });
  expect(bound.tools.map(schema)).toEqual(legacy016.schemas);
  expect(bound.tools.map((tool) => tool.name)).not.toContain("agreement_write");
  expect(bound.tools.map((tool) => tool.name)).toContain("growth_focus_save");
  expect(bound.tools.map((tool) => tool.name)).not.toContain("growth_focus_write");
  const result = await createToolRegistry(f.store, bound.tools).execute(
    { id: "new", name: "reminder_write", arguments: "{}" },
    { turnId: turn.id, operationKey: "not-offered", signal: new AbortController().signal },
    () => {},
  );
  expect(result.status).toBe("rejected");
});

test("nested v1 reminder snapshots keep their old executable contract after v2 flattens new calls", async () => {
  const f = fixture();
  f.reminders.savePermissions({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageReminders: true,
  });
  const service = createConversationService(f.store, {
    now: f.now,
    reminderTools: true,
    captureToolCatalog: () => ({
      revision: "agreements-018-v1",
      schemas: createReminderTools(f.store, { legacyNested: true }).map(schema),
    }),
  });
  const source = f.accept("Please save a reminder for the fern."),
    turn = required(service.startNextTurn());
  const bound = bindConversationTools(f.store, turn.snapshot, { now: f.now }),
    registry = createToolRegistry(f.store, bound.tools);
  expect(bound.catalog.revision).toBe("agreements-018-v1");
  expect(bound.tools.map(schema)).toEqual(required(turn.snapshot.toolCatalog).schemas);
  const fields = { ...f.fields(), expiresAt: undefined, sourceIds: [source.sourceId] };
  const old = await registry.execute(
    {
      id: "legacy-save",
      name: "reminder_write",
      arguments: JSON.stringify({ action: "save", save: fields }),
    },
    { turnId: turn.id, operationKey: "old-save", signal: new AbortController().signal },
    () => {},
  );
  expect(old.status).toBe("succeeded");
  const wrongShape = await registry.execute(
    {
      id: "new-shape",
      name: "reminder_write",
      arguments: JSON.stringify({ action: "save", ...fields }),
    },
    { turnId: turn.id, operationKey: "wrong-shape", signal: new AbortController().signal },
    () => {},
  );
  expect(wrongShape).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  expect(f.reminders.list()).toHaveLength(1);
});

test("atomic practice fields exist only in the enabled new catalog and never expand a captured v2 schema", async () => {
  const f = fixture();
  const parameters = (tools: ReturnType<typeof captureToolCatalog>["schemas"]) =>
    required(tools.find((tool) => tool.name === "daily_progress")).parameters.properties as Record<
      string,
      unknown
    >;
  expect(parameters(captureToolCatalog(f.store, all).schemas).habitPractice).toBeDefined();
  expect(
    parameters(captureToolCatalog(f.store, { ...all, agreementTools: false }).schemas)
      .habitPractice,
  ).toBeUndefined();
  expect(
    parameters(createDailyTools(f.store, { habitPractice: true })).habitPractice,
  ).toBeUndefined();
  const oldCatalog = {
    revision: "agreements-018-v2",
    schemas: createDailyTools(f.store, { extended: true }).map(schema),
  };
  const service = createConversationService(f.store, {
    now: f.now,
    dailyTools: true,
    agreementTools: true,
    captureToolCatalog: () => oldCatalog,
  });
  f.accept("An older captured daily request.");
  const turn = required(service.startNextTurn()),
    bound = bindConversationTools(f.store, turn.snapshot, { now: f.now });
  expect(parameters(bound.tools).habitPractice).toBeUndefined();
  const result = await createToolRegistry(f.store, bound.tools).execute(
    {
      id: "extra",
      name: "daily_progress",
      arguments: JSON.stringify({
        action: "report",
        sourceIds: [turn.snapshot.inputSources?.[0]?.id],
        habitPractice: { habitId: "not-offered", definitionVersion: 1, variant: "smaller" },
      }),
    },
    { turnId: turn.id, operationKey: "not-offered", signal: new AbortController().signal },
    () => {},
  );
  expect(result).toMatchObject({ status: "rejected", code: "invalid_arguments" });
});

test("every actual invocation journals its exact catalog, including tool-free final calls and sanitized failures", async () => {
  const f = fixture();
  f.accept("A private fictional owner line.");
  const turn = required(f.conversations.startNextTurn()),
    measured = measureCompletion(f.store, {
      kind: "conversation",
      sourceId: turn.id,
      attempt: 1,
      catalogRevision: CURRENT_TOOL_CATALOG,
    });
  const tools = [
    {
      name: "daily_read",
      description: "Fictional exact schema receipt.",
      parameters: {
        type: "object",
        properties: { mode: { type: "string", enum: ["help"] } },
        required: ["mode"],
        additionalProperties: false,
      },
    },
  ];
  await measured([{ role: "user", content: "A private fictional owner line." }], tools, async () =>
    completion("", {
      finishReason: "tool_calls",
      complete: false,
      usage: { inputTokens: 51, outputTokens: 7 },
    }),
  );
  await measured(
    [{ role: "assistant", content: "An internal fictional step." }],
    undefined,
    async () => completion("A final answer.", { usage: { inputTokens: 70, outputTokens: 11 } }),
  );
  await expect(
    measured([], tools, async () => {
      throw new InferenceError("network");
    }),
  ).rejects.toThrow();
  const rows = f.store.db
    .query<
      { catalog: string; input: number | null; output: number | null; failure: string | null },
      []
    >(
      "SELECT tool_catalog_json AS catalog,input_tokens AS input,output_tokens AS output,failure_code AS failure FROM core_context_requests ORDER BY rowid",
    )
    .all();
  expect(rows).toHaveLength(3);
  expect(JSON.parse(required(rows[0]).catalog)).toEqual({
    revision: CURRENT_TOOL_CATALOG,
    schemas: tools,
  });
  expect(JSON.parse(required(rows[1]).catalog)).toEqual({
    revision: CURRENT_TOOL_CATALOG,
    schemas: [],
  });
  expect(rows.map(({ input, output }) => ({ input, output }))).toEqual([
    { input: 51, output: 7 },
    { input: 70, output: 11 },
    { input: null, output: null },
  ]);
  expect(rows[2]?.failure).toBe("network");
  const report = JSON.stringify(createContextHealthService(f.store).report());
  expect(report).not.toContain("Fictional exact schema receipt");
  expect(report).not.toContain("A private fictional owner line");
  expect(report).not.toContain("An internal fictional step");
});
