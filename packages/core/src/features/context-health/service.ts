import { isRecord } from "../../guards";
import type { Store } from "../../store";
import { IMAGE_TOKEN_ALLOWANCE } from "../conversations/images";
import { validateConversationToolCatalog } from "../tools/catalog";
import {
  type ContextBudget,
  type ContextHealthReport,
  type ContextOmissionReason,
  type ContextRequestInput,
  type ContextRequestRecord,
  type ContextSignal,
  type ContextSourceKind,
  type ContextSourceReport,
  type ContextTokenUsage,
  contextFailureCodes,
  contextOmissionReasons,
} from "./types";

const maxSnapshotBytes = 8 * 1024 * 1024;
const maxRequestsPerSource = 100;
const tokenKeys = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"] as const;
const safeId = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z0-9_.:/-]{1,200}$/i.test(value) ? value : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const object = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const bytes = (value: unknown): number | null =>
  typeof value === "string" ? Buffer.byteLength(value, "utf8") : null;

function parsed(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function usage(value: unknown): ContextTokenUsage {
  const source = object(value);
  return {
    inputTokens: count(source.inputTokens),
    outputTokens: count(source.outputTokens),
    cachedInputTokens: count(source.cachedInputTokens),
    reasoningTokens: count(source.reasoningTokens),
  };
}

function sumUsage(values: ContextTokenUsage[]): ContextTokenUsage {
  const result = usage(null);
  for (const key of tokenKeys) {
    const counts = values.map((entry) => entry[key]);
    const sum = counts.reduce<number>((total, value) => total + (value ?? 0), 0);
    result[key] =
      counts.length && counts.every((value) => value !== null) && Number.isSafeInteger(sum)
        ? sum
        : null;
  }
  return result;
}

function finishReason(value: unknown): ContextRequestRecord["finishReason"] {
  return value === "stop" || value === "length" || value === "tool_calls" ? value : null;
}

function failureCode(value: unknown): ContextRequestRecord["failureCode"] {
  return typeof value === "string" && contextFailureCodes.some((code) => code === value)
    ? (value as ContextRequestRecord["failureCode"])
    : null;
}

function budget(value: unknown): ContextBudget | null {
  const source = object(value);
  const keys = [
    "contextUnits",
    "outputReserveUnits",
    "safetyReserveUnits",
    "toolReserveUnits",
    "requiredUnits",
  ] as const;
  if (keys.some((key) => count(source[key]) === null)) return null;
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as unknown as ContextBudget;
}

interface SourceRow {
  id: string;
  kind: ContextSourceKind;
  occurredAt: string;
  status: string;
  attempts: number;
  failureCode: string | null;
  snapshotJson: string | null;
  snapshotOversize: number;
  resultJson: string | null;
  resultCount: number;
}

interface RequestRow {
  serviceTier: "flex" | "standard" | null;
  costUsd: number | null;
  id: string;
  attempt: number;
  startedAt: string;
  elapsedMs: number;
  requestId: string | null;
  finishReason: string | null;
  failureCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  messageUnits: number;
  toolSchemaUnits: number;
}

function sourceSelect(kind: ContextSourceKind): string {
  const conversation = kind === "conversation";
  return `
  SELECT id, '${kind}' AS kind, ${conversation ? "received_at" : "created_at"} AS occurredAt,
    status, ${conversation ? "attempts" : "1"} AS attempts,
    ${conversation ? "failure_code" : "reason"} AS failureCode,
    CASE WHEN length(CAST(snapshot_json AS BLOB))<=${maxSnapshotBytes} THEN snapshot_json END AS snapshotJson,
    coalesce(length(CAST(snapshot_json AS BLOB))>${maxSnapshotBytes},0) AS snapshotOversize,
    CASE WHEN json_valid(result_json) THEN json_object(
      'usage',json_extract(result_json,'$.usage'),
      'finishReason',json_extract(result_json,'$.finishReason'),
      'requestId',json_extract(result_json,'$.requestId')
    ) END AS resultJson,
    ${conversation ? "(SELECT count(*) FROM core_conversation_results WHERE turn_id=core_conversation_turns.id)" : "CASE WHEN result_json IS NULL THEN 0 ELSE 1 END"} AS resultCount
  FROM ${conversation ? "core_conversation_turns" : "core_heartbeat_runs"} WHERE id=? LIMIT 1
  `;
}

function snapshotDetails(snapshot: Record<string, unknown>, kind: ContextSourceKind) {
  const settings = object(snapshot.settings);
  const prompt = object(snapshot.prompt);
  const memory = object(snapshot.memory);
  const history = object(snapshot.history);
  const promptVersions: Record<string, number> = {};
  for (const [id, version] of Object.entries(object(prompt.versions)).slice(0, 100)) {
    if (safeId(id) && count(version) !== null) promptVersions[id] = version as number;
  }
  const sections: ContextSourceReport["estimates"]["promptSections"] = [];
  for (const entry of array(prompt.prompts).slice(0, 100)) {
    const section = object(entry);
    const id = safeId(section.id);
    const version = count(section.version);
    const textUnits = bytes(section.content);
    if (id && version !== null && textUnits !== null) sections.push({ id, version, textUnits });
  }
  const omissions = array(history.omissionReasons).filter(
    (reason): reason is ContextOmissionReason =>
      contextOmissionReasons.some((known) => known === reason),
  );
  // Earlier releases used this flag for size, unavailable replies, images and row limits.
  if (history.truncated === true && !Array.isArray(history.omissionReasons))
    omissions.push("unclassified");
  const includedImages = count(history.includedImages);
  const imageAllowance = count(history.imageTokenAllowance) ?? IMAGE_TOKEN_ALLOWANCE;
  const currentInput =
    kind === "conversation"
      ? [...array(snapshot.messages)]
          .reverse()
          .map(object)
          .find((entry) => entry.role === "user")
      : undefined;
  const parts = array(currentInput?.content).map(object);
  const currentImages = parts.filter((part) => part.type === "image").length;
  const currentText =
    bytes(currentInput?.content) ??
    (currentInput
      ? parts.reduce((sum, part) => sum + (part.type === "text" ? (bytes(part.text) ?? 0) : 0), 0)
      : null);
  const prefixBytes = bytes(prompt.content);
  const suffixBytes = bytes(prompt.postHistoryContent);
  return {
    model: safeId(settings.model),
    reasoningEffort: safeId(settings.reasoningEffort),
    settingsVersion: count(settings.version),
    capabilityCheckedAt: date(settings.capabilityCheckedAt),
    modelContextTokens: count(object(settings.modelCapabilities).maxContextTokens),
    applicationContextUnits: count(settings.contextTokens),
    outputReserveTokens: count(settings.maxOutputTokens),
    promptOrderVersion: count(prompt.orderVersion),
    promptVersions,
    memorySettingsVersion: count(object(memory.settings).version),
    contextBudget: budget(snapshot.contextBudget),
    estimates: {
      estimator: "utf8-byte-upper-bound" as const,
      promptTextUnits:
        prefixBytes !== null && suffixBytes !== null ? prefixBytes + suffixBytes : null,
      promptSections: sections,
      memoryUnits: count(memory.estimatedTokens),
      coreMemoryUnits: count(memory.coreTokens),
      retrievedMemoryUnits: count(memory.retrievedTokens),
      memoryTopicUnits: count(memory.topicTokens),
      currentInputUnits:
        currentText === null
          ? null
          : currentText + currentImages * imageAllowance + (snapshot.memoryToolsEnabled ? 32 : 16),
      currentInputImageUnits: currentInput ? currentImages * imageAllowance : null,
      historyImageUnits: includedImages === null ? null : includedImages * imageAllowance,
    },
    history: {
      since: date(history.since),
      estimatedUnits: count(history.estimatedTokens),
      budgetUnits: count(history.budgetTokens),
      includedTurns: count(history.includedTurns),
      includedOwnerMessages: count(history.includedOwnerMessages),
      includedAssistantMessages: count(history.includedAssistantMessages),
      includedImages,
      omittedImages: count(history.omittedImages),
      truncated: typeof history.truncated === "boolean" ? history.truncated : null,
      omissionReasons: [...new Set(omissions)],
    },
  };
}

function legacyRequest(
  id: string,
  result: Record<string, unknown>,
  origin: ContextRequestRecord["origin"],
  attempt: number | null,
): ContextRequestRecord {
  return {
    id,
    origin,
    attempt,
    startedAt: null,
    elapsedMs: null,
    requestId: safeId(result.requestId),
    finishReason: finishReason(result.finishReason),
    failureCode: null,
    estimates: null,
    ...usage(result.usage),
  };
}

/** Owner diagnostics expose measurements and stable references, never private source bodies. */
export function createContextHealthService(store: Store, options: { now?: () => Date } = {}) {
  const { db } = store;
  const now = () => (options.now?.() ?? new Date()).toISOString();

  function sourceReport(row: SourceRow): ContextSourceReport {
    const snapshot = parsed(row.snapshotJson);
    const result = parsed(row.resultJson);
    const details = snapshotDetails(snapshot, row.kind);
    const caveats: string[] = [];
    if (!row.snapshotJson)
      caveats.push(row.snapshotOversize ? "snapshot_report_limit" : "snapshot_unavailable");
    const ledger = db
      .query<RequestRow, [string]>(`
        SELECT id,attempt,started_at AS startedAt,elapsed_ms AS elapsedMs,
          request_id AS requestId,finish_reason AS finishReason,failure_code AS failureCode,
          input_tokens AS inputTokens,output_tokens AS outputTokens,
          cached_input_tokens AS cachedInputTokens,reasoning_tokens AS reasoningTokens,
          message_units AS messageUnits,tool_schema_units AS toolSchemaUnits,
          service_tier AS serviceTier,cost_usd AS costUsd
        FROM core_context_requests WHERE ${row.kind === "conversation" ? "turn_id" : "heartbeat_run_id"}=?
        ORDER BY started_at DESC,rowid DESC LIMIT ${maxRequestsPerSource + 1}
      `)
      .all(row.id);
    let requests: ContextRequestRecord[] = ledger
      .slice(0, maxRequestsPerSource)
      .reverse()
      .map((entry) => ({
        id: entry.id,
        origin: "recorded",
        attempt: entry.attempt,
        startedAt: date(entry.startedAt),
        elapsedMs: entry.elapsedMs,
        requestId: safeId(entry.requestId),
        serviceTier: entry.serviceTier,
        costUsd: entry.costUsd,
        finishReason: finishReason(entry.finishReason),
        failureCode: failureCode(entry.failureCode),
        ...usage(entry),
        estimates: {
          estimator: "utf8-byte-upper-bound",
          messageUnits: entry.messageUnits,
          toolSchemaUnits: entry.toolSchemaUnits,
        },
      }));
    let cumulativeUsage = usage(result.usage);
    let cumulativeUsageBasis: ContextSourceReport["cumulativeUsageBasis"] = row.resultJson
      ? "legacy_turn_result"
      : "unavailable";
    if (ledger.length) {
      cumulativeUsage = sumUsage(requests);
      cumulativeUsageBasis = "recorded_requests";
      if (ledger.length > maxRequestsPerSource) {
        caveats.push("request_report_limit");
        cumulativeUsage = usage(null);
      }
    } else if (row.kind === "heartbeat" && row.resultJson) {
      requests = [legacyRequest(`${row.id}:legacy`, result, "legacy_single_request", 1)];
    } else if (row.kind === "conversation") {
      // Read only receipt fields, excluding tool arguments and generated text.
      const rounds = db
        .query<{ round: number; receipt: string }, [string]>(`
          SELECT round,json_object(
            'usage',json_extract(completion_json,'$.usage'),
            'finishReason',json_extract(completion_json,'$.finishReason'),
            'requestId',json_extract(completion_json,'$.requestId')
          ) AS receipt FROM core_tool_rounds WHERE turn_id=? ORDER BY round LIMIT 6
        `)
        .all(row.id);
      requests = rounds.map((entry) =>
        legacyRequest(
          `${row.id}:tool:${entry.round}`,
          parsed(entry.receipt),
          "legacy_tool_round",
          null,
        ),
      );
      const completeJournal = rounds.every(
        (entry, index) =>
          entry.round === index && parsed(entry.receipt).finishReason === "tool_calls",
      );
      const usesJournal = snapshot.memoryToolsEnabled === true && Boolean(snapshot.memory);
      // The earlier image-only loop can accumulate unjournaled repair calls. Its final
      // total cannot safely be converted into one request even with a single attempt.
      const knownSinglePath = snapshot.imageGenerationEnabled !== true && rounds.length === 0;
      const canReconstruct =
        row.attempts === 1 &&
        row.resultCount === 1 &&
        (result.finishReason === "stop" || result.finishReason === "length") &&
        completeJournal &&
        (usesJournal || knownSinglePath) &&
        Boolean(row.snapshotJson) &&
        !requests.some(
          (request) => request.requestId !== null && request.requestId === safeId(result.requestId),
        );
      if (canReconstruct) {
        const final = legacyRequest(
          `${row.id}:final`,
          result,
          requests.length ? "reconstructed_final" : "legacy_single_request",
          1,
        );
        const prior = requests.length
          ? sumUsage(requests)
          : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
        for (const key of tokenKeys) {
          const total = cumulativeUsage[key];
          const preceding = prior[key];
          final[key] =
            total !== null && preceding !== null && total >= preceding ? total - preceding : null;
        }
        requests.push(final);
      } else if (row.resultJson) {
        caveats.push("legacy_final_request_unknown");
      }
    }
    if (requests.some((entry) => tokenKeys.some((key) => entry[key] === null)))
      caveats.push("provider_usage_incomplete");
    if (!ledger.length) caveats.push("legacy_request_timing_unavailable");
    if (details.history.omissionReasons.includes("unclassified"))
      caveats.push("legacy_omission_reason_unknown");
    const signals = new Set<ContextSignal>();
    if (details.history.omissionReasons.includes("size_budget")) signals.add("history_size_budget");
    if (row.failureCode === "context_budget_exceeded") signals.add("fixed_context_budget");
    if (row.failureCode === "core_memory_budget_exceeded") signals.add("core_memory_budget");
    if (
      row.failureCode === "context_overflow" ||
      requests.some((entry) => entry.failureCode === "context_overflow")
    )
      signals.add("provider_context_refusal");
    if (
      result.finishReason === "length" ||
      requests.some((entry) => entry.finishReason === "length")
    )
      signals.add("output_budget_exhausted");
    if (row.kind === "conversation") {
      const toolPressure = db
        .query<{ present: number }, [string, string]>(`
          SELECT EXISTS(
            SELECT 1 FROM core_tool_outcomes WHERE turn_id=?
              AND json_extract(outcome_json,'$.code')='context_budget'
            UNION ALL
            SELECT 1 FROM core_activity WHERE kind='context.tool_budget'
              AND json_extract(metadata_json,'$.turnId')=?
          ) AS present
        `)
        .get(row.id, row.id);
      if (toolPressure?.present) signals.add("tool_context_budget");
    }
    const measuredInputs = requests.flatMap((entry) =>
      entry.inputTokens === null ? [] : [entry.inputTokens],
    );
    return {
      id: row.id,
      kind: row.kind,
      occurredAt: row.occurredAt,
      status: row.status,
      ...details,
      requests,
      cumulativeUsage,
      cumulativeUsageBasis,
      peakInputTokens: measuredInputs.length ? Math.max(...measuredInputs) : null,
      signals: [...signals],
      caveats,
    };
  }

  return {
    recordRequest(input: ContextRequestInput): ContextRequestRecord {
      if (
        (input.serviceTier != null &&
          input.serviceTier !== "flex" &&
          input.serviceTier !== "standard") ||
        (input.costUsd != null && (!Number.isFinite(input.costUsd) || input.costUsd < 0)) ||
        (input.kind !== "conversation" && input.kind !== "heartbeat") ||
        !safeId(input.sourceId) ||
        !Number.isSafeInteger(input.attempt) ||
        input.attempt < 1 ||
        !date(input.startedAt) ||
        count(input.elapsedMs) === null ||
        (input.requestId !== null && !safeId(input.requestId)) ||
        (input.finishReason !== null && !finishReason(input.finishReason)) ||
        (input.failureCode !== null && !failureCode(input.failureCode)) ||
        (input.finishReason !== null) === (input.failureCode !== null) ||
        input.estimates?.estimator !== "utf8-byte-upper-bound" ||
        count(input.estimates.messageUnits) === null ||
        count(input.estimates.toolSchemaUnits) === null ||
        tokenKeys.some((key) => input.usage?.[key] != null && count(input.usage[key]) === null)
      )
        throw new TypeError("Provide a valid context request receipt without source text.");
      const id = crypto.randomUUID();
      const toolCatalog = input.toolCatalog
        ? validateConversationToolCatalog(input.toolCatalog)
        : null;
      const measured = usage(input.usage);
      const startedAt = date(input.startedAt) as string;
      db.query(`
        INSERT INTO core_context_requests(
          id,turn_id,heartbeat_run_id,attempt,started_at,elapsed_ms,request_id,
          finish_reason,failure_code,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,
          message_units,tool_schema_units,created_at,tool_catalog_json,service_tier,cost_usd
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        input.kind === "conversation" ? input.sourceId : null,
        input.kind === "heartbeat" ? input.sourceId : null,
        input.attempt,
        startedAt,
        input.elapsedMs,
        input.requestId,
        input.finishReason,
        input.failureCode,
        measured.inputTokens,
        measured.outputTokens,
        measured.cachedInputTokens,
        measured.reasoningTokens,
        input.estimates.messageUnits,
        input.estimates.toolSchemaUnits,
        now(),
        toolCatalog ? JSON.stringify(toolCatalog) : null,
        input.serviceTier ?? null,
        input.costUsd ?? null,
      );
      return {
        id,
        origin: "recorded",
        attempt: input.attempt,
        startedAt,
        elapsedMs: input.elapsedMs,
        requestId: input.requestId,
        serviceTier: input.serviceTier ?? null,
        costUsd: input.costUsd ?? null,
        finishReason: input.finishReason,
        failureCode: input.failureCode,
        estimates: {
          estimator: "utf8-byte-upper-bound",
          messageUnits: input.estimates.messageUnits,
          toolSchemaUnits: input.estimates.toolSchemaUnits,
        },
        ...measured,
      };
    },
    getSource(kind: ContextSourceKind, id: string): ContextSourceReport | null {
      if ((kind !== "conversation" && kind !== "heartbeat") || !safeId(id))
        throw new TypeError("Provide a conversation or heartbeat reference.");
      return db.transaction(() => {
        const row = db.query<SourceRow, [string]>(sourceSelect(kind)).get(id);
        return row ? sourceReport(row) : null;
      })();
    },
    report(
      input: {
        limit?: number;
        notificationDelivery?: ContextHealthReport["notificationDelivery"];
      } = {},
    ): ContextHealthReport {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        throw new TypeError("Choose between 1 and 50 context records.");
      return db.transaction((): ContextHealthReport => {
        // Select bounded identities first; never hydrate the entire private archive to
        // find the newest records. The two source indexes serve these limited scans.
        const rows = db
          .query<{ id: string; kind: ContextSourceKind }, [number, number, number]>(`
            SELECT id,kind FROM (
              SELECT * FROM (SELECT id,'conversation' AS kind,received_at AS occurredAt
                FROM core_conversation_turns ORDER BY received_at DESC,id LIMIT ?)
              UNION ALL
              SELECT * FROM (SELECT id,'heartbeat' AS kind,created_at AS occurredAt
                FROM core_heartbeat_runs ORDER BY created_at DESC,id LIMIT ?)
            ) ORDER BY occurredAt DESC,kind,id LIMIT ?
          `)
          .all(limit, limit, limit);
        const sources = rows.flatMap(({ id, kind }) => {
          const row = db.query<SourceRow, [string]>(sourceSelect(kind)).get(id);
          return row ? [sourceReport(row)] : [];
        });
        const peaks = sources.flatMap((entry) =>
          entry.peakInputTokens === null ? [] : [entry.peakInputTokens],
        );
        return {
          generatedAt: now(),
          qualityThreshold: { status: "uncalibrated", inputTokens: null },
          notificationDelivery: input.notificationDelivery ?? "not_implemented",
          notices: db
            .query<Omit<ContextHealthReport["notices"][number], "active"> & { active: number }, []>(
              `SELECT id,status,category,active,attempts,created_at AS createdAt,delivered_at AS deliveredAt
              FROM core_context_notices ORDER BY created_at DESC,id LIMIT 10`,
            )
            .all()
            .map((notice) => ({ ...notice, active: Boolean(notice.active) })),
          summary: {
            sources: sources.length,
            requests: sources.reduce((total, source) => total + source.requests.length, 0),
            largestInputTokens: peaks.length ? Math.max(...peaks) : null,
            pressureSources: sources.filter((source) =>
              source.signals.some((signal) => signal !== "output_budget_exhausted"),
            ).length,
            outputExhaustedSources: sources.filter((source) =>
              source.signals.includes("output_budget_exhausted"),
            ).length,
          },
          sources,
          limitations: [
            "No model-specific input length has been validated as a quality-degradation threshold.",
            "Application units use UTF-8 bytes plus overhead and image allowances, not the model tokenizer; component figures can overlap.",
            "Totals combine requests; only per-request measurements describe an individual context window. Reasoning tokens are included in output tokens, and cached tokens are included in input tokens.",
            "This bounded report covers recent conversation and heartbeat sources. Missing usage and older omission reasons remain unknown; it is not a billing ledger or an assessment of answer quality.",
            "A process interruption before a receipt is stored can leave an unrecorded provider request.",
            "Failed client invocations can stop before network dispatch. Their presence is not proof the provider received a request; absent usage remains unknown. Automatic attempt numbers can restart after a manual retry.",
          ],
        };
      })();
    },
  };
}

export type ContextHealthService = ReturnType<typeof createContextHealthService>;
