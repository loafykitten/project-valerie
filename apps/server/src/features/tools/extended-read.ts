import {
  type AgreementPermissions,
  createAgreementService,
  createDailyService,
  createReminderService,
  DynamicValidationError,
  type ReminderPermissions,
  type Store,
} from "@valerie/core";
import type { ToolContext } from "./registry";
import { describeReminderSchedule, describeReminderTime } from "./reminder-time";

export const extendedDailyModes = [
  "help",
  "habits",
  "habit",
  "rules",
  "rule",
  "opportunities",
  "variant",
  "rule_notes",
  "habit_metrics",
  "reminders",
  "reminder",
  "occurrences",
  "occurrence",
  "reply_reminder",
];
export const extendedDailyProperties = {
  includeArchive: { type: "boolean" },
  includeClosed: { type: "boolean" },
  habitId: { type: "string", minLength: 1, maxLength: 220 },
  reminderId: { type: "string", minLength: 1, maxLength: 220 },
  period: { type: "string", enum: ["day", "week", "month"] },
  dayLimit: { type: "integer", minimum: 1, maximum: 180 },
};
export const extendedDailyDescription =
  "Read current waking/progress records, Habits, Rules and one-time reminders. mode=help explains views and offered write capabilities for indirect requests. current/events/event/day/behaviors retain daily records. time resolves localDateTime or relativeMinutes/sourceId; omit both for the labeled current server clock. habits/rules/reminders/occurrences list bounded summaries; habit/rule/reminder/occurrence/variant read an id; opportunities uses dayId, rule_notes uses id, habit_metrics accepts period/dayLimit. reply_reminder resolves the exact Telegram reminder message being replied to, without guessing which task is done. These are records and reported evidence; missing reports are not failures. Rules include expiry/window status and qualitative notes; painful disclosures are not automatic violations. Reminder reads include savedSchedule or dueLocal with application-formatted local times. Only reminder_write schedules commitments. A calculated check-in window is not a send receipt.";

