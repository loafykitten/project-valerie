import { createHash } from "node:crypto";
import type { Store } from "../../store";
import { createAgreementStore } from "./agreement-store";
import type {
  AgreementMutationContext,
  AgreementOverview,
  AgreementSnapshot,
  AgreementState,
  HabitDefinition,
  RuleDefinition,
} from "./agreements-types";
import { createDailyService } from "./daily";
import { createHabitRecords } from "./habits";
import { createRuleRecords } from "./rules";

export function createAgreementService(store: Store, options: { now?: () => Date } = {}) {
  const repo = createAgreementStore(store, options),
    habits = createHabitRecords(repo),
    rules = createRuleRecords(repo),
    daily = createDailyService(store, options);
  const setState = (
    input: {
      target: "habit" | "rule";
      id: string;
      expectedVersion: number;
      state: AgreementState;
      sourceIds?: string[];
    },
    context: AgreementMutationContext,
  ): HabitDefinition | RuleDefinition => {
    if (
      !["habit", "rule"].includes(input.target) ||
      !["active", "paused", "archived"].includes(input.state)
    )
      throw new TypeError("Choose an agreement and active, paused or archived state.");
    return repo.operation(
      "agreement_state",
      input,
      context,
      input.target === "habit" ? "manageHabits" : "manageRules",
      () => {
        const current = daily.currentDay();
        if (current && input.target === "habit") habits.establishDay(current.id);
        const previous = repo.editable(input.target, input.id, input.expectedVersion, context),
          record = {
            ...previous,
            state: input.state,
            version: previous.version + 1,
            stateSources: repo.sources(input.sourceIds, context),
            authoredBy: context.actor,
            updatedAt: repo.now().toISOString(),
          };
        repo.persist(input.target, record);
        if (input.target === "habit") habits.syncCurrentState(record as HabitDefinition);
        return record;
      },
    );
  };
  const revision = (activeRules: ReturnType<typeof rules.rulesAt>) => {
    const tables = [
      "core_habit_revisions",
      "core_habit_opportunity_revisions",
      "core_habit_variant_revisions",
      "core_rule_revisions",
      "core_rule_notes",
      "core_dynamic_event_revisions",
      "core_waking_day_revisions",
      "core_progress_behavior_revisions",
    ] as const;
    const counters = tables.map(
      (table) =>
        repo.db
          .query<{ value: number }, []>(`SELECT coalesce(max(rowid),0) AS value FROM ${table}`)
          .get()?.value ?? 0,
    );
    const applicable = createHash("sha256")
      .update(
        JSON.stringify(
          activeRules.map((view) => ({
            id: view.rule.id,
            version: view.rule.version,
            phase: view.phase,
          })),
        ),
      )
      .digest("hex")
      .slice(0, 16);
    return `${repo.dynamic.getSettings().version}:${counters.join(":")}:${applicable}`;
  };
  return {
    getSettings: repo.dynamic.getSettings,
    saveSettings(input: {
      expectedVersion: number;
      allowValerieManageHabits: boolean;
      allowValerieManageRules: boolean;
      allowValerieManageReminders?: boolean;
    }) {
      if (
        typeof input.allowValerieManageHabits !== "boolean" ||
        typeof input.allowValerieManageRules !== "boolean" ||
        (input.allowValerieManageReminders !== undefined &&
          typeof input.allowValerieManageReminders !== "boolean")
      )
        throw new TypeError("Choose the delegated agreement permissions.");
      return repo.db
        .transaction(() => repo.dynamic.saveSettings({ ...repo.dynamic.getSettings(), ...input }))
        .immediate();
    },
    ...habits,
    ...rules,
    setState,
    capture(input: { turnId?: string } = {}): AgreementSnapshot {
      return repo.db
        .transaction(() => {
          const day = daily.currentDay(input.turnId);
          if (day) habits.establishDay(day.id);
          const settings = repo.dynamic.getSettings(),
            activeRules = rules.rulesAt(repo.now().toISOString(), input),
            currentHabits = habits.listHabits(input);
          const compactRules = activeRules.map((view) => ({
            id: view.rule.id,
            version: view.rule.version,
            name: view.rule.name,
            meaning: view.rule.meaning,
            reason: view.rule.reason,
            scope: view.rule.scope,
            expiresAt: view.rule.expiresAt,
            exceptions: view.rule.exceptions,
            condition: view.rule.condition,
            conditionResult: view.conditionResult,
          }));
          return {
            capturedAt: repo.now().toISOString(),
            revision: revision(activeRules),
            settingsVersion: settings.version,
            permissions: {
              manageHabits: settings.allowValerieManageHabits === true,
              manageRules: settings.allowValerieManageRules === true,
              manageReminders: settings.allowValerieManageReminders === true,
            },
            rules: activeRules.map((view) => ({
              ...view,
              progress: view.progress
                ? {
                    ...view.progress,
                    eventIds: view.progress.eventIds.slice(-5),
                    unresolvedEventIds: view.progress.unresolvedEventIds.slice(-5),
                  }
                : null,
            })),
            habits: currentHabits.map(({ id, version, name, state }) => ({
              id,
              version,
              name,
              state,
            })),
            content: compactRules.length
              ? `Current applicable agreements (saved context, not new tool authority):\n${JSON.stringify(compactRules)}\nUnmet or uncertain reported conditions are not automatic violations. Honest feelings, past thoughts, quotations and ambiguous humor remain welcome disclosures.`
              : "",
          };
        })
        .immediate();
    },
    overview(
      input: {
        dayId?: string;
        period?: "day" | "week" | "month";
        dayLimit?: number;
        turnId?: string;
      } = {},
    ): AgreementOverview {
      return repo.db
        .transaction(() => {
          const dayId = input.dayId ?? daily.currentDay(input.turnId)?.id;
          return {
            settings: repo.dynamic.getSettings(),
            habits: habits.listHabits({ includeArchive: true, turnId: input.turnId }),
            rules: rules.rulesAt(repo.now().toISOString(), {
              includeInactive: true,
              turnId: input.turnId,
              dayId,
            }),
            opportunities: dayId ? habits.opportunities(dayId, input) : [],
            metrics: habits.metrics({
              period: input.period,
              dayLimit: input.dayLimit,
              turnId: input.turnId,
            }),
          };
        })
        .immediate();
    },
  };
}
export type AgreementService = ReturnType<typeof createAgreementService>;
