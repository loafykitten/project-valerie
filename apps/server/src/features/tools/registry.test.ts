import { afterEach, describe, expect, test } from "bun:test";
import { openStore, type Store } from "@valerie/core";
import { createToolRegistry, type RegisteredTool, type ToolOutcome } from "./registry";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const definition = (execute: RegisteredTool["execute"]): RegisteredTool => ({
  name: "fictional_read",
  description: "A fictional read.",
  effect: "read",
  allowedTurnKinds: ["user"],
  timeoutMs: 20,
  maxOutputBytes: 512,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string", minLength: 1, maxLength: 10 } },
    required: ["query"],
  },
  outputSchema: { type: "object", additionalProperties: true },
  execute,
});
function setup(tool: RegisteredTool) {
  const store = openStore(":memory:");
  stores.push(store);
  const results: ToolOutcome[] = [];
  const registry = createToolRegistry(store, [tool]);
  const context = {
    turnId: "fictional-turn",
    operationKey: "fictional-operation",
    signal: new AbortController().signal,
  };
  const call = { id: "call", name: tool.name, arguments: '{"query":"hello"}' };
  return {
    store,
    results,
    registry,
    context,
    call,
    commit: (outcome: ToolOutcome) => {
      results.push(outcome);
    },
  };
}

describe("bounded feature tool registry", () => {
  test("rejects malformed, unknown, extra-field, wrong-kind and external actions before execution", async () => {
    let executions = 0;
    const fixture = setup(
      definition(() => {
        executions++;
        return {};
      }),
    );
    for (const call of [
      { ...fixture.call, arguments: "{" },
      { ...fixture.call, arguments: '{"query":"hello","__proto__":{}}' },
      { ...fixture.call, name: "unavailable" },
      { ...fixture.call, arguments: '{"query":7}' },
    ])
      expect((await fixture.registry.execute(call, fixture.context, fixture.commit)).status).toBe(
        "rejected",
      );
    expect(
      await fixture.registry.execute(
        fixture.call,
        { ...fixture.context, turnKind: "reflection" },
        fixture.commit,
      ),
    ).toMatchObject({ code: "unavailable_tool" });
    const external = setup({
      ...definition(() => {
        executions++;
        return {};
      }),
      effect: "external_write",
    });
    expect(
      await external.registry.execute(external.call, external.context, external.commit),
    ).toMatchObject({ code: "permission_denied" });
    expect(executions).toBe(0);
  });

  test("read timeout and cancellation settle once without exposing exception details", async () => {
    let finish: ((value: unknown) => void) | undefined;
    const fixture = setup({
      ...definition(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      timeoutMs: 2,
    });
    expect(
      await fixture.registry.execute(fixture.call, fixture.context, fixture.commit),
    ).toMatchObject({ status: "failed", code: "tool_timeout" });
    finish?.({ late: true });
    await Promise.resolve();
    expect(fixture.results).toHaveLength(1);
    const abort = new AbortController();
    abort.abort();
    expect(
      await fixture.registry.execute(
        fixture.call,
        { ...fixture.context, signal: abort.signal },
        fixture.commit,
      ),
    ).toMatchObject({ code: "cancelled" });
    const error = setup(
      definition(() => {
        throw new Error("private vault path and credential");
      }),
    );
    expect(await error.registry.execute(error.call, error.context, error.commit)).toEqual({
      status: "failed",
      code: "tool_failed",
    });
  });

  test("output overflow rolls back a SQLite mutation and commits only its failure", async () => {
    let store: Store;
    const fixture = setup({
      ...definition(() => {
        store.db.query("INSERT INTO fictional_mutation(value) VALUES (?)").run("written");
        return { content: "x".repeat(2000) };
      }),
      effect: "local_write",
    });
    store = fixture.store;
    store.db.exec("CREATE TABLE fictional_mutation(value TEXT)");
    const outcome = await fixture.registry.execute(fixture.call, fixture.context, fixture.commit);
    expect(outcome.status).toBe("failed");
    expect(store.db.query("SELECT count(*) AS count FROM fictional_mutation").get()).toEqual({
      count: 0,
    });
    expect(fixture.results).toEqual([outcome]);
  });
});
