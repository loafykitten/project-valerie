import { createHash } from "node:crypto";
import {
  type AgreementPermissions,
  createAgreementService,
  createDailyService,
  type DailyEventEdit,
  type DailyMutationContext,
  type DailyPermissions,
  DynamicConflictError,
  DynamicValidationError,
  type ProgressReportInput,
  type ReminderPermissions,
  type ReportedTime,
  resolveDailyLocalTime,
  resolveDailyRelativeTime,
  type Store,
  type WakingDay,
  type WakingReportInput,
} from "@valerie/core";
import {
  createExtendedDailyRead,
  extendedDailyDescription,
  extendedDailyModes,
  extendedDailyProperties,
} from "./extended-read";
import type { RegisteredTool, ToolContext } from "./registry";
import { versionSchema as integer, objectSchema as object } from "./schema";

const string = (maxLength: number, description?: string) => ({
  type: "string",
  minLength: 1,
  maxLength,
  ...(description ? { description } : {}),
});
const sourceIds = {
  type: "array",
  minItems: 1,
  maxItems: 5,
  items: string(220),
  description:
    "Original owner conversation:... source IDs in this chat. Current waking state requires an original owner input in this turn, whose latest accepted owner input still belongs to this turn. Forwarded/quoted/older text cannot be a fresh wake. Memory IDs and assistant claims are not owner evidence.",
};
const timing = {
  timeBasis: {
    type: "string",
    enum: ["message_time", "exact", "relative", "unknown"],
    description:
      "Default message_time uses the original supporting owner message time in code. Use unknown when event timing is unclear; omit occurredAt then. Exact/relative require a supported UTC timestamp with an offset; daily_read can resolve local or relative time.",
  },
  occurredAt: string(40),
  timezone: string(100, "IANA timezone; defaults to America/Chicago."),
  originalLocalIntent: string(
    160,
    "Optional original owner time phrase; it is evidence, not a schedule.",
  ),
};
const progressFields = {
  mode: {
    type: "string",
    enum: ["occurrence", "total_so_far", "status", "plan", "interpretation"],
    description:
      "total_so_far records a total including earlier occurrences; occurrence adds a distinct reported amount. For a count with known quantity, use value in its saved unit (2 minutes means value 2), not only partial status. Use status for qualitative-only reports or skipped/excused. Plans and interpretations never count.",
  },
  value: {
    type: "integer",
    minimum: 0,
    maximum: 1000000,
    description:
      "Reported amount in the behavior's saved unit: two minutes means 2, not one session. Never infer a quantity from status alone.",
  },
  status: {
    type: "string",
    enum: ["done", "partial", "skipped", "excused"],
    description:
      "Only for mode=status; omit this field for numeric occurrence or total_so_far reports.",
  },
  totalThroughAt: string(
    40,
    "For a reported total, UTC cutoff through which earlier occurrences are included. Do not add a total to those occurrences.",
  ),
  plannedFor: string(40, "Future intention time, not a scheduled reminder."),
  evidenceKind: { type: "string", enum: ["owner_report", "valerie_interpretation"] },
};
const defaults = {
  allowedTurnKinds: ["user"] as const,
  timeoutMs: 1000,
  maxOutputBytes: 24000,
  outputSchema: { type: "object", additionalProperties: true },
};
const timeFields = Object.keys(timing);
function fieldsForAction(input: Record<string, unknown>, allowed: string[]) {
  const fields = new Set(["action", "sourceIds", ...allowed]);
  if (Object.keys(input).some((key) => !fields.has(key)))
    throw new DynamicValidationError(
      "action",
      "unexpected_field",
      "Some supplied fields belong to a different daily action. Use only the fields described for this action.",
    );
}
function requireFields(input: Record<string, unknown>, fields: string[], guidance: string) {
  const missing = fields.filter(
    (key) => input[key] === undefined || input[key] === null || input[key] === "",
  );
  if (missing.length)
    throw new DynamicValidationError(
      missing[0] as string,
      "missing_fields",
      `${guidance} Missing: ${missing.join(", ")}.`,
    );
}

