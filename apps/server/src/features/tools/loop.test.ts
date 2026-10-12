import { afterEach, describe, expect, test } from "bun:test";
import {
  createActivityService,
  createConversationService,
  createMemoryService,
  openStore,
  type Store,
} from "@valerie/core";
import type { ChatMessage, TextCompletion, ToolCall } from "@valerie/inference";
import { estimateToolContext, runConversationTools, sumToolUsage } from "./loop";
import { memoryToolDefinitions } from "./memory";
import { createToolRegistry, type RegisteredTool } from "./registry";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  createConversationService(store).acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "123",
        senderId: "123",
        text: "I prefer a written checklist.",
      },
    ],
  });
  const row = store.db
    .query<{ id: string; turnId: string }, []>(
      "SELECT id,turn_id AS turnId FROM core_telegram_inputs",
    )
    .get();
  if (!row) throw new Error("Fixture missing input.");
  return { store, turnId: row.turnId, sourceId: `conversation:${row.id}` };
}
const completion = (toolCalls?: ToolCall[], input = 10): TextCompletion => ({
  text: toolCalls ? "Unconfirmed work claim." : "Fictional final reply.",
  complete: !toolCalls,
  finishReason: toolCalls ? "tool_calls" : "stop",
  ...(toolCalls ? { toolCalls } : {}),
  usage: { inputTokens: input, outputTokens: 5 },
  requestId: "fictional-provider",
  costUsd: null,
});
const call = (name: string, args: unknown = {}): ToolCall => ({
  id: "reused-provider-id",
  name,
  arguments: JSON.stringify(args),
});
function run(
  fixture: ReturnType<typeof setup>,
  complete: Parameters<typeof runConversationTools>[0]["complete"],
  tools = memoryToolDefinitions(fixture.store),
) {
  return runConversationTools({
    ...fixture,
    signal: new AbortController().signal,
    contextTokens: 262144,
    maxOutputTokens: 2048,
    tools,
    messages: [{ role: "user", content: "I prefer a written checklist." }],
    complete,
  });
}

