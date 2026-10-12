import type { Store } from "../../store";
import { createActivityService } from "../activity/service";
import { validateGenerationReceipt } from "../conversations/generation-receipt";
import type { ConversationGenerationResult } from "../conversations/service";
import { createAgreementService } from "../dynamic/agreements";
import { createDailyService } from "../dynamic/daily";
import type { DailySnapshot } from "../dynamic/daily-types";
import { createDynamicService } from "../dynamic/service";
import type { DynamicSnapshot } from "../dynamic/types";
import {
  type HeartbeatBlockReason,
  type HeartbeatClaim,
  type HeartbeatHistoryItem,
  type HeartbeatRun,
  type HeartbeatRunStatus,
  type HeartbeatSettings,
  HeartbeatSettingsConflictError,
  type HeartbeatSettingsInput,
  type HeartbeatStatus,
} from "./types";

const MINUTE = 60_000;
const columns = `id,chat_id AS chatId,status,fence,lease_owner AS leaseOwner,
  settings_json AS settingsJson,input_watermark AS inputWatermark,waking_day AS wakingDay,
  snapshot_json AS snapshotJson,text,result_json AS resultJson,reason,created_at AS createdAt,
  updated_at AS updatedAt,finished_at AS finishedAt,delivery_started_at AS deliveryStartedAt,
  delivered_at AS deliveredAt,telegram_message_id AS telegramMessageId`;

type RunRow = Omit<HeartbeatRun, "settings" | "snapshot" | "result"> & {
  settingsJson: string;
  snapshotJson: string | null;
  resultJson: string | null;
};

const fromRow = ({ settingsJson, snapshotJson, resultJson, ...rest }: RunRow): HeartbeatRun => ({
  ...rest,
  settings: JSON.parse(settingsJson),
  snapshot: snapshotJson === null ? null : JSON.parse(snapshotJson),
  result: resultJson === null ? null : JSON.parse(resultJson),
});

function code(value: string): string {
  if (!/^[a-z0-9_]{1,80}$/.test(value)) throw new TypeError("Invalid heartbeat outcome code.");
  return value;
}

const minuteOfDay = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

function localClock(timestamp: string, settings: HeartbeatSettings) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === name)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  const start = minuteOfDay(settings.activeStart);
  const end = minuteOfDay(settings.activeEnd);
  const active =
    start === end ||
    (start < end ? minute >= start && minute < end : minute >= start || minute < end);
  // The waking day starts at activeStart, including an overnight window and DST repeats.
  const wakingDay =
    minute >= start
      ? date
      : new Date(Date.parse(`${date}T12:00:00.000Z`) - 24 * 60 * MINUTE).toISOString().slice(0, 10);
  return { active, wakingDay };
}

function isPaused(settings: HeartbeatSettings, timestamp: string): boolean {
  return settings.paused && (settings.pausedUntil === null || settings.pausedUntil > timestamp);
}

