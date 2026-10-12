import { hasUnsafeControlCharacters } from "../../guards";
import type { Store } from "../../store";
import { createActivityService } from "../activity/service";
import { readTelegramSourceMetadata } from "../conversations/provenance";
import type { ConversationGenerationResult } from "../conversations/service";
import { dynamicConversationSource, runDynamicOperation } from "../dynamic/evidence";
import { createDynamicService } from "../dynamic/service";
import { dailyInstant, dailyTimezone } from "../dynamic/time";
import { DynamicPermissionError, type DynamicSource } from "../dynamic/types";
import {
  type CheckinCandidate,
  type CheckinContext,
  type CheckinSettings,
  type OccurrenceKind,
  type Reminder,
  ReminderConflictError,
  type ReminderFields,
  type ReminderMutationContext,
  type ReminderOverview,
  type ReminderSaveInput,
  ReminderValidationError,
  type ScheduledClaim,
  type ScheduledOccurrence,
} from "./types";

const minute = 60000;
function hasUnquotedText(text: string, ranges: { offset: number; length: number }[]): boolean {
  let offset = 0,
    remaining = "";
  for (const range of [...ranges].sort((a, b) => a.offset - b.offset)) {
    if (range.offset > offset) remaining += text.slice(offset, range.offset);
    offset = Math.max(offset, range.offset + range.length);
  }
  return (remaining + text.slice(offset)).trim().length > 0;
}
const textField = (value: unknown, max: number, field: string, empty = false): string => {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value) > max ||
    hasUnsafeControlCharacters(value)
  )
    throw new ReminderValidationError(
      field,
      "invalid_text",
      `Provide bounded ${field}${empty ? "" : " with nonempty text"}.`,
    );
  return value;
};
const version = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new ReminderValidationError(
      "expectedVersion",
      "invalid_version",
      "Provide the current reminder version.",
    );
  return Number(value);
};
const code = (value: string) => {
  if (!/^[a-z0-9_]{1,100}$/.test(value)) throw new TypeError("Invalid scheduling failure code.");
  return value;
};
const limit = (value: number | undefined, max = 100) => {
  const n = value ?? 30;
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new TypeError("Choose a bounded reminder page.");
  return n;
};
const occurrenceColumns = `id,kind,reminder_id AS reminderId,reminder_version AS reminderVersion,chat_id AS chatId,input_watermark AS inputWatermark,
  due_at AS dueAt,earliest_at AS earliestAt,expires_at AS expiresAt,status,title,purpose,timezone,
  allow_fallback AS allowFallback,checkin_json AS checkinJson,fence,lease_owner AS leaseOwner,
  snapshot_json AS snapshotJson,result_json AS resultJson,text,used_fallback AS usedFallback,attempts,
  next_attempt_at AS nextAttemptAt,telegram_message_id AS telegramMessageId,delivered_at AS deliveredAt,reason,
  created_at AS createdAt,updated_at AS updatedAt`;
type OccurrenceRow = Omit<
  ScheduledOccurrence,
  "allowFallback" | "usedFallback" | "checkin" | "snapshot" | "result"
> & {
  allowFallback: number;
  usedFallback: number;
  checkinJson: string | null;
  snapshotJson: string | null;
  resultJson: string | null;
};
const occurrence = (row: OccurrenceRow): ScheduledOccurrence => {
  const { checkinJson, snapshotJson, resultJson, ...rest } = row;
  return {
    ...rest,
    allowFallback: Boolean(row.allowFallback),
    usedFallback: Boolean(row.usedFallback),
    checkin: checkinJson ? JSON.parse(checkinJson) : null,
    snapshot: snapshotJson ? JSON.parse(snapshotJson) : null,
    result: resultJson ? JSON.parse(resultJson) : null,
  };
};
function fields(input: ReminderFields): ReminderFields {
  const dueAt = dailyInstant(input.dueAt),
    expiresAt = input.expiresAt === null ? null : dailyInstant(input.expiresAt);
  if (expiresAt && expiresAt <= dueAt)
    throw new ReminderValidationError(
      "expiresAt",
      "invalid_range",
      "Expiry must be after the requested reminder time.",
    );
  if (typeof input.allowFallback !== "boolean")
    throw new TypeError("Choose whether a simple backup message is allowed.");
  return {
    title: textField(input.title, 120, "title"),
    purpose: textField(input.purpose, 1200, "purpose", true),
    dueAt,
    timezone: dailyTimezone(input.timezone),
    originalTimeIntent: textField(input.originalTimeIntent, 240, "originalTimeIntent", true),
    expiresAt,
    allowFallback: input.allowFallback,
  };
}
function resultJson(result: ConversationGenerationResult): string {
  textField(result.text, 65536, "result text", true);
  const usage = result.usage ?? null;
  if (
    usage &&
    Object.values(usage).some(
      (v) => v !== null && v !== undefined && (!Number.isSafeInteger(v) || v < 0),
    )
  )
    throw new TypeError("Invalid provider usage.");
  if (result.requestId != null && !/^[a-z0-9_.:/-]{1,200}$/i.test(result.requestId))
    throw new TypeError("Invalid request receipt.");
  if (result.finishReason !== undefined && !/^[a-z0-9_.-]{1,100}$/i.test(result.finishReason))
    throw new TypeError("Invalid completion reason.");
  return JSON.stringify({
    text: result.text,
    usage,
    requestId: result.requestId ?? null,
    finishReason: result.finishReason ?? null,
    costUsd: result.costUsd ?? null,
  });
}