describe("durable memory tool loop", () => {
  test("cumulative tier is known only when every invocation agrees", () => {
    const result: TextCompletion = {
      text: "done",
      complete: true,
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2 },
      costUsd: 0.01,
      requestId: "fixture",
      serviceTier: "flex",
    };
    expect(sumToolUsage(result, result)).toMatchObject({ serviceTier: "flex", costUsd: 0.02 });
    for (const tier of ["standard", null, undefined] as const)
      expect(sumToolUsage({ ...result, serviceTier: tier }, result)).toMatchObject({
        serviceTier: null,
      });
    const mixed = sumToolUsage(result, { ...result, serviceTier: "standard" });
    expect(sumToolUsage(mixed, result).serviceTier).toBeNull();
  });
  test("broad recall accepts an empty memory query through the actual tool registry", async () => {
    const fixture = setup(),
      memory = createMemoryService(fixture.store);
    const saved = memory.save({
      tier: "short",
      kind: "preference",
      title: "Quiet evenings",
      body: "Ember enjoys quiet evenings.",
    });
    const registry = createToolRegistry(fixture.store, memoryToolDefinitions(fixture.store));
    const outcome = await registry.execute(
      call("memory_search", { query: "" }),
      {
        turnId: fixture.turnId,
        operationKey: "browse",
        signal: new AbortController().signal,
      },
      () => {},
    );
    expect(outcome.status).toBe("succeeded");
    expect((outcome.result as { items: { id: string }[] }).items.map((item) => item.id)).toContain(
      saved.id,
    );
  });
  test("duplicates identify the existing note and stale search cursors explain how to restart", async () => {
    const fixture = setup(),
      memory = createMemoryService(fixture.store);
    const registry = createToolRegistry(fixture.store, memoryToolDefinitions(fixture.store));
    const context = {
      turnId: fixture.turnId,
      operationKey: "first",
      signal: new AbortController().signal,
    };
    const args = {
      title: "Checklist preference",
      body: "Ember prefers written checklists.",
      kind: "preference",
      sourceIds: [fixture.sourceId],
    };
    const first = await registry.execute(call("memory_save", args), context, () => {});
    const record = first.result as { id: string; version: number };
    const duplicate = await registry.execute(
      call("memory_save", args),
      { ...context, operationKey: "duplicate" },
      () => {},
    );
    expect(duplicate).toMatchObject({
      status: "rejected",
      reason: "duplicate_memory",
      existingMemory: { id: record.id, version: record.version },
    });
    expect(memory.status().shortRecords).toBe(1);
    memory.save({
      title: "Second checklist",
      body: "Another fictional checklist.",
      kind: "fact",
      tier: "short",
    });
    const page = memory.search({ query: "checklist", limit: 1 });
    expect(page.nextCursor).toBeTruthy();
    memory.save({
      title: "Third checklist",
      body: "A third fictional checklist.",
      kind: "fact",
      tier: "short",
    });
    const stale = await registry.execute(
      call("memory_search", { query: "checklist", limit: 1, cursor: page.nextCursor }),
      context,
      () => {},
    );
    expect(stale).toMatchObject({
      status: "rejected",
      code: "invalid_arguments",
      field: "cursor",
      reason: "stale_cursor",
    });
    expect(
      (
        await registry.execute(
          call("memory_search", { query: "checklist", limit: 1 }),
          context,
          () => {},
        )
      ).status,
    ).toBe("succeeded");
  });

  test("an unavailable source can be repaired before saving a synthesized memory", async () => {
    const fixture = setup();
    const memory = createMemoryService(fixture.store);
    let requests = 0;
    await run(fixture, async (messages) => {
      requests++;
      const args = {
        kind: "preference",
        title: "Written checklists",
        body: "Ember prefers a written checklist.",
        thoughts: "A short checklist might help with an unfamiliar task.",
        sourceIds: [fixture.sourceId],
      };
      if (requests === 1)
        return completion([call("memory_save", { ...args, sourceIds: ["conversation:missing"] })]);
      const outcomes = messages
        .filter((message) => message.role === "tool")
        .map((message) => JSON.parse(String(message.content)));
      expect(outcomes[0]).toMatchObject({
        status: "rejected",
        code: "invalid_arguments",
        field: "sourceIds",
        reason: "source_unavailable",
      });
      if (requests === 2) {
        expect(memory.search({ query: "", source: "records" }).items).toHaveLength(0);
        return completion([call("memory_save", args)]);
      }
      expect(outcomes[1]).toMatchObject({
        status: "succeeded",
        result: { tier: "short", title: args.title, version: 1, sourceCount: 1, hasThoughts: true },
      });
      expect(memory.read({ id: outcomes[1].result.id })).toMatchObject({
        body: args.body,
        thoughts: args.thoughts,
        provenance: [{ sourceId: fixture.sourceId }],
      });
      return completion();
    });
    expect(requests).toBe(3);
    expect(
      fixture.store.db.query("SELECT effect FROM core_tool_outcomes ORDER BY round").all(),
    ).toEqual([{ effect: "rejected" }, { effect: "local_write" }]);
  });

  test("an empty optional title reaches the safe fallback without spending a correction", async () => {
    const fixture = setup();
    const registry = createToolRegistry(fixture.store, memoryToolDefinitions(fixture.store));
    const outcome = await registry.execute(
      call("memory_save", {
        title: "",
        body: "I prefer a written checklist.",
        kind: "preference",
        sourceIds: [fixture.sourceId],
      }),
      { turnId: fixture.turnId, operationKey: "empty-title", signal: new AbortController().signal },
      () => {},
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      result: {
        title: "I prefer a written checklist.",
        tier: "short",
      },
    });
  });

  test("archived memory reads require an explicit historical lookup", async () => {
    const fixture = setup();
    const memory = createMemoryService(fixture.store);
    const record = memory.save({
      title: "Fictional retired preference",
      body: "A fictional earlier preference.",
      tier: "short",
      kind: "preference",
    });
    memory.archive({ id: record.id, expectedVersion: record.version });
    const registry = createToolRegistry(fixture.store, memoryToolDefinitions(fixture.store));
    const execute = (name: string, args: unknown) =>
      registry.execute(
        call(name, args),
        {
          turnId: fixture.turnId,
          operationKey: "archive-read",
          signal: new AbortController().signal,
        },
        () => {},
      );
    expect((await execute("memory_read", { id: record.id })).result).toEqual({ found: false });
    expect(
      (await execute("memory_read", { id: record.id, includeArchive: true })).result,
    ).toMatchObject({ id: record.id, state: "archived" });
    expect((await execute("memory_related", { id: record.id })).result).toMatchObject({
      items: [],
    });
  });

  test("activity lookup exposes actual statuses without private metadata, including old pending work", async () => {
    const fixture = setup();
    const activity = createActivityService(fixture.store);
    const old = activity.append({
      kind: "fictional.old",
      summary: "Fictional unfinished work",
      status: "pending",
      metadata: { private: "never expose" },
    });
    fixture.store.db
      .query("UPDATE core_activity SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?")
      .run(old.id);
    const registry = createToolRegistry(fixture.store, memoryToolDefinitions(fixture.store));
    const execute = (args: unknown) =>
      registry.execute(
        call("activity_search", args),
        {
          turnId: fixture.turnId,
          operationKey: "activity-read",
          signal: new AbortController().signal,
        },
        () => {},
      );
    expect((await execute({ query: "fictional" })).result).toMatchObject({
      items: [],
      window: "last_seven_days",
    });
    const pending = await execute({ outstanding: true });
    expect(pending.result).toMatchObject({
      items: [{ id: old.id, status: "pending" }],
      window: "pending_any_age",
    });
    expect(JSON.stringify(pending)).not.toContain("never expose");
    expect(JSON.stringify(pending)).not.toContain("metadata");
  });

  test("near the configured context limit, bounded results and oversized proposals still finish within the cap", async () => {
    for (const oversizedArguments of [false, true]) {
      const fixture = setup();
      let writes = 0;
      let requests = 0;
      const tool: RegisteredTool = {
        name: "fictional_read",
        description: "Fictional read",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string", maxLength: 8192 } },
          required: ["query"],
        },
        outputSchema: { type: "object", additionalProperties: true },
        effect: "read",
        allowedTurnKinds: ["user"],
        timeoutMs: 20,
        maxOutputBytes: 16000,
        execute: () => {
          writes++;
          return { text: "🐺".repeat(2000) };
        },
      };
      const contextTokens = 10000,
        maxOutputTokens = 1000;
      await runConversationTools({
        ...fixture,
        signal: new AbortController().signal,
        contextTokens,
        maxOutputTokens,
        tools: [tool],
        messages: [{ role: "user", content: "x".repeat(5000) }],
        complete: async (messages, tools) => {
          requests++;
          expect(estimateToolContext(messages) + maxOutputTokens).toBeLessThanOrEqual(
            contextTokens,
          );
          if (requests === 1) {
            expect(tools).toHaveLength(1);
            return completion([
              call(tool.name, { query: oversizedArguments ? "x".repeat(8000) : "small" }),
            ]);
          }
          if (oversizedArguments) expect(tools).toBeUndefined();
          return completion();
        },
      });
      expect(writes).toBe(oversizedArguments ? 0 : 1);
      expect(requests).toBe(2);
      expect(
        fixture.store.db
          .query<{ outcome_json: string }, []>("SELECT outcome_json FROM core_tool_outcomes")
          .get()?.outcome_json,
      ).toContain(oversizedArguments ? "context_budget" : "output_limit");
    }
  });

  test("a provider retry reuses exact read results and the committed save without model reselection", async () => {
    const fixture = setup();
    const memory = createMemoryService(fixture.store);
    memory.save({
      tier: "core",
      kind: "preference",
      title: "Fictional tea",
      body: "Fictional tea in a blue cup.",
    });
    let requests = 0;
    let originalRead = "";
    const complete = async (messages: ChatMessage[]) => {
      requests++;
      if (requests === 1) return completion([call("memory_search", { query: "tea", limit: 2 })]);
      const results = messages.filter((message) => message.role === "tool");
      if (requests === 2) {
        originalRead = String(results[0]?.content);
        return completion([
          call("memory_save", {
            kind: "preference",
            title: "written checklist",
            body: "I prefer a written checklist.",
            sourceIds: [fixture.sourceId],
          }),
        ]);
      }
      expect(results[0]?.content).toBe(originalRead);
      expect(
        messages
          .filter((message) => message.tool_calls)
          .map((message) => message.tool_calls?.[0]?.id),
      ).toEqual(["valerie.r0.c0", "valerie.r1.c0"]);
      expect(JSON.stringify(messages)).not.toContain("Unconfirmed work claim");
      if (requests === 3) throw new Error("Fictional provider outage");
      return completion(undefined, 20);
    };
    await expect(run(fixture, complete)).rejects.toThrow("Fictional provider outage");
    const note = memory.search({ query: "checklist" }).items[0];
    expect(note?.tier).toBe("short");
    memory.save({
      tier: "core",
      kind: "fact",
      title: "New tea",
      body: "New tea after the paused turn.",
    });
    const result = await run(fixture, complete);
    expect(requests).toBe(4);
    expect(result.usage.inputTokens).toBe(40);
    expect(result.costUsd).toBeNull();
    expect(
      fixture.store.db.query("SELECT count(*) AS count FROM core_memory_operations").get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.store.db.query("SELECT count(*) AS count FROM core_tool_outcomes").get(),
    ).toEqual({ count: 2 });
  });

  test("six rounds and twelve calls force a truthful final reply with all result pairs", async () => {
    for (const callsPerRound of [1, 4]) {
      const fixture = setup();
      let executions = 0;
      const tool: RegisteredTool = {
        name: "fictional_read",
        description: "Read fixture.",
        parameters: { type: "object", additionalProperties: false },
        outputSchema: { type: "object", additionalProperties: true },
        effect: "read",
        allowedTurnKinds: ["user"],
        timeoutMs: 20,
        maxOutputBytes: 512,
        execute: () => {
          executions++;
          return { value: "Fictional evidence." };
        },
      };
      const result = await run(
        fixture,
        async (messages, tools) => {
          if (tools)
            return completion(
              Array.from({ length: callsPerRound }, (_, index) => ({
                ...call(tool.name),
                id: `call-${index}`,
              })),
            );
          expect(messages.at(-1)?.content).toContain("No more tools");
          expect(messages.filter((message) => message.role === "tool")).toHaveLength(
            callsPerRound === 1 ? 6 : 12,
          );
          return completion();
        },
        [tool],
      );
      expect(result.complete).toBe(true);
      expect(executions).toBe(callsPerRound === 1 ? 6 : 12);
    }
  });

  test("one malformed correction is allowed and unavailable references cannot save a new fact", async () => {
    const fixture = setup();
    let requests = 0;
    await run(fixture, async (messages, tools) => {
      requests++;
      if (requests === 1) return completion([{ ...call("memory_search"), arguments: "{" }]);
      if (requests === 2) {
        expect(messages.at(-1)?.content).toContain("one correction attempt");
        return completion([
          call("memory_save", {
            kind: "fact",
            title: "written checklist",
            body: "I prefer a written checklist.",
            sourceIds: ["conversation:some-old-message"],
          }),
        ]);
      }
      expect(tools).toBeUndefined();
      expect(messages.at(-1)?.content).toContain("argument_repair_limit");
      return completion();
    });
    expect(requests).toBe(3);
    expect(
      fixture.store.db.query("SELECT count(*) AS count FROM core_memory_operations").get(),
    ).toEqual({ count: 0 });
  });
});
