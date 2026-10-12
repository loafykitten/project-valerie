import {
  createReminderService,
  DynamicValidationError,
  ReminderConflictError,
  type ReminderPermissions,
  type ReminderSaveInput,
  ReminderValidationError,
  type Store,
} from "@valerie/core";
import { type RegisteredTool, validateToolInput } from "./registry";
import { createTimedReminderTools } from "./reminder-time";
import { objectSchema as object, textSchema as text, versionSchema as version } from "./schema";

const sources = { type: "array", minItems: 1, maxItems: 5, items: text(220) };
const save = object(
  {
    id: text(220),
    expectedVersion: version,
    title: text(120),
    purpose: text(1200, 0),
    dueAt: text(40),
    timezone: text(100),
    originalTimeIntent: text(240, 0),
    expiresAt: text(40),
    allowFallback: { type: "boolean" },
    sourceIds: sources,
  },
  ["title", "purpose", "dueAt", "timezone", "originalTimeIntent", "allowFallback", "sourceIds"],
);
const snooze = object(
  {
    id: text(220),
    expectedVersion: version,
    occurrenceId: text(220),
    dueAt: text(40),
    originalTimeIntent: text(240, 0),
    sourceIds: sources,
  },
  ["id", "expectedVersion", "occurrenceId", "dueAt", "originalTimeIntent", "sourceIds"],
);
const complete = object(
  { id: text(220), expectedVersion: version, occurrenceId: text(220), sourceIds: sources },
  ["id", "expectedVersion", "occurrenceId", "sourceIds"],
);
const cancel = object({ id: text(220), expectedVersion: version, sourceIds: sources }, [
  "id",
  "expectedVersion",
  "sourceIds",
]);

