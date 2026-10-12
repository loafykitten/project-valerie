import {
  type AgreementPermissions,
  type AgreementState,
  createAgreementService,
  createDailyService,
  DynamicConflictError,
  DynamicValidationError,
  type HabitSaveInput,
  type HabitVariantInput,
  type RuleNoteInput,
  type RuleSaveInput,
  type Store,
} from "@valerie/core";
import { type RegisteredTool, validateToolInput } from "./registry";
import { objectSchema as object, textSchema as text, versionSchema as version } from "./schema";

const list = (items: Record<string, unknown>, maxItems: number, minItems = 0) => ({
  type: "array",
  items,
  maxItems,
  minItems,
});
const sourceIds = list(text(220), 5, 1);
const effectiveTime = {
  ...text(40),
  description:
    "Exact ISO timestamp with UTC offset or Z, never a date-only value. For this day use its provided wakeTime.at; for now use the provided current/received timestamp or daily_read mode=time's server clock. Do not invent a midnight boundary.",
};
const statuses = { type: "string", enum: ["done", "partial", "skipped", "excused"] };
const time = object(
  {
    at: text(40),
    timezone: text(100),
    basis: { type: "string", enum: ["exact", "relative", "message_time", "unknown"] },
    originalLocalIntent: text(160),
  },
  ["timezone", "basis"],
);
const habit = object(
  {
    id: text(220),
    expectedVersion: version,
    name: text(120),
    reason: text(600),
    behaviorId: text(220),
    fullPractice: text(600),
    smallerPractice: text(400),
    cadence: object(
      {
        kind: { type: "string", enum: ["every_waking_day", "weekdays"] },
        weekdays: list({ type: "integer", minimum: 0, maximum: 6 }, 7, 1),
      },
      ["kind"],
    ),
    slots: list({ type: "string", enum: ["morning", "evening"] }, 2, 1),
    effectiveAt: effectiveTime,
    threshold: {
      type: "integer",
      minimum: 1,
      maximum: 1000000,
      description:
        "Agreed full-practice amount in the linked behavior's saved unit, not a session count unless its unit is sessions. For a minutes behavior with a ten-minute practice use 10; for two meals use 2. Read the behavior unit/valueKind before saving. Omit for status behaviors; never invent a target.",
    },
    sourceIds,
  },
  ["name", "reason", "behaviorId", "fullPractice", "cadence", "slots", "effectiveAt", "sourceIds"],
);
const rule = object(
  {
    id: text(220),
    expectedVersion: version,
    name: text(120),
    meaning: text(800),
    reason: text(600),
    scope: text(400),
    effectiveAt: effectiveTime,
    expiresAt: text(40),
    timezone: text(100),
    window: object(
      {
        start: text(5),
        end: text(5),
        weekdays: list({ type: "integer", minimum: 0, maximum: 6 }, 7, 1),
      },
      ["start", "end", "weekdays"],
    ),
    exceptions: list(text(240), 8),
    condition: object(
      {
        behaviorId: text(220),
        comparison: { type: "string", enum: ["at_least", "at_most", "equals", "status_is"] },
        value: { type: "integer", minimum: 0, maximum: 1000000 },
        status: statuses,
      },
      ["behaviorId", "comparison"],
    ),
    sourceIds,
  },
  ["name", "meaning", "reason", "scope", "effectiveAt", "timezone", "exceptions", "sourceIds"],
);
const state = object(
  {
    id: text(220),
    expectedVersion: version,
    state: { type: "string", enum: ["active", "paused", "archived"] },
    sourceIds,
  },
  ["id", "expectedVersion", "state", "sourceIds"],
);
const variant = object(
  {
    id: text(220),
    expectedVersion: version,
    habitId: text(220),
    wakingDayId: text(220),
    definitionVersion: version,
    eventId: text(220),
    expectedEventVersion: version,
    variant: { type: "string", enum: ["full", "smaller"] },
    sourceIds,
  },
  [
    "habitId",
    "wakingDayId",
    "definitionVersion",
    "eventId",
    "expectedEventVersion",
    "variant",
    "sourceIds",
  ],
);
const voidVariant = object({ id: text(220), expectedVersion: version, sourceIds }, [
  "id",
  "expectedVersion",
  "sourceIds",
]);
const note = object(
  {
    ruleId: text(220),
    ruleVersion: version,
    wakingDayId: text(220),
    summary: text(1000),
    kind: { type: "string", enum: ["owner_report", "valerie_interpretation"] },
    disposition: { type: "string", enum: ["understood", "excepted", "uncertain"] },
    occurred: time,
    sourceIds,
  },
  ["ruleId", "ruleVersion", "summary", "kind", "disposition", "occurred", "sourceIds"],
);

