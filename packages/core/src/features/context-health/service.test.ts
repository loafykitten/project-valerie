import { afterEach, describe, expect, test } from "bun:test";
import { openStore, type Store } from "../../store";
import { migrateContextHealthSchema, migrateInferenceReceipts } from "./schema";
import { createContextHealthService } from "./service";
import type { ContextRequestInput } from "./types";

const stores: Store[] = [];
const instant = "2026-09-15T14:00:00.000Z";
const privateText = "Fictional private prose that must never appear in a context export.";
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  migrateContextHealthSchema(store.db);
  return { store, health: createContextHealthService(store, { now: () => new Date(instant) }) };
}

function snapshot(patch: Record<string, unknown> = {}) {
  return {
    capturedAt: instant,
    memoryToolsEnabled: true,
    settings: {
      model: "fictional-model",
      version: 3,
      reasoningEffort: "low",
      contextTokens: 32768,
      maxOutputTokens: 2048,
      capabilityCheckedAt: instant,
      modelCapabilities: { maxContextTokens: 131072 },
    },
    prompt: {
      content: privateText,
      postHistoryContent: "",
      orderVersion: 2,
      versions: { "fictional-character": 4 },
      prompts: [
        { id: "fictional-character", version: 4, title: privateText, content: privateText },
      ],
    },
    memory: {
      settings: { version: 5 },
      content: privateText,
      core: [{ body: privateText }],
      estimatedTokens: 240,
      coreTokens: 100,
      retrievedTokens: 80,
      topicTokens: 60,
    },
    messages: [{ role: "user", content: privateText }],
    contextBudget: {
      contextUnits: 32768,
      outputReserveUnits: 2048,
      safetyReserveUnits: 2048,
      toolReserveUnits: 12000,
      requiredUnits: 2000,
    },
    history: {
      since: "2026-09-13T14:00:00.000Z",
      includedTurns: 4,
      estimatedTokens: 1600,
      budgetTokens: 12000,
      truncated: false,
      includedImages: 0,
      omittedImages: 0,
    },
    ...patch,
  };
}

function turn(
  store: Store,
  id: string,
  input: {
    snapshot?: Record<string, unknown> | null;
    result?: Record<string, unknown>;
    attempts?: number;
    failureCode?: string;
    receivedAt?: string;
  } = {},
) {
  const updateId =
    store.db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM core_conversation_turns")
      .get()?.count ?? 0;
  store.db
    .query(`INSERT INTO core_conversation_turns(
    id,update_id,message_id,chat_id,sender_id,input_text,received_at,status,snapshot_json,
    result_json,attempts,failure_code
  ) VALUES(?,?,?,'1','1',?,?,'failed',?,?,?,?)`)
    .run(
      id,
      updateId,
      String(updateId),
      privateText,
      input.receivedAt ?? instant,
      input.snapshot === null ? null : JSON.stringify(input.snapshot ?? snapshot()),
      input.result ? JSON.stringify(input.result) : null,
      input.attempts ?? 1,
      input.failureCode ?? null,
    );
  if (input.result)
    store.db
      .query(`INSERT INTO core_conversation_results(
    id,turn_id,attempt,output_text,result_json,created_at
  ) VALUES(?,?,1,?,?,?)`)
      .run(`${id}-result`, id, privateText, JSON.stringify(input.result), instant);
}

function toolRound(store: Store, id: string, round: number, inputTokens: number | null) {
  store.db
    .query("INSERT INTO core_tool_rounds(turn_id,round,completion_json,created_at) VALUES(?,?,?,?)")
    .run(
      id,
      round,
      JSON.stringify({
        text: privateText,
        finishReason: "tool_calls",
        requestId: `${id}-round-${round}`,
        usage: { inputTokens, outputTokens: 10 },
        toolCalls: [{ arguments: privateText }],
      }),
      instant,
    );
}