export function createReminderTools(
  store: Store,
  options: {
    permissions?: ReminderPermissions;
    now?: () => Date;
    legacyNested?: boolean;
    structuredTime?: boolean;
  } = {},
): RegisteredTool[] {
  if (options.structuredTime) return createTimedReminderTools(store, options);
  const reminders = createReminderService(store, { now: options.now }),
    pinned = { ...(options.permissions ?? { manageReminders: false }) };
  return [
    {
      name: "reminder_write",
      effect: "local_write",
      allowedTurnKinds: ["user"],
      timeoutMs: 1500,
      maxOutputBytes: 16000,
      argumentHelp: options.legacyNested
        ? "Use action and one matching object named save, snooze, complete, cancel or retry_failed. Inside that object use allowFallback as a JSON boolean and sourceIds as an array of source-ID strings. Do not flatten legacy payloads."
        : "Use a flat object: action and all selected action fields are at the top level, with no save/snooze/complete wrapper. sourceIds must be an array of source-ID strings; allowFallback must be a JSON boolean true or false, not a string. save requires title, purpose, dueAt, timezone, originalTimeIntent, allowFallback and sourceIds. snooze requires id, expectedVersion, occurrenceId, dueAt, originalTimeIntent and sourceIds. complete/retry_failed require id, expectedVersion, occurrenceId and sourceIds; cancel needs id, expectedVersion and sourceIds.",
      description:
        "Create/edit a one-time reminder, snooze one occurrence, complete or cancel it, or retry a definitive failed delivery within owner permission. " +
        (options.legacyNested
          ? "Use action and only its matching payload object: save, snooze, complete, cancel or retry_failed. "
          : 'Use FLAT top-level fields, for example {"action":"complete","id":"<reminder id>","expectedVersion":2,"occurrenceId":"<current occurrence id>","sourceIds":["<current owner source id>"]}. Do not nest payloads under action names. save requires title, purpose, dueAt, timezone, originalTimeIntent, allowFallback (boolean) and sourceIds (array). snooze needs id, expectedVersion, occurrenceId, dueAt, originalTimeIntent, sourceIds. complete/retry_failed need id, expectedVersion, occurrenceId, sourceIds; cancel omits occurrenceId. ') +
        "Read daily_read reminders/occurrences/reply_reminder for exact saved IDs and versions; the Telegram reply target can identify which reminder the owner answered. A reply to an older delivered occurrence also returns the current parent: when the same task was merely snoozed, complete or snooze its currentOccurrenceId/current version; a changed purpose may need clarification. Do not guess among ambiguous tasks. save creates a new reminder when id/expectedVersion are omitted; an edit requires both and full fields. dueAt is an exact timestamp with UTC offset, resolved using daily_read time; retain the owner's time intent/timezone. Omit expiresAt for no expiry. allowFallback saves permission for a simple title-based notice when generation is unavailable. Delivery does not complete the task. Snoozing after delivery explicitly creates a new scheduled occurrence; it never replays an unknown send. No automatic recurrence or repeat nudges yet. Heartbeat silence/unanswered limits do not snooze these reminders. Keep mutable schedules here, not copied into memory. Only a successful receipt means a reminder was saved or changed; do not claim Telegram delivery from scheduling alone.",
      parameters: options.legacyNested
        ? object(
            {
              action: {
                type: "string",
                enum: ["save", "snooze", "complete", "cancel", "retry_failed"],
              },
              save,
              snooze,
              complete,
              cancel,
              retry_failed: complete,
            },
            ["action"],
          )
        : object(
            {
              action: {
                type: "string",
                enum: ["save", "snooze", "complete", "cancel", "retry_failed"],
              },
              ...save.properties,
              ...snooze.properties,
              ...complete.properties,
            },
            ["action", "sourceIds"],
          ),
      outputSchema: { type: "object", additionalProperties: true },
      execute(input, context) {
        const action = input.action;
        if (
          action !== "save" &&
          action !== "snooze" &&
          action !== "complete" &&
          action !== "cancel" &&
          action !== "retry_failed"
        )
          throw new DynamicValidationError(
            "action",
            "invalid_action",
            "Choose a supported one-time reminder action.",
          );
        const schema = { save, snooze, complete, cancel, retry_failed: complete }[action];
        const value = options.legacyNested
          ? input[action]
          : Object.fromEntries(Object.entries(input).filter(([key]) => key !== "action"));
        if (
          (options.legacyNested &&
            Object.keys(input).some((key) => key !== "action" && key !== action)) ||
          !validateToolInput(value, schema)
        )
          throw new DynamicValidationError(
            action,
            "missing_fields",
            `For ${action}, provide only these required fields ${options.legacyNested ? `inside ${action}` : "at the top level"}: ${schema.required.join(", ")}.${action === "save" ? " New reminders omit id/expectedVersion; edits require both. Omit expiresAt for no expiry." : " Use current saved IDs and versions."} sourceIds is an array; allowFallback is a boolean.`,
          );
        const fields = value as Record<string, unknown>,
          mutation = {
            actor: "valerie" as const,
            turnId: context.turnId,
            operationKey: context.operationKey,
            permissions: pinned,
          };
        try {
          const reminder =
            action === "save"
              ? reminders.saveReminder(
                  {
                    ...fields,
                    expiresAt: fields.expiresAt ?? null,
                  } as unknown as ReminderSaveInput,
                  mutation,
                )
              : action === "snooze"
                ? reminders.snooze(
                    fields as unknown as Parameters<typeof reminders.snooze>[0],
                    mutation,
                  )
                : action === "complete"
                  ? reminders.complete(
                      fields as unknown as Parameters<typeof reminders.complete>[0],
                      mutation,
                    )
                  : action === "cancel"
                    ? reminders.cancel(
                        fields as unknown as Parameters<typeof reminders.cancel>[0],
                        mutation,
                      )
                    : reminders.retryFailed(
                        fields as unknown as Parameters<typeof reminders.retryFailed>[0],
                        mutation,
                      );
          return { reminder, occurrence: reminders.readOccurrence(reminder.currentOccurrenceId) };
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