function validateSettings(input: HeartbeatSettingsInput): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new TypeError("A positive expectedVersion is required.");
  if (typeof input.enabled !== "boolean" || typeof input.paused !== "boolean")
    throw new TypeError("Heartbeat enabled and paused values must be booleans.");
  if (typeof input.timezone !== "string" || !input.timezone || input.timezone.length > 100)
    throw new TypeError("A valid timezone is required.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(new Date());
  } catch {
    throw new TypeError("A valid timezone is required.");
  }
  for (const value of [input.activeStart, input.activeEnd]) {
    if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
      throw new TypeError("Active hours must use HH:MM.");
  }
  for (const [name, value, min, max] of [
    ["minIntervalMinutes", input.minIntervalMinutes, 30, 1440],
    ["maxIntervalMinutes", input.maxIntervalMinutes, 30, 1440],
    ["minIdleMinutes", input.minIdleMinutes, 15, 1440],
    ["maxPerDay", input.maxPerDay, 1, 8],
    ["maxUnanswered", input.maxUnanswered, 1, 8],
    ["maxMessageChars", input.maxMessageChars, 80, 1000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new TypeError(`${name} is outside the supported range.`);
  }
  if (input.minIntervalMinutes > input.maxIntervalMinutes)
    throw new TypeError("The minimum interval cannot exceed the maximum interval.");
  if (
    input.pausedUntil !== null &&
    (typeof input.pausedUntil !== "string" || !Number.isFinite(Date.parse(input.pausedUntil)))
  )
    throw new TypeError("Pause until must be a valid date or null.");
  if (!input.paused && input.pausedUntil !== null)
    throw new TypeError("An unpaused heartbeat cannot have a pause deadline.");
}

function serializeResult(result: ConversationGenerationResult | undefined): string | null {
  if (!result) return null;
  if (typeof result.text !== "string") throw new TypeError("A generation result needs text.");
  validateGenerationReceipt(result);
  const json = JSON.stringify({
    text: result.text,
    usage:
      result.usage === undefined
        ? undefined
        : {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
            reasoningTokens: result.usage.reasoningTokens,
          },
    finishReason: result.finishReason,
    requestId: result.requestId,
    costUsd: result.costUsd,
  });
  if (Buffer.byteLength(json) > 64 * 1024)
    throw new TypeError("Heartbeat generation result exceeds its storage limit.");
  return json;
}

function retainedResult(run: HeartbeatRun, result?: ConversationGenerationResult): string | null {
  const next = serializeResult(result);
  const previous = serializeResult(run.result ?? undefined);
  if (next !== null && previous !== null && next !== previous)
    throw new Error("A different heartbeat generation result is already recorded.");
  return previous ?? next;
}

/** Durable casual opportunities; only the server worker performs inference and transport. */
export function createHeartbeatService(
  store: Store,
  options: { now?: () => Date; random?: () => number } = {},
) {
  const { db } = store;
  const activity = createActivityService(store);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const getSettings = (): HeartbeatSettings => {
    const row = db
      .query<{ json: string }, []>(
        "SELECT settings_json AS json FROM core_heartbeat_settings WHERE singleton=1",
      )
      .get();
    if (row) return JSON.parse(row.json);
    return db
      .transaction(() => {
        const settings: HeartbeatSettings = {
          version: 1,
          enabled: false,
          timezone: "America/Chicago",
          activeStart: "09:00",
          activeEnd: "23:00",
          minIntervalMinutes: 180,
          maxIntervalMinutes: 360,
          minIdleMinutes: 60,
          maxPerDay: 2,
          maxUnanswered: 2,
          maxMessageChars: 480,
          paused: false,
          pausedUntil: null,
          updatedAt: now(),
        };
        const json = JSON.stringify(settings);
        db.query("INSERT OR IGNORE INTO core_heartbeat_settings VALUES(1,1,?,?)").run(
          json,
          settings.updatedAt,
        );
        db.query("INSERT OR IGNORE INTO core_heartbeat_settings_revisions VALUES(1,?,?)").run(
          json,
          settings.updatedAt,
        );
        return JSON.parse(
          db
            .query<{ json: string }, []>(
              "SELECT settings_json AS json FROM core_heartbeat_settings WHERE singleton=1",
            )
            .get()?.json ?? json,
        ) as HeartbeatSettings;
      })
      .immediate();
  };
  const getRun = (id: string): HeartbeatRun | null => {
    const row = db
      .query<RunRow, [string]>(`SELECT ${columns} FROM core_heartbeat_runs WHERE id=?`)
      .get(id);
    return row ? fromRow(row) : null;
  };
  const ownsLease = (leaseOwner: string, timestamp: string): boolean =>
    !!db
      .query<{ singleton: number }, [string, string]>(
        `SELECT singleton FROM core_telegram_state
        WHERE singleton=1 AND lease_owner=? AND lease_expires_at>?`,
      )
      .get(leaseOwner, timestamp);
  const claimedRun = (
    claim: HeartbeatClaim,
    states: HeartbeatRunStatus[],
    timestamp: string,
  ): HeartbeatRun | null => {
    if (!ownsLease(claim.leaseOwner, timestamp)) return null;
    const run = getRun(claim.id);
    return run &&
      run.fence === claim.fence &&
      run.leaseOwner === claim.leaseOwner &&
      states.includes(run.status)
      ? run
      : null;
  };
  const nextOpportunity = (): string | null =>
    db
      .query<{ timestamp: string | null }, []>(
        "SELECT next_opportunity_at AS timestamp FROM core_heartbeat_state WHERE singleton=1",
      )
      .get()?.timestamp ?? null;
  const schedule = (settings: HeartbeatSettings, timestamp: string): string | null => {
    let next: string | null = null;
    if (settings.enabled && !(settings.paused && settings.pausedUntil === null)) {
      const draw = options.random?.() ?? Math.random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1)
        throw new TypeError("Heartbeat random values must be in [0,1).");
      const delay =
        settings.minIntervalMinutes +
        draw * (settings.maxIntervalMinutes - settings.minIntervalMinutes);
      const base = isPaused(settings, timestamp) ? (settings.pausedUntil ?? timestamp) : timestamp;
      let candidate = Date.parse(base) + Math.round(delay * MINUTE);
      // Check actual local instants: nonexistent DST times are never fabricated, and repeats
      // remain in the same waking day. A missed window waits for its next real active minute.
      for (let minute = 0; minute <= 3 * 24 * 60; minute += 1) {
        const value = new Date(candidate).toISOString();
        if (localClock(value, settings).active) {
          next = value;
          break;
        }
        candidate += MINUTE;
      }
      if (next === null) throw new Error("No active heartbeat opportunity could be found.");
    }
    db.query("UPDATE core_heartbeat_state SET next_opportunity_at=? WHERE singleton=1").run(next);
    return next;
  };
  const latestInput = (chatId: string) =>
    db
      .query<{ watermark: number; receivedAt: string }, [string]>(
        `SELECT rowid AS watermark,received_at AS receivedAt FROM core_telegram_inputs
        WHERE chat_id=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(chatId) ?? null;
  const log = (run: HeartbeatRun) => {
    activity.append({
      kind: "heartbeat",
      summary: `Heartbeat ${run.status}.`,
      status: run.status === "failed" || run.status === "unknown" ? "failed" : "succeeded",
      metadata: {
        runId: run.id,
        status: run.status,
        reason: run.reason,
        settingsVersion: run.settings.version,
        telegramMessageId: run.telegramMessageId,
        requestId: run.result?.requestId ?? null,
        usage: run.result?.usage ?? null,
        costUsd: run.result?.costUsd ?? null,
      },
    });
  };
  const finish = (
    run: HeartbeatRun,
    status: "silent" | "suppressed" | "failed" | "unknown",
    reason: string,
    timestamp: string,
    result?: ConversationGenerationResult,
  ) => {
    db.query(`UPDATE core_heartbeat_runs SET status=?,reason=?,updated_at=?,finished_at=?,
      result_json=coalesce(result_json,?) WHERE id=?`).run(
      status,
      code(reason),
      timestamp,
      timestamp,
      retainedResult(run, result),
      run.id,
    );
    const finished = getRun(run.id);
    if (finished) log(finished);
  };
  const evaluate = (
    chatId: string | null,
    timestamp: string,
    ignoreActiveId?: string,
  ): HeartbeatStatus => {
    const settings = getSettings();
    const clock = localClock(timestamp, settings);
    const paused = isPaused(settings, timestamp);
    const input = chatId ? latestInput(chatId) : null;
    const active = db
      .query<{ id: string }, []>(
        "SELECT id FROM core_heartbeat_runs WHERE status IN ('generating','prepared','sending') LIMIT 1",
      )
      .get();
    const recent = chatId
      ? db
          .query<{ status: string; attemptedAt: string }, [string, string]>(
            `SELECT status,coalesce(delivery_started_at,delivered_at) AS attemptedAt
          FROM core_heartbeat_runs WHERE chat_id=? AND status IN ('delivered','unknown','sending')
          AND coalesce(delivery_started_at,delivered_at)>=? ORDER BY attemptedAt DESC`,
          )
          .all(chatId, new Date(Date.parse(timestamp) - 72 * 60 * MINUTE).toISOString())
      : [];
    const today = recent.filter(
      (run) => localClock(run.attemptedAt, settings).wakingDay === clock.wakingDay,
    );
    const deliveredToday = today.filter((run) => run.status === "delivered").length;
    const unknownToday = today.filter((run) => run.status === "unknown").length;
    const sendingToday = today.filter((run) => run.status === "sending").length;
    const unansweredCount = chatId
      ? (db
          .query<{ count: number }, [string, number]>(
            `SELECT count(*) AS count FROM core_heartbeat_runs
          WHERE chat_id=? AND status IN ('delivered','unknown','sending') AND input_watermark>=?`,
          )
          .get(chatId, input?.watermark ?? 0)?.count ?? 0)
      : 0;
    const pending = chatId
      ? db
          .query<{ id: string }, [string]>(
            `SELECT id FROM core_conversation_turns WHERE chat_id=?
          AND status IN ('queued','generating','retry','generated') LIMIT 1`,
          )
          .get(chatId)
      : null;
    const lastReplyAt = chatId
      ? (db
          .query<{ timestamp: string | null }, [string]>(
            `SELECT max(o.delivered_at) AS timestamp FROM core_conversation_outbox o
          JOIN core_conversation_turns t ON t.id=o.turn_id WHERE t.chat_id=? AND o.status='sent'`,
          )
          .get(chatId)?.timestamp ?? null)
      : null;
    const lastActivityAt = [input?.receivedAt, lastReplyAt]
      .filter((value): value is string => !!value)
      .sort()
      .at(-1);
    let blockingReason: HeartbeatBlockReason | null = null;
    if (!settings.enabled) blockingReason = "disabled";
    else if (paused) blockingReason = "paused";
    else if (!chatId) blockingReason = "no_owner_chat";
    else if (!input) blockingReason = "no_owner_input";
    else if (!clock.active) blockingReason = "quiet_hours";
    else if (active && active.id !== ignoreActiveId) blockingReason = "active_run";
    else if (pending) blockingReason = "conversation_pending";
    else if (
      lastActivityAt &&
      Date.parse(timestamp) - Date.parse(lastActivityAt) < settings.minIdleMinutes * MINUTE
    )
      blockingReason = "recent_conversation";
    else if (deliveredToday + unknownToday + sendingToday >= settings.maxPerDay)
      blockingReason = "daily_limit";
    else if (unansweredCount >= settings.maxUnanswered) blockingReason = "unanswered_limit";
    else if (
      recent[0] &&
      Date.parse(timestamp) - Date.parse(recent[0].attemptedAt) <
        settings.minIntervalMinutes * MINUTE
    )
      blockingReason = "minimum_interval";
    return {
      enabled: settings.enabled,
      paused,
      activeNow: clock.active,
      wakingDay: clock.wakingDay,
      nextOpportunityAt: nextOpportunity(),
      latestOwnerInputAt: input?.receivedAt ?? null,
      deliveredToday,
      unknownToday,
      sendingToday,
      unansweredCount,
      blockingReason,
      activeRunId: active?.id ?? null,
    };
  };
  const staleReason = (run: HeartbeatRun, timestamp: string): string | null => {
    if (getSettings().version !== run.settings.version) return "settings_changed";
    if (
      typeof run.snapshot?.agreementRevision === "string" &&
      run.snapshot.agreementRevision !==
        createAgreementService(store, { now: () => new Date(timestamp) }).capture().revision
    )
      return "agreements_changed";
    const savedDynamic = run.snapshot?.dynamic as DynamicSnapshot | undefined;
    if (savedDynamic) {
      const current = createDynamicService(store).capture(new Date(timestamp));
      if (
        savedDynamic.settingsVersion !== current.settingsVersion ||
        savedDynamic.focus?.id !== current.focus?.id ||
        savedDynamic.focus?.version !== current.focus?.version ||
        savedDynamic.focus?.phase !== current.focus?.phase
      )
        return "growth_focus_changed";
    }
    const savedDaily = run.snapshot?.daily as Pick<DailySnapshot, "revision"> | undefined;
    if (
      savedDaily?.revision &&
      savedDaily.revision !==
        createDailyService(store, { now: () => new Date(timestamp) }).capture().revision
    )
      return "daily_records_changed";
    if ((latestInput(run.chatId)?.watermark ?? 0) !== run.inputWatermark)
      return "owner_input_changed";
    if (Date.parse(timestamp) - Date.parse(run.createdAt) > 15 * MINUTE)
      return "opportunity_expired";
    return evaluate(run.chatId, timestamp, run.id).blockingReason;
  };
  const saveSettings = (input: HeartbeatSettingsInput): HeartbeatSettings => {
    validateSettings(input);
    return db
      .transaction(() => {
        const previous = getSettings();
        if (previous.version !== input.expectedVersion) throw new HeartbeatSettingsConflictError();
        const { expectedVersion: _, ...fields } = input;
        const timestamp = now();
        const settings: HeartbeatSettings = {
          ...fields,
          pausedUntil:
            input.pausedUntil === null ? null : new Date(input.pausedUntil).toISOString(),
          version: previous.version + 1,
          updatedAt: timestamp,
        };
        const json = JSON.stringify(settings);
        db.query(
          "UPDATE core_heartbeat_settings SET version=?,settings_json=?,updated_at=? WHERE singleton=1",
        ).run(settings.version, json, timestamp);
        db.query("INSERT INTO core_heartbeat_settings_revisions VALUES(?,?,?)").run(
          settings.version,
          json,
          timestamp,
        );
        for (const row of db
          .query<RunRow, []>(
            `SELECT ${columns} FROM core_heartbeat_runs WHERE status IN ('generating','prepared')`,
          )
          .all())
          finish(fromRow(row), "suppressed", "settings_changed", timestamp);
        schedule(settings, timestamp);
        activity.append({
          kind: "heartbeat.settings",
          summary: "Heartbeat settings saved.",
          metadata: {
            version: settings.version,
            enabled: settings.enabled,
            paused: settings.paused,
          },
        });
        return settings;
      })
      .immediate();
  };
  const endClaim = (
    claim: HeartbeatClaim,
    status: "silent" | "suppressed" | "failed",
    reason: string,
    result?: ConversationGenerationResult,
  ): boolean =>
    db
      .transaction(() => {
        const timestamp = now();
        const run = claimedRun(claim, ["generating", "prepared"], timestamp);
        if (!run) return false;
        finish(run, status, reason, timestamp, result);
        return true;
      })
      .immediate();

  return {
    getSettings,
    saveSettings,
    getRun,
    getStatus: (chatId: string | null): HeartbeatStatus =>
      db.transaction(() => evaluate(chatId, now())).immediate(),
    pause(input: { expectedVersion: number; pausedUntil: string | null }): HeartbeatSettings {
      return saveSettings({ ...getSettings(), ...input, paused: true });
    },
    resume(input: { expectedVersion: number }): HeartbeatSettings {
      return saveSettings({ ...getSettings(), ...input, paused: false, pausedUntil: null });
    },
    claimOpportunity(input: { chatId: string; leaseOwner: string }): HeartbeatRun | null {
      if (typeof input.chatId !== "string" || !input.chatId || input.chatId.length > 100)
        throw new TypeError("A valid owner chat is required.");
      return db
        .transaction(() => {
          const timestamp = now();
          if (!ownsLease(input.leaseOwner, timestamp)) return null;
          const settings = getSettings();
          if (!settings.enabled || isPaused(settings, timestamp)) return null;
          const due = nextOpportunity();
          if (due === null) {
            schedule(settings, timestamp);
            return null;
          }
          if (due > timestamp) return null;
          const state = evaluate(input.chatId, timestamp);
          if (state.activeRunId) return null;
          schedule(settings, timestamp);
          const reason =
            Date.parse(timestamp) - Date.parse(due) > 15 * MINUTE
              ? "missed_opportunity"
              : state.blockingReason;
          const id = crypto.randomUUID();
          const status = reason === null ? "generating" : "suppressed";
          db.query(`INSERT INTO core_heartbeat_runs
          (id,chat_id,status,fence,lease_owner,settings_json,input_watermark,waking_day,reason,created_at,updated_at,finished_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            id,
            input.chatId,
            status,
            crypto.randomUUID(),
            input.leaseOwner,
            JSON.stringify(settings),
            latestInput(input.chatId)?.watermark ?? 0,
            state.wakingDay,
            reason,
            timestamp,
            timestamp,
            reason ? timestamp : null,
          );
          const run = getRun(id);
          if (run && reason) log(run);
          return reason ? null : run;
        })
        .immediate();
    },
    setSnapshot(claim: HeartbeatClaim, snapshot: Record<string, unknown>): boolean {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
        throw new TypeError("A heartbeat snapshot must be an object.");
      const json = JSON.stringify(snapshot);
      if (Buffer.byteLength(json) > 2 * 1024 * 1024)
        throw new TypeError("Heartbeat snapshot exceeds its storage limit.");
      return db
        .transaction(() => {
          const timestamp = now();
          const run = claimedRun(claim, ["generating"], timestamp);
          if (!run || run.snapshot !== null) return false;
          const reason = staleReason(run, timestamp);
          if (reason) {
            finish(run, "suppressed", reason, timestamp);
            return false;
          }
          db.query("UPDATE core_heartbeat_runs SET snapshot_json=?,updated_at=? WHERE id=?").run(
            json,
            timestamp,
            run.id,
          );
          return true;
        })
        .immediate();
    },
    /** Keep available provider evidence even when policy suppressed the opportunity meanwhile. */
    recordGenerationResult(claim: HeartbeatClaim, result: ConversationGenerationResult): boolean {
      serializeResult(result);
      return db
        .transaction(() => {
          const timestamp = now();
          if (!ownsLease(claim.leaseOwner, timestamp)) return false;
          const run = getRun(claim.id);
          if (!run || run.fence !== claim.fence || run.leaseOwner !== claim.leaseOwner)
            return false;
          const json = retainedResult(run, result);
          if (run.result !== null) return true;
          db.query("UPDATE core_heartbeat_runs SET result_json=?,updated_at=? WHERE id=?").run(
            json,
            timestamp,
            run.id,
          );
          activity.append({
            kind: "heartbeat.generation",
            summary: "Heartbeat generation receipt recorded.",
            metadata: {
              runId: run.id,
              status: run.status,
              requestId: result.requestId ?? null,
              usage: result.usage ?? null,
              costUsd: result.costUsd ?? null,
            },
          });
          return true;
        })
        .immediate();
    },
    prepare(claim: HeartbeatClaim, result: ConversationGenerationResult): boolean {
      serializeResult(result);
      return db
        .transaction(() => {
          const timestamp = now();
          const run = claimedRun(claim, ["generating"], timestamp);
          if (!run || run.snapshot === null) return false;
          const json = retainedResult(run, result);
          const reason = staleReason(run, timestamp);
          if (reason) {
            finish(run, "suppressed", reason, timestamp, result);
            return false;
          }
          const text = result.text.trim();
          if (!text || text.length > run.settings.maxMessageChars) {
            finish(run, "failed", "invalid_message_length", timestamp, result);
            return false;
          }
          db.query(
            "UPDATE core_heartbeat_runs SET status='prepared',text=?,result_json=?,updated_at=? WHERE id=?",
          ).run(text, json, timestamp, run.id);
          return true;
        })
        .immediate();
    },
    silence: (
      claim: HeartbeatClaim,
      reason = "model_silent",
      result?: ConversationGenerationResult,
    ) => endClaim(claim, "silent", reason, result),
    suppress: (claim: HeartbeatClaim, reason: string, result?: ConversationGenerationResult) =>
      endClaim(claim, "suppressed", reason, result),
    fail: (claim: HeartbeatClaim, reason: string, result?: ConversationGenerationResult) =>
      endClaim(claim, "failed", reason, result),
    claimDelivery(input: { chatId: string; leaseOwner: string }): HeartbeatRun | null {
      return db
        .transaction(() => {
          const timestamp = now();
          if (!ownsLease(input.leaseOwner, timestamp)) return null;
          const row = db
            .query<RunRow, [string, string]>(
              `SELECT ${columns} FROM core_heartbeat_runs WHERE status='prepared' AND chat_id=? AND lease_owner=? LIMIT 1`,
            )
            .get(input.chatId, input.leaseOwner);
          if (!row) return null;
          const run = fromRow(row);
          const reason = staleReason(run, timestamp);
          if (reason) {
            finish(run, "suppressed", reason, timestamp);
            return null;
          }
          db.query(
            `UPDATE core_heartbeat_runs SET status='sending',delivery_started_at=?,updated_at=?,waking_day=? WHERE id=?`,
          ).run(timestamp, timestamp, localClock(timestamp, getSettings()).wakingDay, run.id);
          return getRun(run.id);
        })
        .immediate();
    },
    recordDelivery(
      claim: HeartbeatClaim,
      outcome: {
        status: "delivered" | "unknown" | "failed";
        telegramMessageId?: string;
        code?: string;
      },
    ): boolean {
      if (!["delivered", "unknown", "failed"].includes(outcome.status))
        throw new TypeError("Invalid heartbeat delivery outcome.");
      if (
        outcome.status === "delivered" &&
        (!outcome.telegramMessageId || !/^\d{1,30}$/.test(outcome.telegramMessageId))
      )
        throw new TypeError("Confirmed heartbeat delivery requires a Telegram message receipt.");
      if (outcome.code !== undefined) code(outcome.code);
      return db
        .transaction(() => {
          const timestamp = now();
          const run = claimedRun(claim, ["sending"], timestamp);
          if (!run) return false;
          // Policy is checked before transport begins. A later settings/input change cannot
          // erase the factual receipt of a message already sent.
          db.query(`UPDATE core_heartbeat_runs SET status=?,reason=?,telegram_message_id=?,delivered_at=?,
          updated_at=?,finished_at=? WHERE id=?`).run(
            outcome.status,
            outcome.code ?? null,
            outcome.status === "delivered" ? (outcome.telegramMessageId ?? null) : null,
            outcome.status === "delivered" ? timestamp : null,
            timestamp,
            timestamp,
            run.id,
          );
          const finished = getRun(run.id);
          if (finished) log(finished);
          return true;
        })
        .immediate();
    },
    recoverInterrupted(leaseOwner: string): {
      generations: number;
      deliveries: number;
      rescheduled: boolean;
    } {
      return db
        .transaction(() => {
          const timestamp = now();
          if (!ownsLease(leaseOwner, timestamp))
            return { generations: 0, deliveries: 0, rescheduled: false };
          let generations = 0;
          let deliveries = 0;
          for (const row of db
            .query<RunRow, []>(
              `SELECT ${columns} FROM core_heartbeat_runs WHERE status IN ('generating','prepared','sending')`,
            )
            .all()) {
            const run = fromRow(row);
            if (run.status === "sending") {
              finish(run, "unknown", "interrupted_delivery", timestamp);
              deliveries += 1;
            } else {
              finish(run, "suppressed", "interrupted_generation", timestamp);
              generations += 1;
            }
          }
          const next = nextOpportunity();
          const settings = getSettings();
          const rescheduled = settings.enabled && (next === null || next <= timestamp);
          if (rescheduled) schedule(settings, timestamp);
          return { generations, deliveries, rescheduled };
        })
        .immediate();
    },
    recentRuns(limit = 30): HeartbeatRun[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError("Heartbeat history limit must be between 1 and 100.");
      return db
        .query<RunRow, [number]>(
          `SELECT ${columns} FROM core_heartbeat_runs ORDER BY created_at DESC,rowid DESC LIMIT ?`,
        )
        .all(limit)
        .map(fromRow);
    },
    confirmedHistory(input: {
      chatId: string;
      since: string;
      before?: string;
      limit?: number;
    }): HeartbeatHistoryItem[] {
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new TypeError("Heartbeat history limit must be between 1 and 200.");
      if (
        !Number.isFinite(Date.parse(input.since)) ||
        (input.before !== undefined && !Number.isFinite(Date.parse(input.before)))
      )
        throw new TypeError("Heartbeat history dates must be valid.");
      return db
        .query<HeartbeatHistoryItem, [string, string, string, number]>(
          `SELECT id,text,delivered_at AS deliveredAt FROM core_heartbeat_runs
        WHERE chat_id=? AND status='delivered' AND delivered_at>=? AND delivered_at<=?
        ORDER BY delivered_at DESC,rowid DESC LIMIT ?`,
        )
        .all(
          input.chatId,
          new Date(input.since).toISOString(),
          input.before ? new Date(input.before).toISOString() : now(),
          limit,
        );
    },
  };
}

export type HeartbeatService = ReturnType<typeof createHeartbeatService>;
