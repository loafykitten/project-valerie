import { createHash } from "node:crypto";
import { hasUnsafeControlCharacters } from "../../guards";
import type { Store } from "../../store";
import { readTelegramSourceMetadata } from "../conversations/provenance";
import type { DailyEvent, DailyMutationContext, ReportedTime, WakingDay } from "./daily-types";
import { dailyInstant, validateReportedTime } from "./time";
import {
  DynamicConflictError,
  DynamicOperationConflictError,
  DynamicPermissionError,
  type DynamicSource,
  DynamicValidationError,
} from "./types";

export function dailyText(value: unknown, limit: number, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > limit ||
    hasUnsafeControlCharacters(value)
  )
    throw new DynamicValidationError(field, "invalid_text", `Provide bounded, nonempty ${field}.`);
  return value;
}
export function dailyVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new TypeError("Provide the current saved version.");
  return value as number;
}
export function runDynamicOperation<T>(
  store: Store,
  name: string,
  input: unknown,
  context: { actor: string; turnId?: string; operationKey?: string },
  authorize: () => void,
  action: () => T,
): T {
  return store.db
    .transaction(() => {
      authorize();
      if (context.operationKey !== undefined) dailyText(context.operationKey, 300, "operationKey");
      const hash = createHash("sha256")
        .update(
          JSON.stringify({ name, input, actor: context.actor, turnId: context.turnId ?? null }),
        )
        .digest("hex");
      const previous = context.operationKey
        ? store.db
            .query<{ hash: string; json: string }, [string]>(
              "SELECT request_hash AS hash,result_json AS json FROM core_dynamic_operations WHERE operation_key=?",
            )
            .get(context.operationKey)
        : null;
      if (previous) {
        if (previous.hash !== hash) throw new DynamicOperationConflictError();
        return JSON.parse(previous.json) as T;
      }
      const result = action();
      if (context.operationKey)
        store.db
          .query("INSERT INTO core_dynamic_operations VALUES(?,?,?)")
          .run(context.operationKey, hash, JSON.stringify(result));
      return result;
    })
    .immediate();
}
export function dynamicConversationSource(
  store: Store,
  id: string,
  turnId?: string,
): DynamicSource | null {
  const row = store.db
    .query<
      { at: string },
      [string, string | null, string | null]
    >(`SELECT i.received_at AS at FROM core_telegram_inputs i
    JOIN core_conversation_turns source_turn ON source_turn.id=i.turn_id
    WHERE 'conversation:'||i.id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM core_conversation_turns target_turn
      WHERE target_turn.id=? AND i.chat_id=target_turn.chat_id AND i.sender_id=target_turn.sender_id AND source_turn.rowid<=target_turn.rowid))`)
    .get(id, turnId ?? null, turnId ?? null);
  return row ? { type: "conversation", id, role: "user", observedAt: row.at } : null;
}
type SourceDetail = {
  id: string;
  turnId: string;
  text: string;
  receivedAt: string;
  updateId: number;
  position: number;
  metadata: string | null;
};
export function createDailyRepository(store: Store, options: { now?: () => Date } = {}) {
  const db = store.db,
    now = options.now ?? (() => new Date());
  const sourceFor = (id: string, turnId?: string) => dynamicConversationSource(store, id, turnId);
  const visible = (
    record: { sources: DynamicSource[]; revisionSources?: DynamicSource[] },
    turnId?: string,
  ) =>
    !turnId ||
    [...record.sources, ...(record.revisionSources ?? [])].every(
      (s) => s.type === "owner_entry" || sourceFor(s.id, turnId),
    );
  const readEvent = (
    id: string,
    input: { revision?: number; turnId?: string } = {},
  ): DailyEvent | null => {
    dailyText(id, 220, "id");
    const row =
      input.revision !== undefined
        ? db
            .query<{ json: string }, [string, number]>(
              "SELECT record_json AS json FROM core_dynamic_event_revisions WHERE event_id=? AND version=?",
            )
            .get(id, dailyVersion(input.revision))
        : db
            .query<{ json: string }, [string]>(
              "SELECT record_json AS json FROM core_dynamic_events WHERE id=?",
            )
            .get(id);
    const event = row ? (JSON.parse(row.json) as DailyEvent) : null;
    return event && visible(event, input.turnId) ? event : null;
  };
  const readDay = (id: string, input: { turnId?: string } = {}): WakingDay | null => {
    dailyText(id, 220, "dayId");
    const row = db
      .query<{ json: string }, [string]>(
        "SELECT record_json AS json FROM core_waking_days WHERE id=?",
      )
      .get(id);
    if (!row) return null;
    const day = JSON.parse(row.json) as WakingDay;
    if (input.turnId) {
      const latest = db
        .query<{ eventId: string }, [string]>(
          "SELECT causal_event_id AS eventId FROM core_waking_day_revisions WHERE day_id=? ORDER BY version DESC LIMIT 1",
        )
        .get(id);
      if (latest && !readEvent(latest.eventId, input)) return null;
    }
    return day;
  };
  const currentDay = (turnId?: string) => {
    const row = db
      .query<{ id: string }, []>("SELECT id FROM core_waking_days WHERE current=1")
      .get();
    return row ? readDay(row.id, { turnId }) : null;
  };
  const authorize = (context: DailyMutationContext, scope: "manageWaking" | "manageProgress") => {
    if (context.actor === "owner") return;
    if (context.actor !== "valerie")
      throw new TypeError("Only owner entries or sourced Valerie reports are accepted.");
    const settings = db
      .query<{ json: string }, []>(
        "SELECT settings_json AS json FROM core_dynamic_settings WHERE singleton=1",
      )
      .get();
    const saved = settings ? JSON.parse(settings.json) : {};
    if (
      context.permissions?.[scope] !== true ||
      saved[
        scope === "manageWaking" ? "allowValerieManageWaking" : "allowValerieManageProgress"
      ] !== true
    )
      throw new DynamicPermissionError(scope);
    dailyText(context.operationKey, 300, "operationKey");
    dailyText(context.turnId, 220, "turnId");
    if (!db.query("SELECT id FROM core_conversation_turns WHERE id=?").get(context.turnId ?? ""))
      throw new DynamicValidationError(
        "turnId",
        "source_unavailable",
        "The owner source turn is unavailable.",
      );
  };
  const evidence = (
    sourceIds: string[] | undefined,
    context: DailyMutationContext,
  ): DynamicSource[] => {
    if (
      (sourceIds !== undefined && !Array.isArray(sourceIds)) ||
      (sourceIds?.length ?? 0) > 5 ||
      (context.actor === "valerie" && !sourceIds?.length)
    )
      throw new DynamicValidationError(
        "sourceIds",
        "source_unavailable",
        "Link one to five original owner messages supporting this report.",
      );
    const sources = [...new Set(sourceIds ?? [])].map((id) => {
      dailyText(id, 220, "sourceIds");
      const source = sourceFor(id, context.actor === "valerie" ? context.turnId : undefined);
      if (!source)
        throw new DynamicValidationError(
          "sourceIds",
          "source_unavailable",
          "Use owner messages from this conversation at or before this turn, not assistant claims or memory IDs.",
        );
      return source;
    });
    if (context.actor === "owner")
      sources.unshift({
        type: "owner_entry",
        id: `owner:${crypto.randomUUID()}`,
        role: "owner",
        observedAt: now().toISOString(),
      });
    return sources;
  };
  const timeFor = (input: ReportedTime, sources: DynamicSource[]) => {
    const latest =
      sources
        .map((s) => s.observedAt)
        .sort()
        .at(-1) ?? now().toISOString();
    const resolved =
      input?.basis === "message_time" && input.at === null ? { ...input, at: latest } : input;
    const serverAt = now().toISOString();
    return validateReportedTime(resolved, latest < serverAt ? latest : serverAt);
  };
  const sourceDetails = (sources: DynamicSource[]) =>
    sources
      .filter((s) => s.type === "conversation")
      .map((source) =>
        db
          .query<SourceDetail, [string]>(
            "SELECT 'conversation:'||id AS id,turn_id AS turnId,input_text AS text,received_at AS receivedAt,update_id AS updateId,rowid AS position,source_metadata_json AS metadata FROM core_telegram_inputs WHERE 'conversation:'||id=?",
          )
          .get(source.id),
      )
      .filter((s): s is SourceDetail => Boolean(s));
  const latestWatermark = (turnId?: string): number | null => {
    if (!turnId) return null;
    return (
      db
        .query<{ value: number }, [string]>(
          `SELECT max(i.rowid) AS value FROM core_telegram_inputs i JOIN core_conversation_turns target ON target.id=? WHERE i.chat_id=target.chat_id AND i.sender_id=target.sender_id`,
        )
        .get(turnId)?.value ?? null
    );
  };
  const currentSource = (
    sources: DynamicSource[],
    context: DailyMutationContext,
    quote?: string,
  ): {
    eligible: boolean;
    watermark: number | null;
    receivedAt: string;
    reason?: string;
    reportSourceIds: string[];
  } => {
    if (context.actor === "owner")
      return {
        eligible: true,
        watermark: null,
        receivedAt: now().toISOString(),
        reportSourceIds: sources
          .filter((source) => source.type === "owner_entry")
          .map((source) => source.id),
      };
    const watermark = latestWatermark(context.turnId),
      details = sourceDetails(sources)
        .filter((source) => source.turnId === context.turnId)
        .sort((a, b) => a.position - b.position);
    const latest =
      watermark === null
        ? null
        : db
            .query<{ turnId: string }, [number]>(
              "SELECT turn_id AS turnId FROM core_telegram_inputs WHERE rowid=?",
            )
            .get(watermark);
    const receivedAt = details[0]?.receivedAt ?? now().toISOString();
    if (latest?.turnId !== context.turnId || !details.length)
      return {
        eligible: false,
        watermark,
        receivedAt,
        reason: "historical_or_stale_source",
        reportSourceIds: [],
      };
    if (!quote?.trim() || quote.length > 800)
      return {
        eligible: false,
        watermark,
        receivedAt,
        reason: "waking_evidence_quote_required",
        reportSourceIds: [],
      };
    let originalSeen = false;
    const qualifying = details.filter((source) => {
      const m = readTelegramSourceMetadata(source.metadata, source.text);
      if (m?.provenance !== "original" || m.incomplete) return false;
      originalSeen = true;
      let start = source.text.indexOf(quote);
      while (start >= 0) {
        if (
          !m.quotedRanges.some(
            (range) => start < range.offset + range.length && start + quote.length > range.offset,
          )
        )
          return true;
        start = source.text.indexOf(quote, start + 1);
      }
      return false;
    });
    if (!qualifying.length)
      return {
        eligible: false,
        watermark,
        receivedAt,
        reason: originalSeen ? "quoted_or_unavailable_evidence" : "transport_provenance_uncertain",
        reportSourceIds: [],
      };
    return {
      eligible: true,
      watermark,
      receivedAt: qualifying[0]?.receivedAt ?? receivedAt,
      reportSourceIds: qualifying.map((source) => source.id),
    };
  };
  const persistEvent = (event: DailyEvent) => {
    const json = JSON.stringify(event),
      behavior = event.payload.kind === "progress" ? event.payload.behaviorId : null;
    db.query(
      `INSERT INTO core_dynamic_events(id,version,state,kind,day_id,behavior_id,occurred_at,recorded_at,record_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state,kind=excluded.kind,day_id=excluded.day_id,behavior_id=excluded.behavior_id,occurred_at=excluded.occurred_at,record_json=excluded.record_json`,
    ).run(
      event.id,
      event.version,
      event.state,
      event.payload.kind,
      event.wakingDayId,
      behavior,
      event.occurred.at,
      event.recordedAt,
      json,
    );
    db.query("INSERT INTO core_dynamic_event_revisions VALUES(?,?,?)").run(
      event.id,
      event.version,
      json,
    );
  };
  const persistDay = (day: WakingDay, eventId: string) => {
    const json = JSON.stringify(day);
    db.query(
      "INSERT INTO core_waking_days(id,version,current,record_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,current=excluded.current,record_json=excluded.record_json",
    ).run(day.id, day.version, Number(day.current), json);
    db.query("INSERT INTO core_waking_day_revisions VALUES(?,?,?,?)").run(
      day.id,
      day.version,
      eventId,
      json,
    );
  };
  const claimKey = (event: DailyEvent) =>
    event.payload.kind === "progress"
      ? `behavior:${event.payload.behaviorId}`
      : event.payload.kind === "waking" && event.payload.report === "sleep_plan"
        ? "sleep_plan"
        : "waking_status";
  const claimed = (sources: DynamicSource[], key: string): DailyEvent[] =>
    [
      ...new Set(
        sources
          .filter((s) => s.type === "conversation")
          .flatMap((s) => {
            const row = db
              .query<{ id: string }, [string, string]>(
                "SELECT event_id AS id FROM core_dynamic_event_sources WHERE source_ref=? AND claim_key=?",
              )
              .get(s.id, key);
            return row ? [row.id] : [];
          }),
      ),
    ]
      .map((id) => readEvent(id))
      .filter((e): e is DailyEvent => Boolean(e));
  const attachClaims = (event: DailyEvent, sources: DynamicSource[]) => {
    const key = claimKey(event);
    if (claimed(sources, key).some((previous) => previous.id !== event.id))
      throw new DynamicConflictError(
        "This source already supports another event for that behavior. Read it and correct or link the existing event.",
      );
    for (const source of sources.filter((s) => s.type === "conversation"))
      db.query("INSERT OR IGNORE INTO core_dynamic_event_sources VALUES(?,?,?)").run(
        source.id,
        key,
        event.id,
      );
  };
  const allEvents = (dayId?: string | null, behaviorId?: string): DailyEvent[] => {
    const rows = db
      .query<{ json: string }, [string | null, string | null, string | null, string | null]>(
        "SELECT record_json AS json FROM core_dynamic_events WHERE (? IS NULL OR day_id=?) AND (? IS NULL OR behavior_id=?) ORDER BY rowid LIMIT 2001",
      )
      .all(dayId ?? null, dayId ?? null, behaviorId ?? null, behaviorId ?? null);
    if (rows.length > 2000)
      throw new TypeError(
        "Too many events for a bounded daily calculation. No exact total was inferred.",
      );
    return rows.map((row) => JSON.parse(row.json) as DailyEvent);
  };
  return {
    store,
    db,
    now,
    sourceFor,
    visible,
    authorize,
    evidence,
    timeFor,
    sourceDetails,
    currentSource,
    latestWatermark,
    readEvent,
    readDay,
    currentDay,
    persistEvent,
    persistDay,
    claimed,
    attachClaims,
    allEvents,
    operation: <T>(
      name: string,
      input: unknown,
      context: DailyMutationContext,
      scope: "manageWaking" | "manageProgress",
      action: () => T,
    ) => runDynamicOperation(store, name, input, context, () => authorize(context, scope), action),
    eventBase: (
      summary: string,
      occurred: ReportedTime,
      sources: DynamicSource[],
      context: DailyMutationContext,
    ) => ({
      id: crypto.randomUUID(),
      version: 1,
      state: "active" as const,
      summary: dailyText(summary, 1000, "summary"),
      occurred,
      recordedAt: now().toISOString(),
      updatedAt: now().toISOString(),
      authoredBy: context.actor,
      sources,
      revisionSources: sources,
      stateApplied: false,
      inputWatermark: null,
    }),
    assertDay: (id: string | null) => {
      if (id !== null && (!readDay(id) || readDay(id)?.mergedIntoDayId))
        throw new DynamicValidationError(
          "wakingDayId",
          "day_unavailable",
          "Choose an available waking day or leave the report unassigned.",
        );
    },
    assertNotFuture: (at: string, sources: DynamicSource[]) => {
      const value = dailyInstant(at),
        latest =
          sources
            .map((s) => s.observedAt)
            .sort()
            .at(-1) ?? now().toISOString();
      if (value > latest || value > now().toISOString())
        throw new DynamicValidationError(
          "time",
          "future_fact",
          "A future time belongs to a plan, not a completed report.",
        );
      return value;
    },
  };
}
export type DailyRepository = ReturnType<typeof createDailyRepository>;
