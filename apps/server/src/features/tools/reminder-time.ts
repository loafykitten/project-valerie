import {
  createReminderService,
  DynamicPermissionError,
  DynamicValidationError,
  type Reminder,
  ReminderConflictError,
  type ReminderPermissions,
  ReminderValidationError,
  resolveDailyLocalTime,
  resolveDailyRelativeTime,
  type Store,
} from "@valerie/core";
import type { RegisteredTool, ToolContext } from "./registry";
import { objectSchema as object, textSchema as text, versionSchema as version } from "./schema";

const timeFields = [
  "relativeMinutes",
  "localDateTime",
  "dayOffset",
  "localTime",
  "timeSourceId",
  "occurrence",
];

function localParts(at: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (name: string) => parts.find((part) => part.type === name)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    clock: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}
function timezone(value: unknown): string {
  if (typeof value !== "string")
    throw new DynamicValidationError("timezone", "invalid_timezone", "Use a valid IANA timezone.");
  try {
    localParts("2026-01-01T00:00:00.000Z", value);
    return value;
  } catch {
    throw new DynamicValidationError("timezone", "invalid_timezone", "Use a valid IANA timezone.");
  }
}
/** The same saved instant supplies both exact local fields and human-readable confirmations. */
export function describeReminderTime(at: string, zone: string) {
  const parts = localParts(at, zone),
    date = new Date(at),
    millis = date.getUTCMilliseconds();
  const display = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(date.getUTCSeconds() || millis ? { second: "2-digit" as const } : {}),
    timeZoneName: "short",
  }).format(date);
  return {
    at,
    timezone: zone,
    localDateTime: `${parts.date}T${parts.clock}${millis ? `.${String(millis).padStart(3, "0")}` : ""}`,
    display,
  };
}
export function describeReminderSchedule(reminder: Reminder) {
  return {
    due: describeReminderTime(reminder.dueAt, reminder.timezone),
    expiry: reminder.expiresAt ? describeReminderTime(reminder.expiresAt, reminder.timezone) : null,
  };
}
function localTime(value: unknown, zone: string, occurrence: unknown, field: string) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(value)
  )
    throw new DynamicValidationError(
      field,
      "local_time_required",
      "Use local YYYY-MM-DDTHH:mm with optional seconds. Do not append Z or a UTC offset; the tool applies the timezone.",
    );
  try {
    const resolved = resolveDailyLocalTime(
      value.slice(0, 16),
      zone,
      occurrence as "first" | "second" | undefined,
    );
    const seconds = value.length > 16 ? Number(value.slice(17)) : 0;
    return {
      ...resolved,
      at: new Date(
        Date.parse(resolved.at) +
          (resolved.adjustment === "gap_forward" ? 0 : Math.round(seconds * 1000)),
      ).toISOString(),
      requestedLocalDateTime: value,
    };
  } catch {
    throw new DynamicValidationError(
      field,
      "invalid_local_time",
      "Use a real local date/time and choose first or second for a repeated clock time. The tool handles timezone offsets.",
    );
  }
}
export function createTimedReminderTools(
  store: Store,
  options: { permissions?: ReminderPermissions; now?: () => Date } = {},
): RegisteredTool[] {
  const reminders = createReminderService(store, { now: options.now });
  const pinned = { ...(options.permissions ?? { manageReminders: false }) };
  const resolve = (
    input: Record<string, unknown>,
    context: ToolContext,
    zone: string,
    previous: Reminder | null,
  ) => {
    const relative = input.relativeMinutes !== undefined,
      local = input.localDateTime !== undefined;
    const calendar = input.dayOffset !== undefined || input.localTime !== undefined;
    if (Number(relative) + Number(local) + Number(calendar) === 0) {
      if (
        previous &&
        input.action === "save" &&
        !timeFields.some((key) => input[key] !== undefined)
      )
        return { at: previous.dueAt, method: "preserved" };
      throw new DynamicValidationError(
        "relativeMinutes",
        "time_required",
        "Choose relativeMinutes, localDateTime, or dayOffset plus localTime. An edit may omit timing to preserve the saved instant.",
      );
    }
    if (Number(relative) + Number(local) + Number(calendar) !== 1)
      throw new DynamicValidationError(
        "relativeMinutes",
        "conflicting_times",
        "Choose exactly one time form; do not supply a duration and a calendar time together.",
      );
    if ((relative && input.occurrence !== undefined) || (local && input.timeSourceId !== undefined))
      throw new DynamicValidationError(
        "timeSourceId",
        "unused_time_fields",
        "Use occurrence only for local clock times and timeSourceId only for relative/calendar-day times.",
      );
    if (local)
      return {
        ...localTime(input.localDateTime, zone, input.occurrence, "localDateTime"),
        method: "local",
      };
    const source = reminders.timeSource({
      turnId: context.turnId,
      sourceIds: input.sourceIds as string[],
      preferredSourceId: input.timeSourceId as string | undefined,
    });
    if (relative)
      return {
        at: resolveDailyRelativeTime(source.receivedAt, input.relativeMinutes as number, zone)
          .at as string,
        method: "relative",
        source,
        relativeMinutes: input.relativeMinutes,
      };
    if (
      !Number.isSafeInteger(input.dayOffset) ||
      typeof input.localTime !== "string" ||
      !/^\d\d:\d\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(input.localTime)
    )
      throw new DynamicValidationError(
        "dayOffset",
        "calendar_fields_required",
        "Provide dayOffset (0=today, 1=tomorrow) and localTime (HH:mm, optional seconds). Days are counted in the selected timezone from the owner request.",
      );
    const date = localParts(source.receivedAt, zone).date;
    const requestedDate = new Date(
      Date.parse(`${date}T12:00:00Z`) + Number(input.dayOffset) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    return {
      ...localTime(`${requestedDate}T${input.localTime}`, zone, input.occurrence, "localTime"),
      method: "calendar_day",
      source,
      dayOffset: input.dayOffset,
    };
  };
  return [
    {
      name: "reminder_write",
      effect: "local_write",
      allowedTurnKinds: ["user"],
      timeoutMs: 1500,
      maxOutputBytes: 16000,
      argumentHelp:
        "Use flat fields. Time: relativeMinutes (20 means twenty minutes from the current owner message), localDateTime (local date/time WITHOUT Z or offset), or dayOffset plus localTime (0=today,1=tomorrow). Do not send dueAt. save needs title,purpose,originalTimeIntent,allowFallback(boolean),sourceIds(array); new reminders need a time, edits may omit timing to retain it. snooze needs id,expectedVersion,occurrenceId,originalTimeIntent,sourceIds and a time. complete/retry_failed need id,expectedVersion,occurrenceId,sourceIds; cancel omits occurrenceId. Clear expiry explicitly with clearExpiry:true.",
      description:
        "Manage one-time reminders within owner permission. Use action=save|snooze|complete|cancel|retry_failed and flat typed fields. For 'in twenty minutes', send relativeMinutes:20; the application anchors it to the cited current owner message, including across delays/retries. For today/tomorrow at a clock time, use dayOffset:0/1 and localTime:'15:30'. For a stated calendar date use localDateTime:'2026-10-02T15:30'. NEVER calculate a UTC timestamp or add an offset; dueAt is not an accepted argument. timezone defaults to America/Chicago for a new reminder or the existing reminder's zone; a snooze keeps its saved zone. timeSourceId is optional unless multiple cited current messages have different times; select the message containing this request. Local repeated hours default to first (use occurrence:second when requested); skipped local times move to the first valid time and are reported in the result. save requires title,purpose,originalTimeIntent,allowFallback and sourceIds; omit id/expectedVersion for a new reminder, supply both for edits. Edits may omit all timing to preserve the exact instant and omit expiry to preserve it. expiresLocalDateTime sets expiry in the reminder zone; clearExpiry:true removes it. Read daily_read reminders/reminder/reply_reminder for actual IDs, versions and savedSchedule. Snooze requires ALL of: id, expectedVersion (copy the saved version from the read), occurrenceId (copy currentOccurrenceId), originalTimeIntent, sourceIds, and a time choice. complete/retry_failed require id, expectedVersion, occurrenceId, sourceIds; cancel needs no occurrenceId. An unknown delivery cannot retry automatically. Only returned confirmed outcomes establish a change: use confirmation.due.display when mentioning the saved time, without converting or recalculating it. A saved schedule is not delivery or task completion.",
      parameters: object(
        {
          action: {
            type: "string",
            enum: ["save", "snooze", "complete", "cancel", "retry_failed"],
          },
          id: text(220),
          expectedVersion: version,
          occurrenceId: text(220),
          title: text(120),
          purpose: text(1200, 0),
          originalTimeIntent: text(240, 0),
          allowFallback: { type: "boolean" },
          sourceIds: { type: "array", minItems: 1, maxItems: 5, items: text(220) },
          timezone: text(100),
          relativeMinutes: { type: "integer", minimum: 0, maximum: 525600 },
          localDateTime: text(30),
          dayOffset: { type: "integer", minimum: 0, maximum: 366 },
          localTime: text(12),
          timeSourceId: text(220),
          occurrence: { type: "string", enum: ["first", "second"] },
          expiresLocalDateTime: text(30),
          expiryOccurrence: { type: "string", enum: ["first", "second"] },
          clearExpiry: { type: "boolean" },
        },
        ["action", "sourceIds"],
      ),
      outputSchema: { type: "object", additionalProperties: true },
      execute(input, context) {
        if (!pinned.manageReminders || !reminders.getPermissions().manageReminders)
          throw new DynamicPermissionError("manageReminders");
        const action = input.action as string;
        const allowed =
          action === "save"
            ? [
                "id",
                "expectedVersion",
                "title",
                "purpose",
                "originalTimeIntent",
                "allowFallback",
                "timezone",
                ...timeFields,
                "expiresLocalDateTime",
                "expiryOccurrence",
                "clearExpiry",
              ]
            : action === "snooze"
              ? [
                  "id",
                  "expectedVersion",
                  "occurrenceId",
                  "originalTimeIntent",
                  "timezone",
                  ...timeFields,
                ]
              : action === "cancel"
                ? ["id", "expectedVersion"]
                : ["id", "expectedVersion", "occurrenceId"];
        if (Object.keys(input).some((key) => !["action", "sourceIds", ...allowed].includes(key)))
          throw new DynamicValidationError(
            "action",
            "wrong_action_fields",
            "Provide only fields for the selected action. Time choices belong to save or snooze.",
          );
        const required =
          action === "save"
            ? ["title", "purpose", "originalTimeIntent", "allowFallback"]
            : action === "snooze"
              ? ["id", "expectedVersion", "occurrenceId", "originalTimeIntent"]
              : action === "cancel"
                ? ["id", "expectedVersion"]
                : ["id", "expectedVersion", "occurrenceId"];
        const missing = required.filter((key) => input[key] === undefined);
        if (missing.length)
          throw new DynamicValidationError(
            missing[0] as string,
            "missing_fields",
            `Missing: ${missing.join(", ")}. Keep your other fields and add these before retrying. Copy expectedVersion from the reminder.version returned by daily_read; never guess it. originalTimeIntent is the owner's short timing phrase.`,
          );
        if (action === "save" && (input.id === undefined) !== (input.expectedVersion === undefined))
          throw new DynamicValidationError(
            "expectedVersion",
            "identity_pair",
            "An edit requires both id and expectedVersion; a new reminder omits both.",
          );
        const previous =
          typeof input.id === "string"
            ? reminders.read(input.id, { turnId: context.turnId })
            : null;
        if (input.id !== undefined && !previous)
          throw new DynamicValidationError(
            "id",
            "not_found",
            "Read an available reminder from this conversation before changing it.",
          );
        const mutation = {
          actor: "valerie" as const,
          turnId: context.turnId,
          operationKey: context.operationKey,
          permissions: pinned,
        };
        try {
          let reminder: Reminder, resolution: Record<string, unknown> | undefined;
          if (action === "save" || action === "snooze") {
            const zone = timezone(input.timezone ?? previous?.timezone ?? "America/Chicago");
            if (action === "snooze" && input.timezone !== undefined && zone !== previous?.timezone)
              throw new DynamicValidationError(
                "timezone",
                "edit_timezone",
                "A snooze uses the saved reminder timezone. Use a full save edit to change its timezone.",
              );
            const resolved = resolve(input, context, zone, previous);
            resolution = resolved;
            if (action === "save") {
              if (
                (input.clearExpiry === true && input.expiresLocalDateTime !== undefined) ||
                (input.expiryOccurrence !== undefined && input.expiresLocalDateTime === undefined)
              )
                throw new DynamicValidationError(
                  "expiresLocalDateTime",
                  "conflicting_expiry",
                  "Choose a local expiry or clearExpiry:true; expiryOccurrence requires a local expiry.",
                );
              const expiry =
                input.expiresLocalDateTime !== undefined
                  ? localTime(
                      input.expiresLocalDateTime,
                      zone,
                      input.expiryOccurrence,
                      "expiresLocalDateTime",
                    )
                  : null;
              if (expiry) resolution = { ...resolved, expiry };
              reminder = reminders.saveReminder(
                {
                  title: input.title as string,
                  purpose: input.purpose as string,
                  dueAt: resolved.at,
                  timezone: zone,
                  originalTimeIntent: input.originalTimeIntent as string,
                  allowFallback: input.allowFallback as boolean,
                  expiresAt:
                    input.clearExpiry === true ? null : (expiry?.at ?? previous?.expiresAt ?? null),
                  sourceIds: input.sourceIds as string[],
                  ...(previous
                    ? { id: previous.id, expectedVersion: input.expectedVersion as number }
                    : {}),
                },
                mutation,
              );
            } else
              reminder = reminders.snooze(
                {
                  id: input.id as string,
                  expectedVersion: input.expectedVersion as number,
                  occurrenceId: input.occurrenceId as string,
                  dueAt: resolved.at,
                  originalTimeIntent: input.originalTimeIntent as string,
                  sourceIds: input.sourceIds as string[],
                },
                mutation,
              );
          } else {
            const fields = {
              id: input.id as string,
              expectedVersion: input.expectedVersion as number,
              occurrenceId: input.occurrenceId as string,
              sourceIds: input.sourceIds as string[],
            };
            reminder =
              action === "complete"
                ? reminders.complete(fields, mutation)
                : action === "cancel"
                  ? reminders.cancel(fields, mutation)
                  : reminders.retryFailed(fields, mutation);
          }
          const occurrence = reminders.readOccurrence(reminder.currentOccurrenceId);
          return {
            confirmation: {
              action,
              title: reminder.title,
              taskState: reminder.state,
              occurrenceState: occurrence?.status ?? null,
              deliveryConfirmed: Boolean(occurrence?.telegramMessageId),
              ...describeReminderSchedule(reminder),
            },
            reminder,
            occurrence: occurrence ? { ...occurrence, snapshot: null, result: null } : null,
            ...(resolution ? { timeResolution: resolution } : {}),
          };
        } catch (error) {
          if (error instanceof ReminderConflictError)
            throw new DynamicValidationError("expectedVersion", "reminder_conflict", error.message);
          if (error instanceof ReminderValidationError)
            throw new DynamicValidationError(error.field, error.reason, error.message);
          throw error;
        }
      },
    },
  ];
}
