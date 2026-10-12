import { createHash } from "node:crypto";
import type { AgreementStore } from "./agreement-store";
import { rulePhaseAt, validateRuleWindow } from "./agreement-time";
import type {
  AgreementMutationContext,
  RuleDefinition,
  RuleFields,
  RuleNoteInput,
  RuleReviewNote,
  RuleSaveInput,
  RuleView,
} from "./agreements-types";
import { createDailyService } from "./daily";
import { dailyText, dailyVersion } from "./evidence";
import { dailyInstant, dailyTimezone } from "./time";
import { DynamicConflictError } from "./types";

export function createRuleRecords(repo: AgreementStore) {
  const daily = createDailyService(repo.store, { now: repo.now });
  const readRule = (id: string, input: { revision?: number; turnId?: string } = {}) =>
    repo.read<RuleDefinition>("rule", id, input);
  const listRules = (input: { includeArchive?: boolean; turnId?: string; limit?: number } = {}) =>
    repo.list<RuleDefinition>("rule", input);
  const fields = (input: RuleFields, context: AgreementMutationContext): RuleFields => {
    const effectiveAt = dailyInstant(input.effectiveAt),
      expiresAt = input.expiresAt === null ? null : dailyInstant(input.expiresAt);
    if (expiresAt && expiresAt <= effectiveAt)
      throw new TypeError("Expiry must be after the rule starts.");
    if (!Array.isArray(input.exceptions) || input.exceptions.length > 8)
      throw new TypeError("Use at most eight agreed exceptions.");
    const condition = input.condition;
    if (condition !== null) {
      if (!condition || typeof condition !== "object")
        throw new TypeError("Provide a shared behavior condition or null.");
      const behavior = daily.readBehavior(condition.behaviorId);
      if (
        behavior?.state !== "active" ||
        !repo.daily.visible(behavior, context.actor === "valerie" ? context.turnId : undefined)
      )
        throw new TypeError("Choose an active available shared behavior.");
      if (condition.comparison === "status_is") {
        if (
          behavior.valueKind !== "status" ||
          !["done", "partial", "skipped", "excused"].includes(condition.status)
        )
          throw new TypeError("Choose a reported status condition.");
      } else if (
        !["at_least", "at_most", "equals"].includes(condition.comparison) ||
        behavior.valueKind !== "count" ||
        !Number.isSafeInteger(condition.value) ||
        condition.value < 0 ||
        condition.value > 1000000
      )
        throw new TypeError("Choose a bounded count comparison.");
    }
    return {
      name: dailyText(input.name, 120, "name"),
      meaning: dailyText(input.meaning, 800, "meaning"),
      reason: dailyText(input.reason, 600, "reason"),
      scope: dailyText(input.scope, 400, "scope"),
      effectiveAt,
      expiresAt,
      timezone: dailyTimezone(input.timezone),
      window: validateRuleWindow(input.window),
      exceptions: input.exceptions.map((value) => dailyText(value, 240, "exception")),
      condition:
        condition === null
          ? null
          : condition.comparison === "status_is"
            ? {
                behaviorId: condition.behaviorId,
                comparison: "status_is",
                status: condition.status,
              }
            : {
                behaviorId: condition.behaviorId,
                comparison: condition.comparison,
                value: condition.value,
              },
    };
  };
  const saveRule = (input: RuleSaveInput, context: AgreementMutationContext): RuleDefinition =>
    repo.operation("save_rule", input, context, "manageRules", () => {
      const previous = input.id
        ? repo.editable<RuleDefinition>("rule", input.id, input.expectedVersion as number, context)
        : null;
      if (!previous && input.expectedVersion !== undefined)
        throw new TypeError("Omit expectedVersion for a new agreement.");
      const value = fields(input, context),
        evidence = repo.sources(input.sourceIds, context);
      const duplicate = listRules().find(
        (rule) =>
          rule.id !== previous?.id && repo.normalized(rule.name) === repo.normalized(value.name),
      );
      if (duplicate) {
        if (
          !previous &&
          repo.sameFields(duplicate, value) &&
          repo.visible(duplicate, context.actor === "valerie" ? context.turnId : undefined)
        )
          return duplicate;
        throw new DynamicConflictError(
          "An agreement with this name already exists. Read it before changing its meaning.",
        );
      }
      if (!previous && listRules().length >= 30)
        throw new TypeError("At most 30 unarchived rules may be kept in current context.");
      const record: RuleDefinition = { ...repo.base(previous, evidence, context), ...value };
      repo.persist("rule", record);
      return record;
    });
  const rulesAt = (
    at = repo.now().toISOString(),
    input: { turnId?: string; dayId?: string | null; includeInactive?: boolean } = {},
  ): RuleView[] => {
    const instant = dailyInstant(at),
      dayId =
        input.dayId === undefined ? (daily.currentDay(input.turnId)?.id ?? null) : input.dayId;
    return listRules({ includeArchive: input.includeInactive, turnId: input.turnId })
      .map((rule) => {
        const phase = rulePhaseAt(rule, instant),
          applicable = phase === "active";
        let conditionResult: RuleView["conditionResult"] = rule.condition
            ? applicable
              ? "not_reported"
              : "not_applicable"
            : "not_configured",
          progress: RuleView["progress"] = null;
        if (rule.condition && applicable && dayId) {
          progress = daily.readBehaviorProgress(rule.condition.behaviorId, dayId, {
            turnId: input.turnId,
          });
          if (["uncertain", "conflicting"].includes(progress.basis)) conditionResult = "uncertain";
          else if (rule.condition.comparison === "status_is")
            conditionResult =
              progress.status === null
                ? "not_reported"
                : progress.status === rule.condition.status
                  ? "met"
                  : "not_met";
          else if (progress.value !== null) {
            const actual = progress.value,
              target = rule.condition.value;
            conditionResult = (
              rule.condition.comparison === "at_least"
                ? actual >= target
                : rule.condition.comparison === "at_most"
                  ? actual <= target
                  : actual === target
            )
              ? "met"
              : "not_met";
          }
        }
        return { rule, phase, applicable, conditionResult, progress };
      })
      .filter((view) => input.includeInactive || view.applicable);
  };
  const ruleNotes = (
    ruleId: string,
    input: { limit?: number; turnId?: string } = {},
  ): RuleReviewNote[] => {
    if (!readRule(ruleId, { turnId: input.turnId })) return [];
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new TypeError("Use a bounded rule-note page.");
    return repo.db
      .query<{ json: string }, [string, number]>(
        "SELECT record_json AS json FROM core_rule_notes WHERE rule_id=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(ruleId, limit)
      .map((row) => JSON.parse(row.json) as RuleReviewNote)
      .filter((note) => repo.daily.visible(note, input.turnId));
  };
  const logRuleNote = (input: RuleNoteInput, context: AgreementMutationContext): RuleReviewNote =>
    repo.operation("log_rule_note", input, context, "manageRules", () => {
      const rule = readRule(input.ruleId, {
        revision: dailyVersion(input.ruleVersion),
        turnId: context.actor === "valerie" ? context.turnId : undefined,
      });
      if (!rule) throw new TypeError("Choose an available agreement revision.");
      repo.daily.assertDay(input.wakingDayId);
      if (
        !["owner_report", "valerie_interpretation"].includes(input.kind) ||
        !["understood", "excepted", "uncertain"].includes(input.disposition)
      )
        throw new TypeError(
          "Record an understood, excepted or uncertain source-backed review. This is not an automatic violation score.",
        );
      const sources = repo.sources(input.sourceIds, context),
        occurred = repo.daily.timeFor(input.occurred, sources),
        summary = dailyText(input.summary, 1200, "summary");
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            ruleId: rule.id,
            ruleVersion: rule.version,
            day: input.wakingDayId,
            summary,
            kind: input.kind,
            disposition: input.disposition,
            occurred,
            sourceIds: input.sourceIds ?? [],
          }),
        )
        .digest("hex");
      const prior = repo.db
        .query<{ json: string }, [string]>(
          "SELECT record_json AS json FROM core_rule_notes WHERE fingerprint=?",
        )
        .get(fingerprint);
      if (prior) return JSON.parse(prior.json);
      const versionAtReport = occurred.at
        ? repo.db
            .query<{ version: number }, [string, string]>(
              "SELECT version FROM core_rule_revisions WHERE id=? AND json_extract(record_json,'$.updatedAt')<=? ORDER BY version DESC LIMIT 1",
            )
            .get(rule.id, occurred.at)?.version
        : undefined;
      const note: RuleReviewNote = {
        id: crypto.randomUUID(),
        ruleId: rule.id,
        ruleVersion: rule.version,
        wakingDayId: input.wakingDayId,
        summary,
        kind: input.kind,
        disposition: input.disposition,
        occurred,
        applicableAtReport:
          occurred.at &&
          (versionAtReport === undefined ? rule.version === 1 : versionAtReport === rule.version)
            ? rulePhaseAt(rule, occurred.at) === "active"
            : null,
        sources,
        authoredBy: context.actor,
        createdAt: repo.now().toISOString(),
      };
      repo.db
        .query("INSERT INTO core_rule_notes VALUES(?,?,?,?)")
        .run(note.id, rule.id, fingerprint, JSON.stringify(note));
      return note;
    });
  return { readRule, listRules, saveRule, rulesAt, ruleNotes, logRuleNote };
}