function receipt(sourceId: string, patch: Partial<ContextRequestInput> = {}): ContextRequestInput {
  return {
    kind: "conversation",
    sourceId,
    attempt: 1,
    startedAt: instant,
    elapsedMs: 143,
    requestId: `${sourceId}-request`,
    finishReason: "stop",
    failureCode: null,
    usage: { inputTokens: 140, outputTokens: 15 },
    estimates: { estimator: "utf8-byte-upper-bound", messageUnits: 700, toolSchemaUnits: 100 },
    ...patch,
  };
}

describe("context health measurements", () => {
  test("persists actual tiers and costs per request without filling old or unknown receipts", () => {
    const { store, health } = setup();
    turn(store, "tiers");
    health.recordRequest(receipt("tiers"));
    health.recordRequest(receipt("tiers", { serviceTier: "flex", costUsd: 0.000013 }));
    health.recordRequest(receipt("tiers", { serviceTier: "standard", costUsd: 0 }));
    migrateInferenceReceipts(store.db);
    expect(
      createContextHealthService(store)
        .getSource("conversation", "tiers")
        ?.requests.map(({ serviceTier, costUsd }) => ({ serviceTier, costUsd })),
    ).toEqual([
      { serviceTier: null, costUsd: null },
      { serviceTier: "flex", costUsd: 0.000013 },
      { serviceTier: "standard", costUsd: 0 },
    ]);
    for (const patch of [{ costUsd: Number.NaN }, { costUsd: -1 }, { serviceTier: "invented" }])
      expect(() =>
        health.recordRequest(receipt("tiers", patch as Partial<ContextRequestInput>)),
      ).toThrow();
  });
  test("reconstructs a final legacy request only from a complete single-attempt journal", () => {
    const { store, health } = setup();
    turn(store, "legacy", {
      result: {
        requestId: "legacy-final",
        finishReason: "stop",
        usage: { inputTokens: 360, outputTokens: 35 },
      },
    });
    toolRound(store, "legacy", 0, 100);
    toolRound(store, "legacy", 1, 120);
    const report = health.getSource("conversation", "legacy");
    expect(report?.requests.map((request) => request.inputTokens)).toEqual([100, 120, 140]);
    expect(report?.requests[2]?.origin).toBe("reconstructed_final");
    expect(report?.peakInputTokens).toBe(140);
    expect(report?.cumulativeUsage.inputTokens).toBe(360);
    expect(report?.cumulativeUsageBasis).toBe("legacy_turn_result");
    expect(report?.requests[2]?.cachedInputTokens).toBeNull();
    expect(report?.requests[2]?.elapsedMs).toBeNull();
  });

  test("retries, missing rounds and legacy image-only repairs do not fabricate a request size", () => {
    const { store, health } = setup();
    const result = {
      requestId: "final",
      finishReason: "stop",
      usage: { inputTokens: 360, outputTokens: 35 },
    };
    turn(store, "retry", { result, attempts: 2 });
    toolRound(store, "retry", 0, 100);
    turn(store, "gap", { result });
    toolRound(store, "gap", 1, 120);
    turn(store, "images", {
      result,
      snapshot: snapshot({ memoryToolsEnabled: false, imageGenerationEnabled: true }),
    });
    expect(health.getSource("conversation", "retry")?.requests).toHaveLength(1);
    expect(health.getSource("conversation", "gap")?.requests).toHaveLength(1);
    expect(health.getSource("conversation", "images")?.requests).toHaveLength(0);
    for (const id of ["retry", "gap", "images"]) {
      expect(health.getSource("conversation", id)?.caveats).toContain(
        "legacy_final_request_unknown",
      );
      expect(health.getSource("conversation", id)?.peakInputTokens).not.toBe(360);
    }
  });

  test("missing counts remain unknown while independently known fields can be reconstructed", () => {
    const { store, health } = setup();
    turn(store, "missing", {
      result: {
        requestId: "missing-final",
        finishReason: "stop",
        usage: { inputTokens: 240, outputTokens: 30 },
      },
    });
    toolRound(store, "missing", 0, null);
    const source = health.getSource("conversation", "missing");
    expect(source?.requests[1]?.inputTokens).toBeNull();
    expect(source?.requests[1]?.outputTokens).toBe(20);
    expect(source?.peakInputTokens).toBeNull();
    expect(source?.caveats).toContain("provider_usage_incomplete");
  });

  test("new receipt totals count actual calls once and keep attempts, timing and estimates separate", () => {
    const { store, health } = setup();
    turn(store, "new", {
      result: { requestId: "new-request", finishReason: "stop", usage: { inputTokens: 240 } },
    });
    toolRound(store, "new", 0, 100);
    health.recordRequest(
      receipt("new", {
        requestId: "new-round-0",
        finishReason: "tool_calls",
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
    );
    health.recordRequest(
      receipt("new", {
        attempt: 2,
        usage: { inputTokens: 140, outputTokens: null, reasoningTokens: 5 },
      }),
    );
    const source = health.getSource("conversation", "new");
    expect(source?.requests).toHaveLength(2);
    expect(source?.requests.map((entry) => entry.origin)).toEqual(["recorded", "recorded"]);
    expect(source?.requests[1]?.attempt).toBe(2);
    expect(source?.requests[1]?.elapsedMs).toBe(143);
    expect(source?.peakInputTokens).toBe(140);
    expect(source?.cumulativeUsage.inputTokens).toBe(240);
    expect(source?.cumulativeUsage.outputTokens).toBeNull();
    expect(source?.cumulativeUsageBasis).toBe("recorded_requests");
    expect(source?.requests[0]?.estimates?.messageUnits).toBe(700);
  });

  test("receipts require real source records, one outcome, numeric usage and immutable persistence", () => {
    const { store, health } = setup();
    turn(store, "validation");
    expect(() => health.recordRequest(receipt("missing"))).toThrow();
    expect(() => health.recordRequest(receipt("validation", { failureCode: "deadline" }))).toThrow(
      TypeError,
    );
    expect(() =>
      health.recordRequest(receipt("validation", { usage: { inputTokens: -1 } })),
    ).toThrow(TypeError);
    const saved = health.recordRequest(
      receipt("validation", { finishReason: null, failureCode: "deadline", usage: null }),
    );
    expect(saved.inputTokens).toBeNull();
    expect(() =>
      store.db.query("UPDATE core_context_requests SET input_tokens=3 WHERE id=?").run(saved.id),
    ).toThrow("immutable");
    expect(() =>
      store.db.query("DELETE FROM core_context_requests WHERE id=?").run(saved.id),
    ).toThrow("retained");
    migrateContextHealthSchema(store.db);
    expect(health.getSource("conversation", "validation")?.requests).toHaveLength(1);
  });
});

describe("context pressure classification and privacy", () => {
  test("age expiry, omitted media and old ambiguous flags are not classified as input pressure", () => {
    const { store, health } = setup();
    turn(store, "old", { snapshot: snapshot({ history: { truncated: true } }) });
    turn(store, "age", {
      snapshot: snapshot({
        history: {
          truncated: true,
          omissionReasons: ["age_window", "media_limit", "unconfirmed_exchange"],
        },
      }),
    });
    turn(store, "size", {
      snapshot: snapshot({ history: { truncated: true, omissionReasons: ["size_budget"] } }),
    });
    expect(health.getSource("conversation", "old")?.signals).toEqual([]);
    expect(health.getSource("conversation", "old")?.history.omissionReasons).toEqual([
      "unclassified",
    ]);
    expect(health.getSource("conversation", "age")?.signals).toEqual([]);
    expect(health.getSource("conversation", "size")?.signals).toEqual(["history_size_budget"]);
    expect(health.report().summary.pressureSources).toBe(1);
  });

  test("fixed prompt, provider context refusal, tool continuation and output exhaustion are distinct", () => {
    const { store, health } = setup();
    turn(store, "fixed", { snapshot: null, failureCode: "context_budget_exceeded" });
    turn(store, "core", { snapshot: null, failureCode: "core_memory_budget_exceeded" });
    turn(store, "provider");
    health.recordRequest(
      receipt("provider", { finishReason: null, failureCode: "context_overflow", usage: null }),
    );
    turn(store, "tool");
    store.db
      .query(
        "INSERT INTO core_activity(id,kind,summary,status,created_at,metadata_json) VALUES('tool-event','context.tool_budget',?,'failed',?,?)",
      )
      .run(privateText, instant, JSON.stringify({ turnId: "tool", privateText }));
    turn(store, "output", {
      result: {
        requestId: "length-final",
        finishReason: "length",
        usage: { inputTokens: 140, outputTokens: 2048, reasoningTokens: 2048 },
      },
    });
    turn(store, "generic", { failureCode: "configuration" });
    expect(health.getSource("conversation", "fixed")?.signals).toEqual(["fixed_context_budget"]);
    expect(health.getSource("conversation", "core")?.signals).toEqual(["core_memory_budget"]);
    expect(health.getSource("conversation", "provider")?.signals).toEqual([
      "provider_context_refusal",
    ]);
    expect(health.getSource("conversation", "tool")?.signals).toEqual(["tool_context_budget"]);
    expect(health.getSource("conversation", "output")?.signals).toEqual([
      "output_budget_exhausted",
    ]);
    expect(health.getSource("conversation", "generic")?.signals).toEqual([]);
    const summary = health.report().summary;
    expect(summary.pressureSources).toBe(4);
    expect(summary.outputExhaustedSources).toBe(1);
  });

  test("heartbeat generation receipts include silence and failures without exposing generated text", () => {
    const { store, health } = setup();
    store.db
      .query(`INSERT INTO core_heartbeat_runs(
      id,chat_id,status,fence,lease_owner,settings_json,input_watermark,waking_day,
      snapshot_json,result_json,created_at,updated_at
    ) VALUES('heartbeat','1','silent','fence','worker','{}',1,'2026-09-15',?,?,?,?)`)
      .run(
        JSON.stringify(snapshot({ kind: "heartbeat" })),
        JSON.stringify({
          text: privateText,
          requestId: "heartbeat-request",
          finishReason: "stop",
          usage: { inputTokens: 90, outputTokens: 30, reasoningTokens: 5 },
        }),
        instant,
        instant,
      );
    const source = health.getSource("heartbeat", "heartbeat");
    expect(source?.requests[0]?.origin).toBe("legacy_single_request");
    expect(source?.peakInputTokens).toBe(90);
    expect(source?.estimates.currentInputUnits).toBeNull();
    expect(JSON.stringify(source)).not.toContain(privateText);
  });

  test("export has bounded measurements and references, no private prompts, messages, tool arguments or bodies", () => {
    const { store, health } = setup();
    turn(store, "private", {
      result: {
        text: privateText,
        providerBody: privateText,
        requestId: "private-final",
        finishReason: "stop",
        usage: { inputTokens: 200, outputTokens: 30 },
      },
    });
    toolRound(store, "private", 0, 100);
    const report = health.report({ notificationDelivery: "enabled" });
    const exported = JSON.stringify(report);
    expect(exported).not.toContain(privateText);
    expect(exported).not.toContain("providerBody");
    expect(report.sources[0]?.promptVersions).toEqual({ "fictional-character": 4 });
    expect(report.sources[0]?.contextBudget?.requiredUnits).toBe(2000);
    expect(report.sources[0]?.estimates.promptSections[0]?.textUnits).toBe(
      Buffer.byteLength(privateText),
    );
    expect(report.qualityThreshold).toEqual({ status: "uncalibrated", inputTokens: null });
    expect(report.notificationDelivery).toBe("enabled");
    expect(() => health.report({ limit: 51 })).toThrow(TypeError);
    expect(() => health.report({ limit: 0 })).toThrow(TypeError);
    turn(store, "newest", { receivedAt: "2026-09-15T15:00:00.000Z" });
    expect(health.report({ limit: 1 }).sources.map((entry) => entry.id)).toEqual(["newest"]);
  });
});