/** One explicit mutation capability; reads remain discoverable in daily_read. */
export function createAgreementTools(
  store: Store,
  options: { permissions?: AgreementPermissions; now?: () => Date } = {},
): RegisteredTool[] {
  const agreements = createAgreementService(store, { now: options.now });
  const daily = createDailyService(store, { now: options.now });
  const pinned = { ...(options.permissions ?? { manageHabits: false, manageRules: false }) };
  return [
    {
      name: "agreement_write",
      effect: "local_write",
      allowedTurnKinds: ["user"],
      timeoutMs: 1500,
      maxOutputBytes: 24000,
      argumentHelp:
        'Choose target and action, then only its matching payload. For target="rule", action="log_note", use note:{ruleId,ruleVersion,summary,kind,disposition,occurred:{timezone,basis},sourceIds}, NOT rule. For action="save" put the full definition in habit or rule. For count habits include the agreed positive threshold; for status habits omit threshold. Use sourceIds as an array. set_state uses state:{id,expectedVersion,state,sourceIds}; habit log_variant uses variant; habit void_variant uses voidVariant. Do not flatten agreement fields or mix payloads.',
      description:
        'Create or revise actual Habits and Rules within owner delegation. target=habit|rule and action select exactly one matching payload: save uses habit or rule; set_state uses state; habit log_variant uses variant; habit void_variant uses voidVariant; rule log_note uses note. Note shape: {"target":"rule","action":"log_note","note":{"ruleId":"<saved rule id>","ruleVersion":1,"summary":"<supported report>","kind":"owner_report","disposition":"understood","occurred":{"timezone":"America/Chicago","basis":"message_time"},"sourceIds":["<current source id>"]}}. A note is never placed under rule. Read daily_read views habits/rules/opportunities/variant/rule_notes for IDs and versions. These records do not schedule messages. Reuse an existing shared behavior; examples are not commitments. For a new definition omit id/expectedVersion; full replacement edits require both and all definition fields. A COUNT behavior requires an agreed integer threshold >=1 in habit; a STATUS behavior omits threshold. Do not omit a count threshold or invent an unagreed target. Omit absent nullable fields (smallerPractice, expiresAt, window, condition); omission clears them on a full edit. Paused definitions may resume; archives are retained. A smaller-practice tag needs an existing qualifying daily event and saved opportunity definition version, not a new count. Painful feelings, quotes, past thoughts and ambiguous humor are not automatic violations; For note disposition: excepted means the report clearly falls under an explicitly agreed exception; uncertain means relevance or application is unclear; understood records the otherwise-understood report without classifying a violation. Only actual successful receipts establish changes.',
      parameters: object(
        {
          target: { type: "string", enum: ["habit", "rule"] },
          action: {
            type: "string",
            enum: ["save", "set_state", "log_variant", "void_variant", "log_note"],
          },
          habit,
          rule,
          state,
          variant,
          voidVariant,
          note,
        },
        ["target", "action"],
      ),
      outputSchema: { type: "object", additionalProperties: true },
      execute(input, context) {
        const target = input.target,
          action = input.action;
        const payloadKey =
          action === "save"
            ? target === "habit"
              ? "habit"
              : "rule"
            : action === "set_state"
              ? "state"
              : target === "habit" && action === "log_variant"
                ? "variant"
                : target === "habit" && action === "void_variant"
                  ? "voidVariant"
                  : target === "rule" && action === "log_note"
                    ? "note"
                    : null;
        const schemas = { habit, rule, state, variant, voidVariant, note };
        if (
          (target !== "habit" && target !== "rule") ||
          !payloadKey ||
          Object.keys(input).some(
            (key) => key !== "target" && key !== "action" && key !== payloadKey,
          ) ||
          !validateToolInput(input[payloadKey], schemas[payloadKey])
        )
          throw new DynamicValidationError(
            "action",
            "invalid_arguments",
            target === "rule" && action === "log_note"
              ? "For rule log_note, put ruleId, ruleVersion, summary, kind, disposition, occurred and sourceIds inside note, not rule. The rule payload is only for saving a rule definition."
              : "Provide only the complete payload matching this habit or rule action: save uses habit/rule, set_state uses state, log_variant uses variant, void_variant uses voidVariant, log_note uses note.",
          );
        const value = input[payloadKey] as Record<string, unknown>;
        const mutation = {
          actor: "valerie" as const,
          turnId: context.turnId,
          operationKey: context.operationKey,
          permissions: pinned,
        };
        try {
          if (action === "save" && target === "habit") {
            const saved = agreements.saveHabit(
              {
                ...value,
                smallerPractice: value.smallerPractice ?? null,
                threshold: value.threshold ?? null,
              } as unknown as HabitSaveInput,
              mutation,
            );
            const behavior = daily.readBehavior(saved.behaviorId, { turnId: context.turnId });
            return {
              habit: saved,
              measurement: behavior
                ? {
                    behaviorId: behavior.id,
                    behaviorName: behavior.name,
                    unit: behavior.unit,
                    valueKind: behavior.valueKind,
                    fullTarget: saved.threshold,
                  }
                : null,
            };
          }
          if (action === "save")
            return {
              rule: agreements.saveRule(
                {
                  ...value,
                  expiresAt: value.expiresAt ?? null,
                  window: value.window ?? null,
                  condition: value.condition ?? null,
                } as unknown as RuleSaveInput,
                mutation,
              ),
            };
          if (action === "set_state")
            return {
              definition: agreements.setState(
                {
                  target,
                  id: value.id as string,
                  expectedVersion: value.expectedVersion as number,
                  state: value.state as AgreementState,
                  sourceIds: value.sourceIds as string[],
                },
                mutation,
              ),
            };
          if (action === "log_variant")
            return {
              variant: agreements.logVariant(value as unknown as HabitVariantInput, mutation),
            };
          if (action === "void_variant")
            return {
              variant: agreements.voidVariant(
                value as unknown as { id: string; expectedVersion: number; sourceIds: string[] },
                mutation,
              ),
            };
          const occurred = value.occurred as Record<string, unknown>;
          return {
            note: agreements.logRuleNote(
              {
                ...value,
                wakingDayId: value.wakingDayId ?? null,
                occurred: { ...occurred, at: occurred.at ?? null },
              } as unknown as RuleNoteInput,
              mutation,
            ),
          };
        } catch (error) {
          if (error instanceof DynamicConflictError)
            throw new DynamicValidationError(
              "expectedVersion",
              "agreement_conflict",
              error.message,
            );
          throw error;
        }
      },
    },
  ];
}
