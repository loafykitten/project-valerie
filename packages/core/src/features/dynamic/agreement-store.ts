import type { Store } from "../../store";
import type {
  AgreementMutationContext,
  AgreementRecord,
  HabitDefinition,
  RuleDefinition,
} from "./agreements-types";
import { createDailyRepository, dailyText, dailyVersion, runDynamicOperation } from "./evidence";
import { createDynamicService } from "./service";
import { DynamicConflictError, DynamicPermissionError, type DynamicSource } from "./types";

const tables = {
  habit: { current: "core_habits", revisions: "core_habit_revisions" },
  rule: { current: "core_rules", revisions: "core_rule_revisions" },
} as const;
export function createAgreementStore(store: Store, options: { now?: () => Date } = {}) {
  const daily = createDailyRepository(store, options),
    dynamic = createDynamicService(store, options),
    now = daily.now,
    db = store.db;
  const visible = (record: AgreementRecord, turnId?: string) =>
    daily.visible({ sources: record.sources, revisionSources: record.stateSources }, turnId);
  const read = <T extends HabitDefinition | RuleDefinition>(
    target: "habit" | "rule",
    id: string,
    input: { revision?: number; turnId?: string } = {},
  ): T | null => {
    dailyText(id, 220, "id");
    const table = tables[target];
    const row =
      input.revision !== undefined
        ? db
            .query<{ json: string }, [string, number]>(
              `SELECT record_json AS json FROM ${table.revisions} WHERE id=? AND version=?`,
            )
            .get(id, dailyVersion(input.revision))
        : db
            .query<{ json: string }, [string]>(
              `SELECT record_json AS json FROM ${table.current} WHERE id=?`,
            )
            .get(id);
    const record = row ? (JSON.parse(row.json) as T) : null;
    return record && visible(record, input.turnId) ? record : null;
  };
  const list = <T extends HabitDefinition | RuleDefinition>(
    target: "habit" | "rule",
    input: { includeArchive?: boolean; turnId?: string; limit?: number } = {},
  ): T[] => {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new TypeError("Use a bounded agreement list.");
    return db
      .query<{ json: string }, [number, number]>(
        `SELECT record_json AS json FROM ${tables[target].current} WHERE state!='archived' OR ?=1 ORDER BY (state='archived'),rowid DESC LIMIT ?`,
      )
      .all(Number(input.includeArchive === true), limit)
      .map((row) => JSON.parse(row.json) as T)
      .filter((record) => visible(record, input.turnId));
  };
  const authorize = (context: AgreementMutationContext, scope: "manageHabits" | "manageRules") => {
    if (context.actor === "owner") return;
    if (context.actor !== "valerie") throw new TypeError("Unknown agreement author.");
    const settings = dynamic.getSettings();
    if (
      context.permissions?.[scope] !== true ||
      settings[
        scope === "manageHabits" ? "allowValerieManageHabits" : "allowValerieManageRules"
      ] !== true
    )
      throw new DynamicPermissionError(scope);
    dailyText(context.operationKey, 300, "operationKey");
    dailyText(context.turnId, 220, "turnId");
    if (!db.query("SELECT id FROM core_conversation_turns WHERE id=?").get(context.turnId ?? ""))
      throw new TypeError("The source conversation is unavailable.");
  };
  const sources = (
    sourceIds: string[] | undefined,
    context: AgreementMutationContext,
  ): DynamicSource[] =>
    daily.evidence(sourceIds, {
      actor: context.actor,
      turnId: context.turnId,
      operationKey: context.operationKey,
    });
  const editable = <T extends HabitDefinition | RuleDefinition>(
    target: "habit" | "rule",
    id: string,
    expectedVersion: number,
    context: AgreementMutationContext,
  ): T => {
    const record = read<T>(target, id, {
      turnId: context.actor === "valerie" ? context.turnId : undefined,
    });
    if (!record || record.state === "archived")
      throw new TypeError("Only an available, unarchived agreement can be edited.");
    if (record.version !== dailyVersion(expectedVersion))
      throw new DynamicConflictError(
        "This agreement changed. Read the saved version before editing.",
      );
    return record;
  };
  const persist = (target: "habit" | "rule", record: AgreementRecord) => {
    const json = JSON.stringify(record),
      table = tables[target];
    db.query(
      `INSERT INTO ${table.current} VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state,record_json=excluded.record_json`,
    ).run(record.id, record.version, record.state, json);
    db.query(`INSERT INTO ${table.revisions} VALUES(?,?,?)`).run(record.id, record.version, json);
  };
  const base = (
    previous: AgreementRecord | null,
    evidence: DynamicSource[],
    context: AgreementMutationContext,
  ): AgreementRecord => ({
    id: previous?.id ?? crypto.randomUUID(),
    version: (previous?.version ?? 0) + 1,
    state: previous?.state ?? "active",
    sources: evidence,
    stateSources: previous?.stateSources ?? evidence,
    authoredBy: context.actor,
    createdAt: previous?.createdAt ?? now().toISOString(),
    updatedAt: now().toISOString(),
  });
  return {
    store,
    db,
    now,
    daily,
    dynamic,
    read,
    list,
    visible,
    sources,
    editable,
    persist,
    base,
    operation: <T>(
      name: string,
      input: unknown,
      context: AgreementMutationContext,
      scope: "manageHabits" | "manageRules",
      action: () => T,
    ) => runDynamicOperation(store, name, input, context, () => authorize(context, scope), action),
    /** True when every submitted field serializes the same as the saved record's field. */
    sameFields: <T extends HabitDefinition | RuleDefinition>(record: T, fields: Partial<T>) =>
      Object.entries(fields).every(
        ([key, item]) => JSON.stringify(record[key as keyof T]) === JSON.stringify(item),
      ),
    normalized: (value: string) =>
      value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"),
  };
}
export type AgreementStore = ReturnType<typeof createAgreementStore>;