/** Durable one-time commitments and optional coordinated slots. The server owns every timer/send. */
export function createReminderService(
  store: Store,
  options: { now?: () => Date; isCheckinCurrent?: (context: CheckinContext) => boolean } = {},
) {
  const { db } = store,
    now = () => (options.now?.() ?? new Date()).toISOString();
  const dynamic = createDynamicService(store, { now: options.now }),
    activity = createActivityService(store);
  const readRaw = (id: string): Reminder | null => {
    const r = db
      .query<{ json: string }, [string]>(
        "SELECT record_json AS json FROM core_reminders WHERE id=?",
      )
      .get(textField(id, 220, "id"));
    return r ? JSON.parse(r.json) : null;
  };
  const readOccurrenceRaw = (id: string): ScheduledOccurrence | null => {
    const row = db
      .query<OccurrenceRow, [string]>(
        `SELECT ${occurrenceColumns} FROM core_scheduled_occurrences WHERE id=?`,
      )
      .get(textField(id, 220, "occurrenceId"));
    return row ? occurrence(row) : null;
  };
  const visible = (r: Reminder, turnId?: string) =>
    !turnId ||
    [...r.sources, ...r.stateSources].every(
      (s) => s.type === "owner_entry" || dynamicConversationSource(store, s.id, turnId),
    );
  const read = (id: string, input: { turnId?: string } = {}) => {
    const r = readRaw(id);
    return r && visible(r, input.turnId) ? r : null;
  };
  const occurrenceVisible = (r: ScheduledOccurrence, turnId?: string) =>
    !turnId ||
    (r.reminderId
      ? Boolean(read(r.reminderId, { turnId }))
      : Boolean(
          db
            .query("SELECT id FROM core_conversation_turns WHERE id=? AND chat_id=?")
            .get(turnId, r.chatId),
        ));
  const readOccurrence = (id: string, input: { turnId?: string } = {}) => {
    const r = readOccurrenceRaw(id);
    return r && occurrenceVisible(r, input.turnId) ? r : null;
  };
  const getPermissions = () => ({
    manageReminders: dynamic.getSettings().allowValerieManageReminders === true,
  });
  const authorize = (context: ReminderMutationContext) => {
    if (context.actor === "owner") return;
    if (
      context.actor !== "valerie" ||
      !context.permissions?.manageReminders ||
      !getPermissions().manageReminders
    )
      throw new DynamicPermissionError("manageReminders");
    textField(context.turnId, 220, "turnId");
    textField(context.operationKey, 300, "operationKey");
  };
  const evidence = (
    ids: string[] | undefined,
    context: ReminderMutationContext,
  ): DynamicSource[] => {
    if (
      (ids !== undefined && !Array.isArray(ids)) ||
      (ids?.length ?? 0) > 5 ||
      (context.actor === "valerie" && !ids?.length)
    )
      throw new ReminderValidationError(
        "sourceIds",
        "source_unavailable",
        "Link one to five original owner messages supporting this reminder request or change.",
      );
    const sources = [...new Set(ids ?? [])].map((id) => {
      const source = dynamicConversationSource(
        store,
        textField(id, 220, "sourceIds"),
        context.actor === "valerie" ? context.turnId : undefined,
      );
      if (!source)
        throw new ReminderValidationError(
          "sourceIds",
          "source_unavailable",
          "Use original owner sources available to this conversation, not assistant messages or memory IDs.",
        );
      return source;
    });
    if (
      context.actor === "valerie" &&
      !sources.some((s) => {
        const input = db
          .query<{ text: string; metadata: string | null }, [string, string]>(
            "SELECT input_text AS text,source_metadata_json AS metadata FROM core_telegram_inputs WHERE 'conversation:'||id=? AND turn_id=?",
          )
          .get(s.id, context.turnId ?? "");
        const metadata = input ? readTelegramSourceMetadata(input.metadata, input.text) : null;
        return (
          input &&
          metadata?.provenance === "original" &&
          !metadata.incomplete &&
          hasUnquotedText(input.text, metadata.quotedRanges)
        );
      })
    )
      throw new ReminderValidationError(
        "sourceIds",
        "current_request_required",
        "A reminder change needs the owner's current request as well as any earlier supporting context.",
      );
    if (context.actor === "owner")
      sources.unshift({
        type: "owner_entry",
        id: `owner:${crypto.randomUUID()}`,
        role: "owner",
        observedAt: now(),
      });
    return sources;
  };
  const mutation = <T>(
    name: string,
    input: unknown,
    context: ReminderMutationContext,
    action: () => T,
  ) =>
    runDynamicOperation(
      store,
      `reminder.${name}`,
      input,
      context,
      () => authorize(context),
      action,
    );
  const persist = (r: Reminder) => {
    const json = JSON.stringify(r);
    db.query(
      "INSERT INTO core_reminders VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state,current_occurrence_id=excluded.current_occurrence_id,record_json=excluded.record_json",
    ).run(r.id, r.version, r.state, r.currentOccurrenceId, json);
    db.query("INSERT INTO core_reminder_revisions VALUES(?,?,?)").run(r.id, r.version, json);
  };
  const append = (
    kind: string,
    id: string,
    status: "pending" | "succeeded" | "failed",
    metadata: Record<string, unknown> = {},
  ) =>
    activity.append({
      kind: `reminder.${kind}`,
      summary: `Reminder ${kind.replaceAll("_", " ")}.`,
      status,
      metadata: { id, ...metadata },
    });
  const insertOccurrence = (r: {
    id: string;
    kind: OccurrenceKind;
    reminder?: Reminder;
    checkin?: CheckinContext;
    chatId?: string;
    dueAt: string;
    earliestAt: string;
    expiresAt: string | null;
    title: string;
    purpose: string;
    timezone: string;
    allowFallback: boolean;
  }) => {
    db.query(`INSERT INTO core_scheduled_occurrences(id,kind,reminder_id,reminder_version,chat_id,due_at,earliest_at,expires_at,status,title,purpose,timezone,allow_fallback,checkin_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'scheduled',?,?,?,?,?,?,?)`).run(
      r.id,
      r.kind,
      r.reminder?.id ?? null,
      r.reminder?.version ?? null,
      r.chatId ?? null,
      r.dueAt,
      r.earliestAt,
      r.expiresAt,
      r.title,
      r.purpose,
      r.timezone,
      Number(r.allowFallback),
      r.checkin ? JSON.stringify(r.checkin) : null,
      now(),
      now(),
    );
  };
  const cancelPending = (reminderId: string, reason: string) =>
    db
      .query(
        "UPDATE core_scheduled_occurrences SET status='cancelled',reason=?,updated_at=? WHERE reminder_id=? AND status IN ('scheduled','generating','prepared','retry')",
      )
      .run(reason, now(), reminderId);
  const current = (
    id: string,
    expectedVersion: number,
    context: ReminderMutationContext,
    occurrenceId?: string,
  ) => {
    const r = read(id, { turnId: context.actor === "valerie" ? context.turnId : undefined });
    if (!r)
      throw new ReminderValidationError(
        "id",
        "not_found",
        "This reminder is unavailable. Read the current list first.",
      );
    if (
      r.version !== version(expectedVersion) ||
      (occurrenceId !== undefined && occurrenceId !== r.currentOccurrenceId)
    )
      throw new ReminderConflictError();
    if (r.state === "completed" || r.state === "cancelled")
      throw new ReminderValidationError(
        "id",
        "closed_reminder",
        "This reminder is closed. Create a new reminder for a new commitment.",
      );
    return r;
  };
  const createOccurrence = (r: Reminder) =>
    insertOccurrence({
      id: r.currentOccurrenceId,
      kind: "explicit_reminder",
      reminder: r,
      dueAt: r.dueAt,
      earliestAt: r.dueAt,
      expiresAt: r.expiresAt,
      title: r.title,
      purpose: r.purpose,
      timezone: r.timezone,
      allowFallback: r.allowFallback,
    });
  const ownsLease = (owner: string) =>
    Boolean(
      db
        .query(
          "SELECT singleton FROM core_telegram_state WHERE singleton=1 AND lease_owner=? AND lease_expires_at>?",
        )
        .get(owner, now()),
    );
  const getCheckinSettings = (): CheckinSettings =>
    JSON.parse(
      db
        .query<{ json: string }, []>(
          "SELECT settings_json AS json FROM core_checkin_settings WHERE singleton=1",
        )
        .get()?.json ?? "null",
    );
  const latestInput = (chatId: string) =>
    db
      .query<{ watermark: number; at: string }, [string]>(
        "SELECT rowid AS watermark,received_at AS at FROM core_telegram_inputs WHERE chat_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(chatId);
  const slotAttempts = (dayId: string, slot: string) =>
    db
      .query<{ count: number }, [string, string]>(
        `WITH RECURSIVE aliases(id) AS (SELECT ? UNION SELECT d.id FROM core_waking_days d JOIN aliases a ON json_extract(d.record_json,'$.mergedIntoDayId')=a.id) SELECT coalesce(sum(attempts),0) AS count FROM core_checkin_slots WHERE day_id IN(SELECT id FROM aliases) AND slot=?`,
      )
      .get(dayId, slot)?.count ?? 0;
  const staleReason = (r: ScheduledOccurrence): string | null => {
    if (r.expiresAt && r.expiresAt <= now()) return "expired";
    if (r.reminderId) {
      const parent = readRaw(r.reminderId);
      return parent?.state !== "active" ||
        parent.currentOccurrenceId !== r.id ||
        parent.version !== r.reminderVersion
        ? "reminder_changed"
        : null;
    }
    const settings = getCheckinSettings(),
      c = r.checkin;
    if (!settings.enabled || !c || !r.chatId || c.settingsVersion !== settings.version)
      return "checkin_settings_changed";
    const ownedSlots = db
      .query<{ dayId: string; slot: string; closed: number }, [string]>(
        "SELECT day_id AS dayId,slot,closed FROM core_checkin_slots WHERE occurrence_id=?",
      )
      .all(r.id);
    if (
      !c.slots.length ||
      ownedSlots.length !== c.slots.length ||
      c.slots.some(
        (slot) =>
          !ownedSlots.some(
            (owned) => owned.dayId === c.dayId && owned.slot === slot && owned.closed === 0,
          ),
      )
    )
      return "checkin_slot_changed";
    if (options.isCheckinCurrent && !options.isCheckinCurrent(c)) return "checkin_context_changed";
    const state = db
      .query<{ daily: string; agreement: string; watermark: number }, [string]>(
        "SELECT daily_revision AS daily,agreement_revision AS agreement,input_watermark AS watermark FROM core_checkin_state WHERE chat_id=?",
      )
      .get(r.chatId);
    if (!state || state.daily !== c.dailyRevision || state.agreement !== c.agreementRevision)
      return "checkin_context_changed";
    const input = latestInput(r.chatId);
    if (!input || input.watermark !== c.inputWatermark || state.watermark !== c.inputWatermark)
      return "owner_input_changed";
    const lastReply = db
      .query<{ at: string | null }, [string, string, string]>(
        `SELECT max(at) AS at FROM (
          SELECT o.delivered_at AS at FROM core_conversation_outbox o JOIN core_conversation_turns t ON t.id=o.turn_id WHERE t.chat_id=? AND o.status='sent' AND o.telegram_message_id IS NOT NULL
          UNION ALL SELECT delivered_at AS at FROM core_scheduled_occurrences WHERE chat_id=? AND status='sent' AND telegram_message_id IS NOT NULL
          UNION ALL SELECT delivered_at AS at FROM core_heartbeat_runs WHERE chat_id=? AND status='delivered' AND telegram_message_id IS NOT NULL
        )`,
      )
      .get(r.chatId, r.chatId, r.chatId)?.at;
    if (
      Date.parse(now()) - Math.max(Date.parse(input.at), lastReply ? Date.parse(lastReply) : 0) <
      settings.minIdleMinutes * minute
    )
      return "conversation_recent";
    if (
      db
        .query(
          "SELECT id FROM core_conversation_turns WHERE chat_id=? AND status IN ('queued','generating','retry','generated') LIMIT 1",
        )
        .get(r.chatId)
    )
      return "conversation_pending";
    return null;
  };
  const finish = (
    r: ScheduledOccurrence,
    status: ScheduledOccurrence["status"],
    reason: string,
  ) => {
    db.query("UPDATE core_scheduled_occurrences SET status=?,reason=?,updated_at=? WHERE id=?").run(
      status,
      code(reason),
      now(),
      r.id,
    );
    if (r.kind === "checkin" && ["sent", "unknown", "silent", "expired"].includes(status))
      db.query("UPDATE core_checkin_slots SET closed=1,updated_at=? WHERE occurrence_id=?").run(
        now(),
        r.id,
      );
    if (status === "expired" && r.reminderId) {
      const parent = readRaw(r.reminderId);
      if (parent?.state === "active" && parent.currentOccurrenceId === r.id)
        persist({ ...parent, version: parent.version + 1, state: "expired", updatedAt: now() });
    }
    append(status, r.id, status === "failed" || status === "unknown" ? "failed" : "succeeded", {
      reason,
    });
  };
  const validClaim = (claim: ScheduledClaim, states: ScheduledOccurrence["status"][]) => {
    if (!ownsLease(claim.leaseOwner)) return null;
    const r = readOccurrenceRaw(claim.id);
    return r &&
      r.fence === claim.fence &&
      r.leaseOwner === claim.leaseOwner &&
      states.includes(r.status)
      ? r
      : null;
  };
  const fallback = (r: ScheduledOccurrence) => `A little reminder: ${r.title}`;
  const prepareFallback = (r: ScheduledOccurrence, reason: string) => {
    if (r.kind !== "explicit_reminder" || !r.allowFallback || staleReason(r)) return false;
    db.query(
      "UPDATE core_scheduled_occurrences SET status='prepared',text=?,used_fallback=1,reason=?,updated_at=? WHERE id=? AND text IS NULL",
    ).run(fallback(r), code(reason), now(), r.id);
    return true;
  };

  const listReminders = (
    input: { limit?: number; includeClosed?: boolean; turnId?: string } = {},
  ): Reminder[] => {
    return db
      .query<{ json: string }, [number, number]>(
        "SELECT record_json AS json FROM core_reminders WHERE state='active' OR ?=1 ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, CASE WHEN state='active' THEN json_extract(record_json,'$.dueAt') END, rowid DESC LIMIT ?",
      )
      .all(Number(input.includeClosed === true), limit(input.limit))
      .map((x) => JSON.parse(x.json) as Reminder)
      .filter((r) => visible(r, input.turnId));
  };
  const listOccurrences = (
    input: { limit?: number; reminderId?: string; turnId?: string } = {},
  ): ScheduledOccurrence[] => {
    return db
      .query<OccurrenceRow, [string | null, string | null, number]>(
        `SELECT ${occurrenceColumns} FROM core_scheduled_occurrences WHERE (? IS NULL OR reminder_id=?) ORDER BY created_at DESC,rowid DESC LIMIT ?`,
      )
      .all(input.reminderId ?? null, input.reminderId ?? null, limit(input.limit))
      .map(occurrence)
      .filter((r) => occurrenceVisible(r, input.turnId));
  };

  const recordGenerationResult = (
    claim: ScheduledClaim,
    result: ConversationGenerationResult,
  ): boolean => {
    const json = resultJson(result);
    return db
      .transaction(() => {
        // Evidence-only late receipts may be retained after cancellation or lease replacement.
        // The original generation fence must exist; this never makes work sendable.
        const row = db
          .query<{ result: string | null }, [string, string, string]>(
            "SELECT result_json AS result FROM core_scheduled_generations WHERE occurrence_id=? AND fence=? AND lease_owner=?",
          )
          .get(claim.id, claim.fence, claim.leaseOwner);
        if (!row) return false;
        if (row.result !== null) return row.result === json;
        db.query(
          "UPDATE core_scheduled_generations SET result_json=?,finished_at=? WHERE occurrence_id=? AND fence=?",
        ).run(json, now(), claim.id, claim.fence);
        db.query(
          "UPDATE core_scheduled_occurrences SET result_json=?,updated_at=? WHERE id=? AND fence=? AND result_json IS NULL",
        ).run(json, now(), claim.id, claim.fence);
        return true;
      })
      .immediate();
  };

  return {
    timeSource(input: { turnId: string; sourceIds: string[]; preferredSourceId?: string }) {
      if (
        !Array.isArray(input.sourceIds) ||
        input.sourceIds.length < 1 ||
        input.sourceIds.length > 5
      )
        throw new ReminderValidationError(
          "sourceIds",
          "source_unavailable",
          "Link the current owner request for this time.",
        );
      const candidates = [...new Set(input.sourceIds)].flatMap((sourceId) => {
        if (!dynamicConversationSource(store, sourceId, input.turnId)) return [];
        const row = db
          .query<
            { id: string; at: string; text: string; metadata: string | null },
            [string, string]
          >(
            "SELECT id,received_at AS at,input_text AS text,source_metadata_json AS metadata FROM core_telegram_inputs WHERE 'conversation:'||id=? AND turn_id=?",
          )
          .get(sourceId, input.turnId);
        const metadata = row ? readTelegramSourceMetadata(row.metadata, row.text) : null;
        return row &&
          metadata?.provenance === "original" &&
          !metadata.incomplete &&
          hasUnquotedText(row.text, metadata.quotedRanges)
          ? [{ sourceId, receivedAt: dailyInstant(row.at) }]
          : [];
      });
      if (input.preferredSourceId !== undefined) {
        const selected = candidates.find(
          (candidate) => candidate.sourceId === input.preferredSourceId,
        );
        if (selected) return selected;
        throw new ReminderValidationError(
          "timeSourceId",
          "current_request_required",
          "Choose a cited original message in this current turn as the time source, not an older or quoted message.",
        );
      }
      if (!candidates.length)
        throw new ReminderValidationError(
          "sourceIds",
          "current_request_required",
          "A relative or calendar-day time needs a cited original owner request from this turn.",
        );
      if (new Set(candidates.map((candidate) => candidate.receivedAt)).size > 1)
        throw new ReminderValidationError(
          "timeSourceId",
          "ambiguous_time_source",
          "Several current messages have different times. Select the source ID containing this timing request.",
        );
      return candidates[0] as { sourceId: string; receivedAt: string };
    },
    read,
    readOccurrence,
    getPermissions,
    getCheckinSettings,
    list: listReminders,
    listOccurrences,
    overview(input: { limit?: number; turnId?: string } = {}): ReminderOverview {
      const n = limit(input.limit);
      const reminders = listReminders({ ...input, limit: n, includeClosed: true });
      const occurrences = new Map(
        listOccurrences({ ...input, limit: n }).map((row) => [row.id, row]),
      );
      for (const reminder of reminders) {
        const row = readOccurrence(reminder.currentOccurrenceId, input);
        if (row) occurrences.set(row.id, row);
      }
      return {
        reminders,
        occurrences: [...occurrences.values()].map((row) => ({
          ...row,
          snapshot: null,
          result: row.result
            ? {
                usage: row.result.usage,
                requestId: row.result.requestId,
                finishReason: row.result.finishReason,
                costUsd: row.result.costUsd,
              }
            : null,
        })),
        checkinSettings: getCheckinSettings(),
        permissions: getPermissions(),
        permissionsVersion: dynamic.getSettings().version,
      };
    },
    savePermissions(input: { expectedVersion: number; allowValerieManageReminders: boolean }) {
      if (typeof input.allowValerieManageReminders !== "boolean")
        throw new TypeError("Choose whether Valerie may manage requested reminders.");
      return db
        .transaction(() => dynamic.saveSettings({ ...dynamic.getSettings(), ...input }))
        .immediate();
    },
    saveCheckinSettings(
      input: Omit<CheckinSettings, "version" | "updatedAt"> & { expectedVersion: number },
    ): CheckinSettings {
      if (
        typeof input.enabled !== "boolean" ||
        !Number.isSafeInteger(input.morningDelayMinutes) ||
        input.morningDelayMinutes < 5 ||
        input.morningDelayMinutes > 180 ||
        !Number.isSafeInteger(input.eveningLeadMinutes) ||
        input.eveningLeadMinutes < 1 ||
        input.eveningLeadMinutes > 240 ||
        !Number.isSafeInteger(input.minIdleMinutes) ||
        input.minIdleMinutes < 0 ||
        input.minIdleMinutes > 120 ||
        !Number.isSafeInteger(input.maxMessageChars) ||
        input.maxMessageChars < 100 ||
        input.maxMessageChars > 1200
      )
        throw new TypeError("Choose valid check-in timing and message limits.");
      return db
        .transaction(() => {
          const previous = getCheckinSettings();
          if (previous.version !== version(input.expectedVersion))
            throw new ReminderConflictError(
              "Check-in settings changed. Reload them before saving.",
            );
          const { expectedVersion: _, ...data } = input;
          const saved = { ...data, version: previous.version + 1, updatedAt: now() };
          const json = JSON.stringify(saved);
          db.query(
            "UPDATE core_checkin_settings SET version=?,settings_json=? WHERE singleton=1",
          ).run(saved.version, json);
          db.query("INSERT INTO core_checkin_settings_revisions VALUES(?,?)").run(
            saved.version,
            json,
          );
          db.query(
            "UPDATE core_scheduled_occurrences SET status='suppressed',reason='checkin_settings_changed',updated_at=? WHERE kind='checkin' AND status IN ('scheduled','generating','prepared','retry')",
          ).run(now());
          return saved;
        })
        .immediate();
    },
    saveReminder(input: ReminderSaveInput, context: ReminderMutationContext): Reminder {
      return mutation("save", input, context, () => {
        const value = fields(input),
          sources = evidence(input.sourceIds, context);
        const previous = input.id
          ? current(input.id, input.expectedVersion as number, context)
          : null;
        if (!previous && input.expectedVersion !== undefined)
          throw new ReminderValidationError(
            "expectedVersion",
            "new_reminder",
            "Omit ID and version when creating a new reminder.",
          );
        const oldOccurrence = previous ? readOccurrenceRaw(previous.currentOccurrenceId) : null;
        const newSchedule =
          !previous ||
          previous.dueAt !== value.dueAt ||
          previous.expiresAt !== value.expiresAt ||
          !oldOccurrence ||
          ["scheduled", "generating", "prepared", "retry", "failed", "expired"].includes(
            oldOccurrence.status,
          );
        const saved: Reminder = {
          ...value,
          id: previous?.id ?? crypto.randomUUID(),
          version: (previous?.version ?? 0) + 1,
          state: "active",
          currentOccurrenceId: newSchedule
            ? crypto.randomUUID()
            : (previous as Reminder).currentOccurrenceId,
          sources,
          stateSources: previous?.stateSources ?? sources,
          authoredBy: context.actor,
          createdAt: previous?.createdAt ?? now(),
          updatedAt: now(),
        };
        if (previous && newSchedule) cancelPending(previous.id, "reminder_edited");
        persist(saved);
        if (newSchedule) createOccurrence(saved);
        append("saved", saved.id, "succeeded", {
          version: saved.version,
          occurrenceId: saved.currentOccurrenceId,
        });
        return saved;
      });
    },
    snooze(
      input: {
        id: string;
        expectedVersion: number;
        occurrenceId: string;
        dueAt: string;
        originalTimeIntent: string;
        sourceIds?: string[];
      },
      context: ReminderMutationContext,
    ): Reminder {
      return mutation("snooze", input, context, () => {
        const previous = current(input.id, input.expectedVersion, context, input.occurrenceId),
          dueAt = dailyInstant(input.dueAt),
          sources = evidence(input.sourceIds, context);
        if (dueAt <= now())
          throw new ReminderValidationError(
            "dueAt",
            "future_snooze",
            "Choose a future time for this snooze.",
          );
        if (previous.expiresAt && dueAt >= previous.expiresAt)
          throw new ReminderValidationError(
            "dueAt",
            "past_expiry",
            "The snooze would pass this reminder's expiry. Edit its schedule deliberately instead.",
          );
        const saved: Reminder = {
          ...previous,
          version: previous.version + 1,
          state: "active",
          dueAt,
          originalTimeIntent: textField(input.originalTimeIntent, 240, "originalTimeIntent", true),
          currentOccurrenceId: crypto.randomUUID(),
          stateSources: sources,
          updatedAt: now(),
        };
        cancelPending(previous.id, "snoozed");
        persist(saved);
        createOccurrence(saved);
        append("snoozed", saved.id, "succeeded", { occurrenceId: saved.currentOccurrenceId });
        return saved;
      });
    },
    complete(
      input: { id: string; expectedVersion: number; occurrenceId: string; sourceIds?: string[] },
      context: ReminderMutationContext,
    ): Reminder {
      return mutation("complete", input, context, () => {
        const previous = current(input.id, input.expectedVersion, context, input.occurrenceId),
          sources = evidence(input.sourceIds, context);
        const saved: Reminder = {
          ...previous,
          version: previous.version + 1,
          state: "completed",
          stateSources: sources,
          updatedAt: now(),
        };
        cancelPending(previous.id, "completed");
        persist(saved);
        append("completed", saved.id, "succeeded");
        return saved;
      });
    },
    cancel(
      input: { id: string; expectedVersion: number; sourceIds?: string[] },
      context: ReminderMutationContext,
    ): Reminder {
      return mutation("cancel", input, context, () => {
        const previous = current(input.id, input.expectedVersion, context),
          sources = evidence(input.sourceIds, context);
        const saved: Reminder = {
          ...previous,
          version: previous.version + 1,
          state: "cancelled",
          stateSources: sources,
          updatedAt: now(),
        };
        cancelPending(previous.id, "cancelled");
        persist(saved);
        append("cancelled", saved.id, "succeeded");
        return saved;
      });
    },
    retryFailed(
      input: { id: string; expectedVersion: number; occurrenceId: string; sourceIds?: string[] },
      context: ReminderMutationContext,
    ): Reminder {
      return mutation("retry", input, context, () => {
        const previous = current(input.id, input.expectedVersion, context, input.occurrenceId),
          old = readOccurrenceRaw(input.occurrenceId);
        if (old?.status !== "failed")
          throw new ReminderValidationError(
            "occurrenceId",
            "not_failed",
            "Only a definitively failed occurrence can be retried. Unknown sends are not replayed.",
          );
        const sources = evidence(input.sourceIds, context);
        if (previous.expiresAt && previous.expiresAt <= now())
          throw new ReminderValidationError(
            "expiresAt",
            "expired",
            "Edit the expired schedule before requesting delivery again.",
          );
        const saved: Reminder = {
          ...previous,
          version: previous.version + 1,
          currentOccurrenceId: crypto.randomUUID(),
          stateSources: sources,
          updatedAt: now(),
        };
        persist(saved);
        createOccurrence(saved);
        append("retry_requested", saved.id, "succeeded");
        return saved;
      });
    },
    resolveReply(turnId: string): { reminder: Reminder; occurrence: ScheduledOccurrence } | null {
      const target = db
        .query<{ chatId: string; metadata: string | null }, [string]>(
          "SELECT chat_id AS chatId,source_metadata_json AS metadata FROM core_telegram_inputs WHERE turn_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(turnId);
      if (!target?.metadata) return null;
      const metadata = JSON.parse(target.metadata) as {
        provenance?: string;
        replyToMessageId?: string;
        incomplete?: boolean;
      };
      if (metadata.provenance !== "original" || metadata.incomplete || !metadata.replyToMessageId)
        return null;
      const row = db
        .query<OccurrenceRow, [string, string]>(
          `SELECT ${occurrenceColumns} FROM core_scheduled_occurrences WHERE chat_id=? AND telegram_message_id=? AND status='sent' AND reminder_id IS NOT NULL LIMIT 1`,
        )
        .get(target.chatId, metadata.replyToMessageId);
      if (!row) return null;
      const found = occurrence(row),
        parent = found.reminderId ? read(found.reminderId, { turnId }) : null;
      return parent ? { reminder: parent, occurrence: found } : null;
    },
    claimPreparation(input: {
      chatId: string;
      leaseOwner: string;
      kind?: OccurrenceKind;
    }): ScheduledClaim | null {
      return db
        .transaction(() => {
          if (!ownsLease(input.leaseOwner)) return null;
          const expired = db
            .query<OccurrenceRow, [string]>(
              `SELECT ${occurrenceColumns} FROM core_scheduled_occurrences WHERE expires_at<=? AND status IN ('scheduled','generating','prepared','retry') LIMIT 100`,
            )
            .all(now());
          for (const row of expired) {
            const run = occurrence(row);
            finish(run, "expired", "expired");
          }
          const rows = db
            .query<
              OccurrenceRow,
              [string, string, string | null, string | null]
            >(`SELECT ${occurrenceColumns} FROM core_scheduled_occurrences r
          WHERE status='scheduled' AND (chat_id IS NULL OR chat_id=?) AND due_at<=?
            AND (? IS NULL OR kind=?) AND NOT EXISTS(SELECT 1 FROM core_scheduled_occurrences active WHERE active.kind=r.kind AND active.status='generating')
          ORDER BY CASE kind WHEN 'explicit_reminder' THEN 0 ELSE 1 END,due_at,rowid LIMIT 20`)
            .all(
              input.chatId,
              new Date(Date.parse(now()) + minute).toISOString(),
              input.kind ?? null,
              input.kind ?? null,
            );
          for (const row of rows) {
            const run = occurrence(row);
            if (run.kind === "checkin" && (run.dueAt > now() || run.earliestAt > now())) continue;
            const reason = staleReason({ ...run, chatId: input.chatId });
            if (reason) {
              if (!["conversation_recent", "conversation_pending"].includes(reason))
                finish(run, reason === "expired" ? "expired" : "suppressed", reason);
              continue;
            }
            if (
              run.checkin?.slots.some((slot) => slotAttempts(run.checkin?.dayId ?? "", slot) >= 3)
            ) {
              finish(run, "suppressed", "checkin_attempt_limit");
              continue;
            }
            const fence = crypto.randomUUID(),
              watermark = latestInput(input.chatId)?.watermark ?? 0;
            db.query(
              "UPDATE core_scheduled_occurrences SET status='generating',chat_id=?,input_watermark=?,fence=?,lease_owner=?,updated_at=? WHERE id=?",
            ).run(input.chatId, watermark, fence, input.leaseOwner, now(), run.id);
            db.query(
              "INSERT INTO core_scheduled_generations(occurrence_id,fence,lease_owner,started_at) VALUES(?,?,?,?)",
            ).run(run.id, fence, input.leaseOwner, now());
            if (run.kind === "checkin")
              db.query(
                "UPDATE core_checkin_slots SET attempts=attempts+1,updated_at=? WHERE occurrence_id=?",
              ).run(now(), run.id);
            return readOccurrenceRaw(run.id) as ScheduledClaim;
          }
          return null;
        })
        .immediate();
    },
    setSnapshot(claim: ScheduledClaim, snapshot: Record<string, unknown>): boolean {
      const json = JSON.stringify(snapshot);
      if (!snapshot || Array.isArray(snapshot) || Buffer.byteLength(json) > 2 * 1024 * 1024)
        throw new TypeError("Provide a bounded scheduled snapshot.");
      return db
        .transaction(() => {
          const run = validClaim(claim, ["generating"]);
          if (!run) return false;
          const reason = staleReason(run);
          if (reason) {
            finish(run, reason === "expired" ? "expired" : "suppressed", reason);
            return false;
          }
          if (run.snapshot !== null) return JSON.stringify(run.snapshot) === json;
          db.query(
            "UPDATE core_scheduled_occurrences SET snapshot_json=?,updated_at=? WHERE id=?",
          ).run(json, now(), run.id);
          db.query(
            "UPDATE core_scheduled_generations SET snapshot_json=? WHERE occurrence_id=? AND fence=? AND snapshot_json IS NULL",
          ).run(json, run.id, claim.fence);
          return true;
        })
        .immediate();
    },
    recordGenerationResult,
    prepare(
      claim: ScheduledClaim,
      input: { text: string; result?: ConversationGenerationResult; usedFallback?: boolean },
    ): boolean {
      if (input.result) recordGenerationResult(claim, input.result);
      return db
        .transaction(() => {
          const run = validClaim(claim, ["generating"]);
          if (!run) return false;
          const reason = staleReason(run);
          if (reason) {
            finish(run, reason === "expired" ? "expired" : "suppressed", reason);
            return false;
          }
          const max = run.kind === "checkin" ? getCheckinSettings().maxMessageChars : 1600;
          if (typeof input.text !== "string" || !input.text.trim() || input.text.length > max)
            throw new ReminderValidationError(
              "text",
              "invalid_message",
              "The scheduled message must be short and complete.",
            );
          if (input.usedFallback) {
            if (
              !run.allowFallback ||
              run.kind !== "explicit_reminder" ||
              input.text !== fallback(run)
            )
              throw new TypeError("This backup message was not authorized.");
          } else if (run.result?.finishReason !== "stop" || run.result.text !== input.text)
            throw new TypeError("A complete matching provider receipt is required.");
          db.query(
            "UPDATE core_scheduled_occurrences SET status='prepared',text=?,used_fallback=?,updated_at=? WHERE id=?",
          ).run(input.text, Number(input.usedFallback === true), now(), run.id);
          return true;
        })
        .immediate();
    },
    silence(claim: ScheduledClaim, reason = "model_silence"): boolean {
      return db
        .transaction(() => {
          const run = validClaim(claim, ["generating"]);
          if (run?.kind !== "checkin") return false;
          const stale = staleReason(run);
          if (stale) {
            finish(run, stale === "expired" ? "expired" : "suppressed", stale);
            return false;
          }
          finish(run, "silent", reason);
          return true;
        })
        .immediate();
    },
    failPreparation(
      claim: ScheduledClaim,
      reason: string,
      result?: ConversationGenerationResult,
    ): boolean {
      code(reason);
      if (result) recordGenerationResult(claim, result);
      return db
        .transaction(() => {
          const run = validClaim(claim, ["generating"]);
          if (!run) return false;
          db.query(
            "UPDATE core_scheduled_generations SET failure_code=?,finished_at=? WHERE occurrence_id=? AND fence=?",
          ).run(reason, now(), run.id, claim.fence);
          const stale = staleReason(run);
          if (stale) {
            finish(run, stale === "expired" ? "expired" : "suppressed", stale);
            return false;
          }
          if (!prepareFallback(run, reason)) finish(run, "failed", reason);
          return true;
        })
        .immediate();
    },
    claimDelivery(input: {
      chatId: string;
      leaseOwner: string;
      kind?: OccurrenceKind;
    }): ScheduledClaim | null {
      return db
        .transaction(() => {
          if (!ownsLease(input.leaseOwner)) return null;
          // A saved fallback policy can protect an explicit due time even if a provider
          // is still preparing its usual wording. Any late receipt remains evidence only.
          const waiting = db
            .query<OccurrenceRow, [string, string]>(
              `SELECT ${occurrenceColumns} FROM core_scheduled_occurrences WHERE kind='explicit_reminder' AND status IN ('scheduled','generating') AND due_at<=? AND (chat_id IS NULL OR chat_id=?) LIMIT 20`,
            )
            .all(now(), input.chatId);
          if (input.kind !== "checkin")
            for (const row of waiting)
              prepareFallback(occurrence(row), "preparation_not_ready_at_due");
          const rows = db
            .query<OccurrenceRow, [string, string, string, string | null, string | null]>(
              `SELECT ${occurrenceColumns} FROM core_scheduled_occurrences WHERE (chat_id IS NULL OR chat_id=?) AND due_at<=? AND (status='prepared' OR (status='retry' AND next_attempt_at<=?)) AND (? IS NULL OR kind=?) ORDER BY CASE kind WHEN 'explicit_reminder' THEN 0 ELSE 1 END,due_at,rowid LIMIT 20`,
            )
            .all(input.chatId, now(), now(), input.kind ?? null, input.kind ?? null);
          for (const row of rows) {
            const run = occurrence(row);
            const reason = staleReason({ ...run, chatId: input.chatId });
            if (reason) {
              if (!["conversation_recent", "conversation_pending"].includes(reason))
                finish(run, reason === "expired" ? "expired" : "suppressed", reason);
              continue;
            }
            if (!run.text) continue;
            const fence = crypto.randomUUID(),
              attempt = run.attempts + 1,
              watermark = latestInput(input.chatId)?.watermark ?? 0;
            db.query(
              "UPDATE core_scheduled_occurrences SET status='sending',chat_id=?,input_watermark=?,fence=?,lease_owner=?,attempts=?,updated_at=? WHERE id=?",
            ).run(input.chatId, watermark, fence, input.leaseOwner, attempt, now(), run.id);
            db.query(
              "INSERT INTO core_scheduled_deliveries(occurrence_id,attempt,fence,lease_owner,started_at) VALUES(?,?,?,?,?)",
            ).run(run.id, attempt, fence, input.leaseOwner, now());
            return readOccurrenceRaw(run.id) as ScheduledClaim;
          }
          return null;
        })
        .immediate();
    },
    recordDelivery(
      claim: ScheduledClaim,
      outcome: {
        status: "sent" | "retry" | "failed" | "unknown";
        messageId?: string;
        code?: string;
        retryAt?: string;
      },
    ): boolean {
      if (outcome.status === "sent" && !/^\d{1,30}$/.test(outcome.messageId ?? ""))
        throw new TypeError("A Telegram receipt is required.");
      if (outcome.code) code(outcome.code);
      const retryAt = outcome.status === "retry" ? dailyInstant(outcome.retryAt as string) : null;
      if (retryAt && (retryAt <= now() || claim.attempts >= 3))
        throw new TypeError("Retry limit or time is invalid.");
      return db
        .transaction(() => {
          const run =
            outcome.status === "sent"
              ? readOccurrenceRaw(claim.id)
              : validClaim(claim, ["sending"]);
          if (
            !run ||
            run.attempts !== claim.attempts ||
            run.fence !== claim.fence ||
            run.leaseOwner !== claim.leaseOwner
          )
            return false;
          const delivery = db
            .query<
              { outcome: string | null; late: string | null },
              [string, number, string, string]
            >(
              "SELECT outcome_json AS outcome,late_receipt_json AS late FROM core_scheduled_deliveries WHERE occurrence_id=? AND attempt=? AND fence=? AND lease_owner=?",
            )
            .get(run.id, run.attempts, claim.fence, claim.leaseOwner);
          if (!delivery) return false;
          if (outcome.status === "sent" && run.status === "sent")
            return run.telegramMessageId === outcome.messageId;
          if (
            !["sending", "unknown"].includes(run.status) ||
            (run.status === "unknown" && outcome.status !== "sent")
          )
            return false;
          if (delivery.outcome !== null) {
            if (
              outcome.status !== "sent" ||
              JSON.parse(delivery.outcome).status !== "unknown" ||
              delivery.late !== null
            )
              return false;
            // A late confirmed receipt improves knowledge of the old send. It grants
            // no authority to dispatch again, and retains the earlier uncertainty.
            db.query(
              "UPDATE core_scheduled_deliveries SET late_receipt_json=? WHERE occurrence_id=? AND attempt=? AND late_receipt_json IS NULL",
            ).run(JSON.stringify(outcome), run.id, run.attempts);
          }
          // A send already started may arrive after cancellation. Its receipt is factual;
          // recording it never reactivates the logical reminder or creates another send.
          db.query(
            "UPDATE core_scheduled_occurrences SET status=?,telegram_message_id=?,delivered_at=?,reason=?,next_attempt_at=?,updated_at=? WHERE id=?",
          ).run(
            outcome.status,
            outcome.messageId ?? null,
            outcome.status === "sent" ? now() : null,
            outcome.code ?? null,
            retryAt,
            now(),
            run.id,
          );
          db.query(
            "UPDATE core_scheduled_deliveries SET outcome_json=?,finished_at=? WHERE occurrence_id=? AND attempt=? AND outcome_json IS NULL",
          ).run(JSON.stringify({ ...outcome, retryAt }), now(), run.id, run.attempts);
          if (run.kind === "checkin" && ["sent", "unknown"].includes(outcome.status))
            db.query(
              "UPDATE core_checkin_slots SET closed=1,covered_keys_json=?,updated_at=? WHERE occurrence_id=?",
            ).run(JSON.stringify(run.checkin?.questionKeys ?? []), now(), run.id);
          append(
            outcome.status,
            run.id,
            outcome.status === "sent"
              ? "succeeded"
              : outcome.status === "retry"
                ? "pending"
                : "failed",
            {
              telegramMessageId: outcome.messageId ?? null,
              attempt: run.attempts,
              lateMs: Math.max(0, Date.parse(now()) - Date.parse(run.dueAt)),
            },
          );
          return true;
        })
        .immediate();
    },
    recoverInterrupted(leaseOwner: string): void {
      db.transaction(() => {
        if (!ownsLease(leaseOwner)) return;
        const rows = db
          .query<OccurrenceRow, []>(
            `SELECT ${occurrenceColumns} FROM core_scheduled_occurrences WHERE status IN ('generating','sending')`,
          )
          .all();
        for (const row of rows) {
          const run = occurrence(row);
          if (run.status === "sending") {
            db.query(
              "UPDATE core_scheduled_deliveries SET outcome_json=?,finished_at=? WHERE occurrence_id=? AND attempt=? AND outcome_json IS NULL",
            ).run(
              JSON.stringify({ status: "unknown", code: "interrupted_send" }),
              now(),
              run.id,
              run.attempts,
            );
            finish(run, "unknown", "interrupted_send");
          } else if (run.kind === "checkin") finish(run, "suppressed", "interrupted_preparation");
          else if (!prepareFallback(run, "interrupted_preparation"))
            finish(run, "failed", "interrupted_preparation");
        }
      }).immediate();
    },
    generationReceipts(occurrenceId: string) {
      return db
        .query<
          {
            fence: string;
            startedAt: string;
            finishedAt: string | null;
            resultJson: string | null;
            failureCode: string | null;
          },
          [string]
        >(
          "SELECT fence,started_at AS startedAt,finished_at AS finishedAt,result_json AS resultJson,failure_code AS failureCode FROM core_scheduled_generations WHERE occurrence_id=? ORDER BY started_at LIMIT 20",
        )
        .all(occurrenceId)
        .map(({ resultJson, ...row }) => ({
          ...row,
          result: resultJson ? JSON.parse(resultJson) : null,
        }));
    },
    syncCheckins(input: {
      chatId: string;
      candidates: CheckinCandidate[];
      dailyRevision: string;
      agreementRevision: string;
      inputWatermark: number;
    }): void {
      if (
        !input.chatId ||
        input.candidates.length > 4 ||
        !Number.isSafeInteger(input.inputWatermark)
      )
        throw new TypeError("Provide bounded check-in candidates.");
      db.transaction(() => {
        const settings = getCheckinSettings();
        db.query(
          "INSERT INTO core_checkin_state VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET daily_revision=excluded.daily_revision,agreement_revision=excluded.agreement_revision,input_watermark=excluded.input_watermark,updated_at=excluded.updated_at",
        ).run(
          input.chatId,
          input.dailyRevision,
          input.agreementRevision,
          input.inputWatermark,
          now(),
        );
        const canonical = (id: string) => {
          let current = id;
          for (let i = 0; i < 100; i++) {
            const row = db
              .query<{ next: string | null }, [string]>(
                "SELECT json_extract(record_json,'$.mergedIntoDayId') AS next FROM core_waking_days WHERE id=?",
              )
              .get(current);
            if (!row?.next) return current;
            current = row.next;
          }
          throw new TypeError("Invalid merged day chain.");
        };
        const slots = db
          .query<
            {
              dayId: string;
              slot: "morning" | "evening";
              occurrenceId: string | null;
              attempts: number;
              closed: number;
              updatedAt: string;
            },
            []
          >(
            "SELECT day_id AS dayId,slot,occurrence_id AS occurrenceId,attempts,closed,updated_at AS updatedAt FROM core_checkin_slots",
          )
          .all();
        const kept = new Set<string>();
        const proposedSlots = new Set<string>();
        if (settings.enabled)
          for (const candidate of input.candidates) {
            if (
              candidate.dailyRevision !== input.dailyRevision ||
              candidate.agreementRevision !== input.agreementRevision ||
              candidate.inputWatermark !== input.inputWatermark
            )
              throw new TypeError("Check-in candidate revisions do not match.");
            const dayId = canonical(textField(candidate.dayId, 220, "dayId"));
            const dueAt = dailyInstant(candidate.dueAt),
              earliestAt = dailyInstant(candidate.earliestAt),
              expiresAt = dailyInstant(candidate.expiresAt);
            if (expiresAt <= now() || !candidate.questions.length) continue;
            if (
              candidate.questions.length > 3 ||
              candidate.slots.length < 1 ||
              candidate.slots.length > 2 ||
              candidate.slots.some((s) => !["morning", "evening"].includes(s)) ||
              earliestAt > dueAt ||
              dueAt >= expiresAt
            )
              throw new TypeError("Invalid check-in window or question bundle.");
            for (const slot of candidate.slots) {
              const key = `${dayId}:${slot}`;
              if (proposedSlots.has(key))
                throw new TypeError(
                  "A check-in batch must propose each canonical day/slot only once.",
                );
              proposedSlots.add(key);
            }
            const questions = candidate.questions.map((q) => ({
              ...q,
              key: textField(q.key, 300, "question key"),
              title: textField(q.title, 120, "question title"),
              detail: textField(q.detail, 1200, "question detail", true),
            }));
            const plan = db
              .query<{ id: string | null; basis: string; expectedAt: string | null }, [string]>(
                "SELECT json_extract(record_json,'$.sleepPlanEventId') AS id,json_extract(record_json,'$.sleepEstimateBasis') AS basis,json_extract(record_json,'$.expectedSleepAt') AS expectedAt FROM core_waking_days WHERE id=? AND current=1",
              )
              .get(dayId);
            const contextFor = (candidateSlots: ("morning" | "evening")[]): CheckinContext => ({
              dayId,
              sleepPlanEventId: plan?.id ?? null,
              slots: candidateSlots,
              questionKeys: questions.map((q) => q.key),
              questions,
              dailyRevision: input.dailyRevision,
              agreementRevision: input.agreementRevision,
              inputWatermark: input.inputWatermark,
              settingsVersion: settings.version,
            });
            const eligible = [...new Set(candidate.slots)].filter((slot) => {
              const related = slots.filter((s) => canonical(s.dayId) === dayId && s.slot === slot);
              const closed = related.filter((s) => s.closed === 1);
              if (
                slot === "evening" &&
                closed.length &&
                plan?.basis === "owner_plan" &&
                plan.id &&
                plan.expectedAt === expiresAt &&
                expiresAt > now()
              ) {
                const planEvent = db
                  .query<
                    {
                      recordedAt: string;
                      payloadKind: string;
                      evidenceKind: string;
                      state: string;
                    },
                    [string]
                  >(
                    "SELECT recorded_at AS recordedAt,json_extract(record_json,'$.payload.kind') AS payloadKind,json_extract(record_json,'$.evidenceKind') AS evidenceKind,state FROM core_dynamic_events WHERE id=?",
                  )
                  .get(plan.id);
                const reopening = closed.every((s) => {
                  const old = s.occurrenceId ? readOccurrenceRaw(s.occurrenceId) : null;
                  return (
                    old?.status === "expired" &&
                    !old.deliveredAt &&
                    !old.telegramMessageId &&
                    old.expiresAt !== null &&
                    expiresAt > old.expiresAt &&
                    old.checkin?.sleepPlanEventId !== undefined &&
                    old.checkin.sleepPlanEventId !== plan.id &&
                    planEvent?.state === "active" &&
                    planEvent.payloadKind === "waking" &&
                    planEvent.evidenceKind === "owner_report" &&
                    planEvent.recordedAt >= old.createdAt
                  );
                });
                if (reopening)
                  for (const s of closed) {
                    db.query(
                      "UPDATE core_checkin_slots SET closed=0,updated_at=? WHERE day_id=? AND slot=?",
                    ).run(now(), s.dayId, s.slot);
                    s.closed = 0;
                  }
              }
              const matchesInFlight = related.some((s) => {
                const old = s.occurrenceId ? readOccurrenceRaw(s.occurrenceId) : null;
                return (
                  old &&
                  ["generating", "prepared", "retry"].includes(old.status) &&
                  JSON.stringify(old.checkin) === JSON.stringify(contextFor(candidate.slots)) &&
                  old.dueAt === dueAt &&
                  old.expiresAt === expiresAt
                );
              });
              return (
                (related.reduce((total, s) => total + s.attempts, 0) < 3 || matchesInFlight) &&
                !related.some(
                  (s) =>
                    s.closed === 1 ||
                    (s.occurrenceId && readOccurrenceRaw(s.occurrenceId)?.status === "sending"),
                )
              );
            });
            if (!eligible.length) continue;
            const previous = db
              .query<{ occurrenceId: string }, string[]>(
                `SELECT occurrence_id AS occurrenceId FROM core_checkin_slots WHERE day_id=? AND slot IN (${eligible.map(() => "?").join(",")}) AND occurrence_id IS NOT NULL ORDER BY slot LIMIT 1`,
              )
              .get(dayId, ...eligible);
            const old = previous?.occurrenceId ? readOccurrenceRaw(previous.occurrenceId) : null;
            const checkin = contextFor(eligible);
            const same =
              old?.checkin &&
              JSON.stringify(old.checkin) === JSON.stringify(checkin) &&
              old.dueAt === dueAt &&
              old.expiresAt === expiresAt;
            if (same && ["scheduled", "generating", "prepared", "retry"].includes(old.status)) {
              kept.add(old.id);
              continue;
            }
            if (old && ["generating", "prepared", "retry"].includes(old.status))
              finish(old, "suppressed", "checkin_context_changed");
            const lastPreparation = old
              ? db
                  .query<{ at: string | null }, [string]>(
                    "SELECT max(started_at) AS at FROM core_scheduled_generations WHERE occurrence_id=?",
                  )
                  .get(old.id)?.at
              : null;
            if (
              old &&
              old.status !== "scheduled" &&
              lastPreparation &&
              Date.parse(now()) - Date.parse(lastPreparation) < 15 * minute
            )
              continue;
            const reuseScheduled =
              old?.status === "scheduled" &&
              old.checkin?.dayId === dayId &&
              old.checkin.slots.length === eligible.length &&
              old.checkin.slots.every((slot) => eligible.includes(slot));
            if (old?.status === "scheduled" && !reuseScheduled) {
              finish(old, "suppressed", "checkin_slots_changed");
              db.query(
                "UPDATE core_checkin_slots SET occurrence_id=NULL,updated_at=? WHERE occurrence_id=? AND closed=0",
              ).run(now(), old.id);
            }
            const id = reuseScheduled ? old.id : crypto.randomUUID();
            const purpose = questions.map((q) => `${q.title}: ${q.detail}`).join("\n");
            if (reuseScheduled)
              db.query(
                "UPDATE core_scheduled_occurrences SET due_at=?,earliest_at=?,expires_at=?,checkin_json=?,purpose=?,updated_at=? WHERE id=?",
              ).run(dueAt, earliestAt, expiresAt, JSON.stringify(checkin), purpose, now(), id);
            else
              insertOccurrence({
                id,
                kind: "checkin",
                chatId: input.chatId,
                checkin,
                dueAt,
                earliestAt,
                expiresAt,
                title: "A gentle daily check-in",
                purpose,
                timezone: dailyTimezone(candidate.timezone),
                allowFallback: false,
              });
            for (const slot of eligible)
              db.query(
                "INSERT INTO core_checkin_slots(day_id,slot,occurrence_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(day_id,slot) DO UPDATE SET occurrence_id=excluded.occurrence_id,updated_at=excluded.updated_at",
              ).run(dayId, slot, id, now());
            kept.add(id);
          }
        const pending = db
          .query<OccurrenceRow, [string]>(
            `SELECT ${occurrenceColumns} FROM core_scheduled_occurrences WHERE kind='checkin' AND chat_id=? AND status IN ('scheduled','generating','prepared','retry')`,
          )
          .all(input.chatId);
        for (const row of pending) {
          const run = occurrence(row);
          if (!kept.has(run.id))
            finish(
              run,
              run.expiresAt && run.expiresAt <= now() ? "expired" : "suppressed",
              run.expiresAt && run.expiresAt <= now() ? "expired" : "checkin_context_changed",
            );
        }
      }).immediate();
    },
  };
}

export type ReminderService = ReturnType<typeof createReminderService>;