function occurred(input: Record<string, unknown>): ReportedTime {
  return {
    basis: (input.timeBasis as ReportedTime["basis"] | undefined) ?? "message_time",
    at: (input.occurredAt as string | undefined) ?? null,
    timezone: (input.timezone as string | undefined) ?? "America/Chicago",
    ...(input.originalLocalIntent === undefined
      ? {}
      : { originalLocalIntent: input.originalLocalIntent as string }),
  };
}

/** Three capabilities keep memory + focus + image + daily tools inside the existing 16-tool bound. */
export function createDailyTools(
  store: Store,
  options: {
    permissions?: DailyPermissions;
    now?: () => Date;
    currentDay?: Pick<WakingDay, "id" | "version"> | null;
    extended?: boolean;
    habitPractice?: boolean;
    agreementPermissions?: AgreementPermissions;
    reminderPermissions?: ReminderPermissions;
    offeredToolNames?: string[];
  } = {},
): RegisteredTool[] {
  const daily = createDailyService(store, { now: options.now });
  const extended = options.extended ? createExtendedDailyRead(store, options) : null;
  const habitPracticeEnabled = options.extended === true && options.habitPractice === true;
  const agreements = habitPracticeEnabled
    ? createAgreementService(store, { now: options.now })
    : null;
  const habitPermissions = {
    ...(options.agreementPermissions ?? { manageHabits: false, manageRules: false }),
  };
  const writeScheduling = extended
    ? { schedulingAvailable: extended.schedulingAvailable, scheduledByThisAction: false }
    : { schedulingAvailable: false };
  const pinned = { ...(options.permissions ?? { manageWaking: false, manageProgress: false }) };
  const hasPinnedDay = options.currentDay !== undefined;
  const pinnedDay = options.currentDay
    ? { id: options.currentDay.id, version: options.currentDay.version }
    : null;
  const contextFor = (context: ToolContext): DailyMutationContext => ({
    actor: "valerie",
    turnId: context.turnId,
    operationKey: context.operationKey,
    permissions: pinned,
  });
  const permissions = () => {
    const settings = daily.getSettings();
    return {
      manageWaking: pinned.manageWaking && settings.allowValerieManageWaking === true,
      manageProgress: pinned.manageProgress && settings.allowValerieManageProgress === true,
      ...(extended ? extended.capabilities() : {}),
    };
  };
  const eventFor = (id: unknown, kind: "waking" | "progress", context: ToolContext) => {
    const event = typeof id === "string" ? daily.readEvent(id, { turnId: context.turnId }) : null;
    if (!event || event.payload.kind !== kind)
      throw new DynamicValidationError(
        "id",
        "event_unavailable",
        `Read a visible ${kind} event before correcting or voiding it.`,
      );
    return event;
  };
  const edit = (
    input: Record<string, unknown>,
    kind: "waking" | "progress",
    context: ToolContext,
  ): DailyEventEdit => {
    eventFor(input.id, kind, context);
    return {
      id: input.id as string,
      expectedVersion: input.expectedVersion as number,
      sourceIds: input.sourceIds as string[],
      ...(input.summary === undefined ? {} : { summary: input.summary as string }),
      ...(input.timeBasis === undefined && input.occurredAt === undefined
        ? {}
        : { occurred: occurred(input) }),
      ...(input.wakingDayId === undefined && input.unassignDay !== true
        ? {}
        : { wakingDayId: input.unassignDay === true ? null : (input.wakingDayId as string) }),
      ...(kind !== "progress" || input.mode === undefined
        ? {}
        : {
            progress: {
              mode: input.mode as ProgressReportInput["mode"],
              ...(input.value === undefined ? {} : { value: input.value as number }),
              ...(input.status === undefined
                ? {}
                : { status: input.status as ProgressReportInput["status"] }),
              ...(input.totalThroughAt === undefined
                ? {}
                : { totalThroughAt: input.totalThroughAt as string }),
              ...(input.plannedFor === undefined ? {} : { plannedFor: input.plannedFor as string }),
              ...(input.evidenceKind === undefined
                ? {}
                : { evidenceKind: input.evidenceKind as ProgressReportInput["evidenceKind"] }),
            },
          }),
    };
  };
  const definitions: RegisteredTool[] = [
    {
      ...defaults,
      effect: "read",
      name: "daily_read",
      description: extended
        ? extendedDailyDescription
        : "Read waking days, configured progress behaviors and original reported events before writing or correcting. mode=current returns compact current state and permissions; events supports day/behavior filters; event/day reads an ID; behaviors lists configured tracking subjects. Windows are calculations only: there is no reminder scheduler, Habits or Rules feature yet. mode=time resolves localDateTime in timezone, relativeMinutes from an original sourceId, or the current server clock when both are omitted. Read indirect reports naturally; never infer a new wake or completed behavior from silence, quoted greetings or a plan.",
      parameters: object({
        mode: {
          type: "string",
          enum: [
            "current",
            "events",
            "event",
            "day",
            "behaviors",
            "time",
            ...(extended ? extendedDailyModes : []),
          ],
        },
        id: string(220),
        dayId: string(220),
        behaviorId: string(220),
        unassigned: { type: "boolean" },
        cursor: string(220),
        revision: integer,
        limit: { type: "integer", minimum: 1, maximum: 4 },
        localDateTime: string(
          16,
          "Local YYYY-MM-DDTHH:mm; requires timezone. Missing local time is moved to the first valid time that day.",
        ),
        timezone: string(100),
        occurrence: { type: "string", enum: ["first", "second"] },
        relativeMinutes: { type: "integer", minimum: -525600, maximum: 525600 },
        sourceId: string(220),
        ...(extended ? extendedDailyProperties : {}),
      }),
      execute: (input, context) => {
        const access = {
          permissions: permissions(),
          schedulingAvailable: extended?.schedulingAvailable ?? false,
        };
        const extendedResult = extended?.execute(input, context);
        if (extendedResult !== undefined)
          return { ...access, ...(extendedResult as Record<string, unknown>) };
        if (input.mode === "time") {
          if (typeof input.relativeMinutes === "number") {
            if (typeof input.sourceId !== "string" || !input.sourceId.startsWith("conversation:"))
              throw new DynamicValidationError(
                "sourceId",
                "source_unavailable",
                "Provide an original owner source for relative time.",
              );
            const source = store.db
              .query<{ at: string }, [string, string]>(`
              SELECT i.received_at AS at FROM core_telegram_inputs i
                JOIN core_conversation_turns source ON source.id=i.turn_id
                JOIN core_conversation_turns target ON target.id=?
              WHERE i.id=? AND i.chat_id=target.chat_id AND i.sender_id=target.sender_id
                AND source.rowid<=target.rowid AND i.received_at<=target.received_at
            `)
              .get(context.turnId, input.sourceId.slice("conversation:".length));
            if (!source)
              throw new DynamicValidationError(
                "sourceId",
                "source_unavailable",
                "The source is not available to this conversation turn.",
              );
            return {
              ...access,
              time: resolveDailyRelativeTime(
                source.at,
                input.relativeMinutes,
                (input.timezone as string | undefined) ?? "America/Chicago",
              ),
            };
          }
          if (input.localDateTime === undefined) {
            const current = resolveDailyRelativeTime(
              (options.now ?? (() => new Date()))().toISOString(),
              0,
              (input.timezone as string | undefined) ?? "America/Chicago",
            );
            return {
              ...access,
              time: { ...current, basis: "exact", reference: "current_server_clock" },
              meaning:
                "Current server clock only; no event time, schedule or waking state was inferred or saved.",
            };
          }
          return {
            ...access,
            time: resolveDailyLocalTime(
              input.localDateTime as string,
              (input.timezone as string | undefined) ?? "America/Chicago",
              input.occurrence as "first" | "second" | undefined,
            ),
          };
        }
        if (input.mode === "event")
          return {
            ...access,
            event: daily.readEvent(input.id as string, {
              revision: input.revision as number | undefined,
              turnId: context.turnId,
            }),
          };
        if (input.mode === "day")
          return { ...access, day: daily.readDay(input.id as string, { turnId: context.turnId }) };
        if (input.mode === "events")
          return {
            ...access,
            ...daily.listEvents({
              ...(input.unassigned === true
                ? { dayId: null }
                : input.dayId === undefined
                  ? {}
                  : { dayId: input.dayId as string }),
              behaviorId: input.behaviorId as string | undefined,
              cursor: input.cursor as string | undefined,
              limit: (input.limit as number | undefined) ?? 4,
              turnId: context.turnId,
            }),
          };
        const overview = daily.overview({
          turnId: context.turnId,
          limit: (input.limit as number | undefined) ?? 4,
        });
        const limit = (input.limit as number | undefined) ?? 4;
        const summaries = overview.behaviors.map(
          ({ id, version, name, unit, valueKind, aggregation, state }) => ({
            id,
            version,
            name,
            unit,
            valueKind,
            aggregation,
            state,
          }),
        );
        const cursorIndex =
          input.cursor === undefined ? -1 : summaries.findIndex(({ id }) => id === input.cursor);
        if (input.mode === "behaviors" && input.cursor !== undefined && cursorIndex === -1)
          throw new DynamicValidationError(
            "cursor",
            "stale_cursor",
            "Reload the behavior list without its old cursor.",
          );
        const offset = input.mode === "behaviors" ? cursorIndex + 1 : 0;
        const selected = summaries.slice(offset, offset + limit);
        const nextCursor = summaries.length > offset + limit ? (selected.at(-1)?.id ?? null) : null;
        if (input.mode === "behaviors") return { ...access, items: selected, nextCursor };
        return {
          ...access,
          settingsVersion: overview.settings.version,
          currentDay: overview.currentDay,
          days: overview.days,
          events: overview.events,
          behaviors: selected,
          nextBehaviorCursor: nextCursor,
          progress: overview.progress
            .filter((item) => selected.some(({ id }) => id === item.behaviorId))
            .map((item) => ({
              ...item,
              eventIds: item.eventIds.slice(-5),
              unresolvedEventIds: item.unresolvedEventIds.slice(-5),
            })),
          windows: overview.windows,
        };
      },
    },
    {
      ...defaults,
      effect: "local_write",
      name: "daily_waking",
      description:
        "Record source-linked waking/sleep-plan continuity, or correct/void a waking event, within delegated waking permission. A fresh original, unqualified Good morning that introduces the owner's new waking period should be recorded with report=day_start, even at an unusual clock hour and without a prior bedtime report. This records her declared day boundary, not physical sleep. The saved current day is the last reported state, not proof she stayed awake. Repeated greetings within the same period, nap wakes and explicit continued wakefulness keep the same day. Use day_start for the declared boundary; main_wake remains compatible for explicit waking reports. action=report needs report, summary, sourceIds and the expectedCurrentDayId/expectedDayVersion supplied in current context or daily_read (omit both when no day exists). Default timeBasis=message_time uses source time. Include an exact evidenceQuote from an original owner input in this still-current turn. Forwarded/quoted text, history, midnight, silence and routine hours alone cannot start a day. action=correct needs event id/expectedVersion and changed fields; action=void needs event id/expectedVersion. No action schedules a message.",
      parameters: object(
        {
          action: { type: "string", enum: ["report", "correct", "void"] },
          report: {
            type: "string",
            enum: [
              "day_start",
              "main_wake",
              "awake_update",
              "main_sleep_intent",
              "nap_intent",
              "nap_wake",
              "sleep_plan",
              "uncertain",
            ],
          },
          mode: { type: "string", enum: ["current", "history"] },
          expectedCurrentDayId: string(220),
          expectedDayVersion: integer,
          id: string(220),
          expectedVersion: integer,
          wakingDayId: string(220),
          unassignDay: { type: "boolean" },
          summary: string(
            800,
            "Required for action=report. Give a short summary of the owner's actual report, including a nap or awake update.",
          ),
          sourceIds,
          evidenceQuote: string(400),
          newMainPeriod: { type: "boolean" },
          expectedSleepAt: string(40),
          clearExpectedSleep: { type: "boolean" },
          sleepEstimateBasis: { type: "string", enum: ["owner_plan", "usual_routine", "none"] },
          ...timing,
        },
        ["action", "sourceIds"],
      ),
      execute: (input, context) => {
        fieldsForAction(
          input,
          input.action === "void"
            ? ["id", "expectedVersion"]
            : input.action === "correct"
              ? ["id", "expectedVersion", "summary", "wakingDayId", "unassignDay", ...timeFields]
              : [
                  "report",
                  "mode",
                  "expectedCurrentDayId",
                  "expectedDayVersion",
                  "wakingDayId",
                  "summary",
                  "evidenceQuote",
                  "newMainPeriod",
                  "expectedSleepAt",
                  "clearExpectedSleep",
                  "sleepEstimateBasis",
                  ...timeFields,
                ],
        );
        requireFields(
          input,
          input.action === "report" ? ["report", "summary"] : ["id", "expectedVersion"],
          input.action === "report"
            ? "Every waking report needs report and summary. For a current day also supply expectedCurrentDayId and expectedDayVersion from daily_read or the pinned current-day context; omit those two only when no day exists."
            : "Correcting or voiding a waking event needs its saved id and current expectedVersion.",
        );
        if (input.action === "correct")
          return {
            ...daily.reviseEvent(edit(input, "waking", context), contextFor(context)),
            ...writeScheduling,
          };
        if (input.action === "void") {
          eventFor(input.id, "waking", context);
          return {
            ...daily.voidEvent(
              {
                id: input.id as string,
                expectedVersion: input.expectedVersion as number,
                sourceIds: input.sourceIds as string[],
              },
              contextFor(context),
            ),
            ...writeScheduling,
          };
        }
        const usePinnedDay =
          hasPinnedDay &&
          input.expectedCurrentDayId === undefined &&
          input.expectedDayVersion === undefined;
        const report: WakingReportInput = {
          report: input.report as WakingReportInput["report"],
          mode: (input.mode as WakingReportInput["mode"] | undefined) ?? "current",
          expectedCurrentDayId: usePinnedDay
            ? (pinnedDay?.id ?? null)
            : ((input.expectedCurrentDayId as string | undefined) ?? null),
          expectedDayVersion: usePinnedDay
            ? (pinnedDay?.version ?? null)
            : ((input.expectedDayVersion as number | undefined) ?? null),
          occurred: occurred(input),
          summary: input.summary as string,
          sourceIds: input.sourceIds as string[],
          ...(input.wakingDayId === undefined ? {} : { wakingDayId: input.wakingDayId as string }),
          ...(input.evidenceQuote === undefined
            ? {}
            : { evidenceQuote: input.evidenceQuote as string }),
          ...(input.newMainPeriod === undefined
            ? {}
            : { newMainPeriod: input.newMainPeriod as boolean }),
          ...(input.expectedSleepAt === undefined && input.clearExpectedSleep !== true
            ? {}
            : {
                expectedSleepAt:
                  input.clearExpectedSleep === true ? null : (input.expectedSleepAt as string),
              }),
          ...(input.sleepEstimateBasis === undefined
            ? {}
            : {
                sleepEstimateBasis:
                  input.sleepEstimateBasis as WakingReportInput["sleepEstimateBasis"],
              }),
        };
        return {
          ...daily.recordWakingReport(report, contextFor(context)),
          ...writeScheduling,
        };
      },
    },
    {
      ...defaults,
      effect: "local_write",
      name: "daily_progress",
      ...(habitPracticeEnabled
        ? {
            argumentHelp:
              "For a numeric report use mode=occurrence or total_so_far and numeric value in the saved unit; omit status. An explicit full/smaller practice can be saved in the same action=report using habitPractice:{habitId,definitionVersion,variant}, with variant full or smaller and the pinned opportunity version. All three practice fields are required. sourceIds must remain an array.",
          }
        : {}),
      description:
        "Manage shared reported progress within delegated progress permission. action=configure_behavior needs name/unit/valueKind and original owner sources supporting actual tracking; it creates a tracking subject, never a habit target or rule. For edits also provide id/expectedVersion. action=report needs behaviorId, summary, mode, sourceIds and a known wakingDayId (omit when unassigned). occurrence increments a distinct action; total_so_far is a total through its cutoff, not another increment. Plans, interpretations, silence and delivered messages do not count as completion. Read matching events first; for another mention of the same action use sameEventId/expectedEventVersion. Ambiguous references should be clarified, not counted again. action=correct needs event id/expectedVersion plus changed fields; action=void removes its current effect while retaining history. Honest painful feelings are disclosures, not automatic rule violations. This progress tool cannot claim integration observations or schedule reminders." +
        (habitPracticeEnabled
          ? ' When the owner reports doing a saved full or smaller habit practice, action=report can save its explicit classification together with the shared report: add habitPractice:{habitId,definitionVersion,variant:"full"|"smaller"}. Get the pinned definitionVersion from daily_read opportunities. Keep the actual numeric value in the saved unit; for two minutes of an agreed smaller practice, use value=2 and variant="smaller" together. This writes one report plus its linked practice tag atomically, requiring both progress and habit permission. It does not add another count. Omit habitPractice when no classification is supported. Only a successful practiceVariant receipt proves the tag was saved; agreement_write log_variant remains available for tagging an older report.'
          : ""),
      parameters: object(
        {
          action: { type: "string", enum: ["configure_behavior", "report", "correct", "void"] },
          id: string(220),
          expectedVersion: integer,
          name: string(120),
          unit: string(40),
          valueKind: { type: "string", enum: ["count", "status"] },
          behaviorState: { type: "string", enum: ["active", "archived"] },
          behaviorId: string(220),
          wakingDayId: string(220),
          unassignDay: { type: "boolean" },
          summary: string(
            800,
            "Required for action=report, including an existing-action reference. Summarize the supported report without inventing completion.",
          ),
          sourceIds,
          sameEventId: string(220),
          expectedEventVersion: integer,
          ...timing,
          ...progressFields,
          ...(habitPracticeEnabled
            ? {
                habitPractice: object(
                  {
                    habitId: string(220),
                    definitionVersion: integer,
                    variant: { type: "string", enum: ["full", "smaller"] },
                  },
                  ["habitId", "definitionVersion", "variant"],
                ),
              }
            : {}),
        },
        ["action", "sourceIds"],
      ),
      execute: (input, context) => {
        fieldsForAction(
          input,
          input.action === "void"
            ? ["id", "expectedVersion"]
            : input.action === "configure_behavior"
              ? ["id", "expectedVersion", "name", "unit", "valueKind", "behaviorState"]
              : input.action === "correct"
                ? [
                    "id",
                    "expectedVersion",
                    "summary",
                    "wakingDayId",
                    "unassignDay",
                    ...timeFields,
                    ...Object.keys(progressFields),
                  ]
                : [
                    "behaviorId",
                    "wakingDayId",
                    "summary",
                    "sameEventId",
                    "expectedEventVersion",
                    ...(habitPracticeEnabled ? ["habitPractice"] : []),
                    ...timeFields,
                    ...Object.keys(progressFields),
                  ],
        );
        requireFields(
          input,
          input.action === "configure_behavior"
            ? ["name", "unit", "valueKind"]
            : input.action === "report"
              ? ["behaviorId", "summary", "mode"]
              : ["id", "expectedVersion"],
          "Provide all fields required for the selected progress action. Read the saved behavior/event first if its identity or current version is unknown.",
        );
        if (input.action === "configure_behavior") {
          if (input.id !== undefined)
            requireFields(
              input,
              ["expectedVersion"],
              "Editing a behavior requires its current version.",
            );
          else if (input.expectedVersion !== undefined)
            throw new DynamicValidationError(
              "id",
              "missing_fields",
              "An edit needs the saved behavior id. For a new behavior omit id and expectedVersion.",
            );
        }
        if (input.action === "report" || input.action === "correct") {
          if (
            habitPracticeEnabled &&
            input.action === "report" &&
            ["occurrence", "total_so_far"].includes(input.mode as string) &&
            input.status !== undefined
          )
            throw new DynamicValidationError(
              "status",
              "wrong_report_mode",
              "Numeric reports use value in the saved unit; omit status. If an agreed full/smaller classification is intended, use habitPractice on this report instead. Nothing was saved.",
            );
          if (input.mode === "occurrence" || input.mode === "total_so_far")
            requireFields(input, ["value"], "A count report requires its supported value.");
          if (input.mode === "status")
            requireFields(
              input,
              ["status"],
              "A status report requires done, partial, skipped or excused.",
            );
        }
        if (input.action === "report" && input.sameEventId !== undefined)
          requireFields(
            input,
            ["expectedEventVersion"],
            "Linking an existing action requires its current expectedEventVersion.",
          );
        if (
          input.action === "report" &&
          input.expectedEventVersion !== undefined &&
          input.sameEventId === undefined
        )
          throw new DynamicValidationError(
            "sameEventId",
            "missing_fields",
            "An existing-action version must accompany its sameEventId.",
          );
        if (input.action === "configure_behavior")
          return {
            behavior: daily.saveBehavior(
              {
                name: input.name as string,
                unit: input.unit as string,
                valueKind: input.valueKind as "count" | "status",
                sourceIds: input.sourceIds as string[],
                ...(input.id === undefined
                  ? {}
                  : { id: input.id as string, expectedVersion: input.expectedVersion as number }),
                ...(input.behaviorState === undefined
                  ? {}
                  : { state: input.behaviorState as "active" | "archived" }),
              },
              contextFor(context),
            ),
            ...writeScheduling,
          };
        if (input.action === "correct")
          return {
            ...daily.reviseEvent(edit(input, "progress", context), contextFor(context)),
            ...writeScheduling,
          };
        if (input.action === "void") {
          eventFor(input.id, "progress", context);
          return {
            ...daily.voidEvent(
              {
                id: input.id as string,
                expectedVersion: input.expectedVersion as number,
                sourceIds: input.sourceIds as string[],
              },
              contextFor(context),
            ),
            ...writeScheduling,
          };
        }
        const report = daily.recordProgressReport(
          {
            behaviorId: input.behaviorId as string,
            wakingDayId: (input.wakingDayId as string | undefined) ?? null,
            occurred: occurred(input),
            summary: input.summary as string,
            mode: input.mode as ProgressReportInput["mode"],
            sourceIds: input.sourceIds as string[],
            ...(input.value === undefined ? {} : { value: input.value as number }),
            ...(input.status === undefined
              ? {}
              : { status: input.status as ProgressReportInput["status"] }),
            ...(input.totalThroughAt === undefined
              ? {}
              : { totalThroughAt: input.totalThroughAt as string }),
            ...(input.plannedFor === undefined ? {} : { plannedFor: input.plannedFor as string }),
            ...(input.sameEventId === undefined
              ? {}
              : {
                  sameEventId: input.sameEventId as string,
                  expectedEventVersion: input.expectedEventVersion as number,
                }),
            ...(input.evidenceKind === undefined
              ? {}
              : { evidenceKind: input.evidenceKind as ProgressReportInput["evidenceKind"] }),
          },
          contextFor(context),
        );
        if (input.habitPractice !== undefined && agreements) {
          const practice = input.habitPractice as {
            habitId: string;
            definitionVersion: number;
            variant: "full" | "smaller";
          };
          if (!report.event?.wakingDayId)
            throw new DynamicValidationError(
              "wakingDayId",
              "practice_day_required",
              "A practice tag needs the report's saved waking day. No part of this combined action was saved.",
            );
          try {
            const practiceVariant = agreements.logVariant(
              {
                habitId: practice.habitId,
                definitionVersion: practice.definitionVersion,
                variant: practice.variant,
                wakingDayId: report.event.wakingDayId,
                eventId: report.event.id,
                expectedEventVersion: report.event.version,
                sourceIds: input.sourceIds as string[],
              },
              {
                actor: "valerie",
                turnId: context.turnId,
                operationKey: `habit-practice:${createHash("sha256").update(context.operationKey).digest("hex")}`,
                permissions: habitPermissions,
              },
            );
            return { ...report, practiceVariant, ...writeScheduling };
          } catch (error) {
            if (error instanceof DynamicConflictError)
              throw new DynamicValidationError(
                "habitPractice.definitionVersion",
                "habit_practice_conflict",
                "The saved habit opportunity or report changed. Read daily_read opportunities for its pinned definitionVersion. No part of this combined action was saved.",
              );
            if (error instanceof TypeError && !(error instanceof DynamicValidationError))
              throw new DynamicValidationError(
                "habitPractice",
                "invalid_practice_report",
                "The tag must match an agreed full/smaller practice and an actual positive report for that behavior and day. A full tag requires the full target; plans, interpretations and skipped/excused reports do not qualify. No part of this combined action was saved.",
              );
            throw error;
          }
        }
        return {
          ...report,
          ...writeScheduling,
        };
      },
    },
  ];
  return definitions.map((definition) => ({
    ...definition,
    execute(input, context) {
      try {
        return definition.execute(input, context);
      } catch (error) {
        if (error instanceof DynamicConflictError)
          throw new DynamicValidationError(
            definition.name === "daily_waking" && input.action === "report"
              ? "expectedDayVersion"
              : "expectedVersion",
            "daily_conflict",
            error.message,
          );
        throw error;
      }
    },
  }));
}