export function createExtendedDailyRead(
  store: Store,
  options: {
    now?: () => Date;
    agreementPermissions?: AgreementPermissions;
    reminderPermissions?: ReminderPermissions;
    offeredToolNames?: string[];
  } = {},
) {
  const agreements = createAgreementService(store, { now: options.now }),
    reminders = createReminderService(store, { now: options.now }),
    daily = createDailyService(store, { now: options.now });
  const pinned = { ...options.agreementPermissions },
    reminderPermission = { ...options.reminderPermissions };
  const offered = new Set(options.offeredToolNames ?? ["agreement_write", "reminder_write"]);
  const capabilities = () => {
    const settings = agreements.getSettings();
    return {
      manageHabits:
        offered.has("agreement_write") &&
        pinned.manageHabits === true &&
        settings.allowValerieManageHabits === true,
      manageRules:
        offered.has("agreement_write") &&
        pinned.manageRules === true &&
        settings.allowValerieManageRules === true,
      manageReminders:
        offered.has("reminder_write") &&
        reminderPermission.manageReminders === true &&
        settings.allowValerieManageReminders === true,
    };
  };
  return {
    capabilities,
    schedulingAvailable: offered.has("reminder_write"),
    execute(input: Record<string, unknown>, context: ToolContext): unknown | undefined {
      const scope = { turnId: context.turnId };
      const behaviorSummary = (id: string) => {
        const behavior = daily.readBehavior(id, scope);
        return behavior
          ? {
              id: behavior.id,
              version: behavior.version,
              name: behavior.name,
              unit: behavior.unit,
              valueKind: behavior.valueKind,
            }
          : null;
      };
      const boundedPage = <T extends { id: string }>(items: T[]) => {
        const n = (input.limit as number | undefined) ?? 4,
          offset =
            input.cursor === undefined
              ? 0
              : items.findIndex((item) => item.id === input.cursor) + 1;
        if (input.cursor !== undefined && offset === 0)
          throw new DynamicValidationError(
            "cursor",
            "stale_cursor",
            "Reload this view without its old cursor.",
          );
        const selected = items.slice(offset, offset + n);
        return {
          items: selected,
          nextCursor: items.length > offset + n ? (selected.at(-1)?.id ?? null) : null,
        };
      };
      if (input.mode === "help")
        return {
          views: {
            daily: ["current", "events", "event", "day", "behaviors", "time"],
            agreements: extendedDailyModes.filter(
              (name) =>
                !name.startsWith("reminder") &&
                !name.startsWith("occurrence") &&
                name !== "reply_reminder" &&
                name !== "help",
            ),
            reminders: ["reminders", "reminder", "occurrences", "occurrence", "reply_reminder"],
          },
          writeCapabilities: [...offered].filter((name) =>
            [
              "growth_focus_write",
              "daily_waking",
              "daily_progress",
              "agreement_write",
              "reminder_write",
            ].includes(name),
          ),
          limits:
            "One-time reminders only, no automatic recurring nudges. Habit/rule definitions do not independently send messages. Shared progress is not an compliance or worth score.",
        };
      if (input.mode === "habits")
        return boundedPage(
          agreements
            .listHabits({ ...scope, includeArchive: input.includeArchive === true })
            .map(
              ({
                id,
                version,
                name,
                state,
                behaviorId,
                cadence,
                slots,
                effectiveAt,
                fullPractice,
                smallerPractice,
                threshold,
              }) => ({
                id,
                version,
                name,
                state,
                behaviorId,
                behavior: behaviorSummary(behaviorId),
                fullPractice,
                smallerPractice,
                threshold,
                cadence,
                slots,
                effectiveAt,
              }),
            ),
        );
      if (input.mode === "habit") {
        const habit = agreements.readHabit(input.id as string, {
          ...scope,
          revision: input.revision as number | undefined,
        });
        return {
          habit: habit ? { ...habit, behavior: behaviorSummary(habit.behaviorId) } : null,
        };
      }
      if (input.mode === "rules")
        return boundedPage(
          agreements
            .rulesAt(undefined, {
              ...scope,
              includeInactive: input.includeArchive === true,
              dayId: input.dayId as string | undefined,
            })
            .map(({ rule, phase, conditionResult }) => ({
              id: rule.id,
              version: rule.version,
              name: rule.name,
              phase,
              conditionResult,
              effectiveAt: rule.effectiveAt,
              expiresAt: rule.expiresAt,
            })),
        );
      if (input.mode === "rule")
        return {
          rule: agreements.readRule(input.id as string, {
            ...scope,
            revision: input.revision as number | undefined,
          }),
        };
      if (input.mode === "variant")
        return { variant: agreements.readVariant(input.id as string, scope) };
      if (input.mode === "opportunities") {
        const id = (input.dayId as string | undefined) ?? daily.currentDay(context.turnId)?.id;
        return boundedPage(
          id
            ? agreements
                .opportunities(id, scope)
                .map(({ definition, progress, ...opportunity }) => ({
                  ...opportunity,
                  eventCount: opportunity.eventIds.length,
                  eventIds: opportunity.eventIds.slice(-5),
                  eventIdsTruncated: opportunity.eventIds.length > 5,
                  name: definition.name,
                  behavior: behaviorSummary(definition.behaviorId),
                  threshold: definition.threshold,
                  fullPractice: definition.fullPractice,
                  smallerPractice: definition.smallerPractice,
                  progress: {
                    ...progress,
                    eventCount: progress.eventIds.length,
                    eventIds: progress.eventIds.slice(-5),
                    unresolvedEventCount: progress.unresolvedEventIds.length,
                    unresolvedEventIds: progress.unresolvedEventIds.slice(-5),
                  },
                }))
            : [],
        );
      }
      if (input.mode === "rule_notes")
        return {
          notes: agreements.ruleNotes(input.id as string, {
            ...scope,
            limit: (input.limit as number | undefined) ?? 4,
          }),
        };
      if (input.mode === "habit_metrics") {
        const metrics = agreements.metrics({
          ...scope,
          period: input.period as "day" | "week" | "month" | undefined,
          habitId: input.habitId as string | undefined,
          dayLimit: (input.dayLimit as number | undefined) ?? 30,
        });
        const n = (input.limit as number | undefined) ?? 4;
        return {
          ...metrics,
          habits: metrics.habits.slice(0, n),
          periods: metrics.periods.slice(0, n),
          returnedPeriods: Math.min(n, metrics.periods.length),
          omittedPeriods: Math.max(0, metrics.periods.length - n),
          recentObstacles: metrics.recentObstacles.slice(0, n),
        };
      }
      if (input.mode === "reminders")
        return boundedPage(
          reminders
            .list({ ...scope, includeClosed: input.includeClosed === true, limit: 100 })
            .map(({ id, version, title, state, dueAt, timezone, currentOccurrenceId }) => ({
              id,
              version,
              title,
              state,
              dueAt,
              dueLocal: describeReminderTime(dueAt, timezone),
              timezone,
              currentOccurrenceId,
            })),
        );
      if (input.mode === "reminder") {
        const reminder = reminders.read(input.id as string, scope);
        return { reminder, savedSchedule: reminder ? describeReminderSchedule(reminder) : null };
      }
      if (input.mode === "occurrences")
        return boundedPage(
          reminders
            .listOccurrences({
              ...scope,
              limit: 100,
              reminderId: input.reminderId as string | undefined,
            })
            .map(
              ({
                id,
                kind,
                reminderId,
                reminderVersion,
                title,
                dueAt,
                status,
                deliveredAt,
                telegramMessageId,
                reason,
              }) => ({
                id,
                kind,
                reminderId,
                reminderVersion,
                title,
                dueAt,
                status,
                deliveredAt,
                telegramMessageId,
                reason,
              }),
            ),
        );
      if (input.mode === "occurrence") {
        const found = reminders.readOccurrence(input.id as string, scope);
        return { occurrence: found ? { ...found, snapshot: null, result: null } : null };
      }
      if (input.mode === "reply_reminder") {
        const found = reminders.resolveReply(context.turnId);
        return {
          match: found
            ? {
                reminder: found.reminder,
                savedSchedule: describeReminderSchedule(found.reminder),
                occurrence: { ...found.occurrence, snapshot: null, result: null },
              }
            : null,
        };
      }
      return undefined;
    },
  };
}
