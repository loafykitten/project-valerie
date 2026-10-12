import { createHash } from "node:crypto";
import type { AgreementStore } from "./agreement-store";
import { agreementLocalDate, agreementWeekdays, metricPeriodKey } from "./agreement-time";
import type {
  AgreementMutationContext,
  AgreementQuestion,
  CheckinSlot,
  HabitDefinition,
  HabitFields,
  HabitMetricCounts,
  HabitMetrics,
  HabitOpportunity,
  HabitOutcome,
  HabitSaveInput,
  HabitVariantInput,
  HabitVariantRecord,
} from "./agreements-types";
import { createDailyService } from "./daily";
import type { DailyEvent, WakingDay } from "./daily-types";
import { dailyText, dailyVersion } from "./evidence";
import { dailyInstant } from "./time";
import { DynamicConflictError, DynamicValidationError } from "./types";

interface PinnedOpportunity {
  id: string;
  version: number;
  habitId: string;
  wakingDayId: string;
  definitionVersion: number;
  definition: HabitDefinition;
  establishedAt: string;
  localStartDate: string | null;
  baseApplicable: boolean | null;
  applicable: boolean | null;
  applicabilityReason: string;
  stateSources: HabitDefinition["stateSources"];
}
const outcomes: HabitOutcome[] = [
  "done",
  "smaller_done",
  "partial",
  "skipped",
  "excused",
  "not_reported",
  "uncertain",
  "not_applicable",
];
const emptyCounts = (): HabitMetricCounts => ({
  opportunities: 0,
  applicable: 0,
  reported: 0,
  coverage: null,
  outcomes: Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<
    HabitOutcome,
    number
  >,
});
const meaningHash = (event: DailyEvent) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        summary: event.summary,
        payload: event.payload,
        occurred: event.occurred,
        evidenceKind: event.evidenceKind,
      }),
    )
    .digest("hex");
export function createHabitRecords(repo: AgreementStore) {
  const daily = createDailyService(repo.store, { now: repo.now });
  const readHabit = (id: string, input: { revision?: number; turnId?: string } = {}) =>
    repo.read<HabitDefinition>("habit", id, input);
  const listHabits = (input: { includeArchive?: boolean; turnId?: string; limit?: number } = {}) =>
    repo.list<HabitDefinition>("habit", input);
  const canonicalDayId = (id: string): string => {
    let current = id;
    const seen = new Set<string>();
    for (let hop = 0; hop < 100; hop++) {
      if (seen.has(current)) throw new TypeError("A waking-day merge cycle is unavailable.");
      seen.add(current);
      const day = daily.readDay(current);
      if (!day) throw new TypeError("Waking day unavailable.");
      if (!day.mergedIntoDayId) return current;
      current = day.mergedIntoDayId;
    }
    throw new TypeError("The waking-day merge chain is too long.");
  };
  const fields = (input: HabitFields, context: AgreementMutationContext): HabitFields => {
    const text = (value: unknown, maxBytes: number, field: string): string => {
      try {
        return dailyText(value, maxBytes, field);
      } catch (error) {
        if (error instanceof DynamicValidationError)
          throw new DynamicValidationError(
            field,
            error.reason,
            `Provide a nonempty ${field} of at most ${maxBytes} UTF-8 bytes. Preserve the agreed meaning when shortening it.`,
          );
        throw error;
      }
    };
    const behavior = daily.readBehavior(input.behaviorId);
    if (
      behavior?.state !== "active" ||
      !repo.daily.visible(behavior, context.actor === "valerie" ? context.turnId : undefined)
    )
      throw new DynamicValidationError(
        "behaviorId",
        "behavior_unavailable",
        "Choose an active shared behavior ID from daily_read behaviors before creating a habit. Do not invent an ID or a tracking obligation.",
      );
    if (!input.cadence || !["every_waking_day", "weekdays"].includes(input.cadence.kind))
      throw new DynamicValidationError(
        "cadence",
        "invalid_cadence",
        "Use cadence.kind=every_waking_day, or kind=weekdays with the agreed weekdays array.",
      );
    if (
      !Array.isArray(input.slots) ||
      !input.slots.length ||
      input.slots.length > 2 ||
      input.slots.some((slot) => !["morning", "evening"].includes(slot)) ||
      new Set(input.slots).size !== input.slots.length
    )
      throw new DynamicValidationError(
        "slots",
        "invalid_slots",
        "Provide one or both check-in slots: morning and evening, with no duplicate entries.",
      );
    if (
      behavior.valueKind === "count" &&
      (!Number.isSafeInteger(input.threshold) ||
        Number(input.threshold) < 1 ||
        Number(input.threshold) > 1000000)
    )
      throw new DynamicValidationError(
        "threshold",
        input.threshold == null ? "count_threshold_required" : "invalid_count_threshold",
        "This shared behavior tracks counts. Supply threshold as the agreed whole-number target from 1 to 1000000. If no target was agreed, ask the owner rather than inventing one; repeating the same request without threshold will not save it.",
      );
    if (behavior.valueKind === "status" && input.threshold !== null)
      throw new DynamicValidationError(
        "threshold",
        "status_threshold_not_applicable",
        "This shared behavior tracks reported status. Omit threshold in the tool payload (use null in the owner API); a numeric target does not apply.",
      );
    let cadence: HabitFields["cadence"] = { kind: "every_waking_day" };
    if (input.cadence.kind === "weekdays") {
      try {
        cadence = { kind: "weekdays", weekdays: agreementWeekdays(input.cadence.weekdays) };
      } catch (error) {
        if (error instanceof TypeError)
          throw new DynamicValidationError(
            "cadence.weekdays",
            "invalid_weekdays",
            "Provide one to seven distinct weekday numbers, Sunday=0 through Saturday=6, matching the agreed cadence.",
          );
        throw error;
      }
    }
    let effectiveAt: string;
    try {
      effectiveAt = dailyInstant(input.effectiveAt);
    } catch (error) {
      if (error instanceof TypeError)
        throw new DynamicValidationError(
          "effectiveAt",
          "invalid_timestamp",
          "Provide a real start timestamp with a UTC offset. Resolve ambiguous local dates or times through daily_read time first.",
        );
      throw error;
    }
    return {
      name: text(input.name, 120, "name"),
      reason: text(input.reason, 600, "reason"),
      behaviorId: behavior.id,
      fullPractice: text(input.fullPractice, 600, "fullPractice"),
      smallerPractice:
        input.smallerPractice === null ? null : text(input.smallerPractice, 400, "smallerPractice"),
      cadence,
      slots: [...input.slots],
      effectiveAt,
      threshold: input.threshold,
    };
  };
  const persistOpportunity = (record: PinnedOpportunity) => {
    const json = JSON.stringify(record);
    repo.db
      .query(
        "INSERT INTO core_habit_opportunities VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,record_json=excluded.record_json",
      )
      .run(
        record.id,
        record.habitId,
        record.wakingDayId,
        record.version,
        record.definitionVersion,
        json,
      );
    repo.db
      .query("INSERT INTO core_habit_opportunity_revisions VALUES(?,?,?)")
      .run(record.id, record.version, json);
  };
  const establishDay = (dayId: string): void => {
    const canonical = canonicalDayId(dayId),
      day = daily.readDay(canonical);
    if (!day?.current) return;
    const now = repo.now().toISOString();
    for (const habit of listHabits()) {
      if (
        repo.db
          .query("SELECT id FROM core_habit_opportunities WHERE habit_id=? AND day_id=?")
          .get(habit.id, day.id)
      )
        continue;
      const first = readHabit(habit.id, { revision: 1 });
      if (!first) continue;
      const starting = first.effectiveAt > now && habit.effectiveAt <= now ? habit : first;
      const anchor = [
        day.createdAt,
        starting.createdAt,
        starting.effectiveAt,
        starting === first ? "" : starting.updatedAt,
      ]
        .sort()
        .at(-1) as string;
      if (anchor > now) continue;
      const row = repo.db
        .query<{ json: string }, [string, string]>(
          "SELECT record_json AS json FROM core_habit_revisions WHERE id=? AND json_extract(record_json,'$.updatedAt')<=? ORDER BY version DESC LIMIT 1",
        )
        .get(habit.id, anchor);
      const definition = row ? (JSON.parse(row.json) as HabitDefinition) : first;
      if (definition.effectiveAt > now) continue;
      const local = day.wakeTime.at
        ? agreementLocalDate(day.wakeTime.at, day.wakeTime.timezone)
        : null;
      const baseApplicable =
        definition.cadence.kind === "every_waking_day"
          ? true
          : local
            ? definition.cadence.weekdays.includes(local.weekday)
            : null;
      const applicable = habit.state === "active" ? baseApplicable : false;
      const opportunity: PinnedOpportunity = {
        id: crypto.randomUUID(),
        version: 1,
        habitId: habit.id,
        wakingDayId: day.id,
        definitionVersion: definition.version,
        definition,
        establishedAt: now,
        localStartDate: local?.date ?? null,
        baseApplicable,
        applicable,
        applicabilityReason:
          habit.state !== "active"
            ? habit.state
            : baseApplicable === null
              ? "unknown_weekday"
              : baseApplicable
                ? "scheduled_for_day"
                : "weekday_not_selected",
        stateSources: habit.stateSources,
      };
      persistOpportunity(opportunity);
    }
  };
  const saveHabit = (input: HabitSaveInput, context: AgreementMutationContext): HabitDefinition =>
    repo.operation("save_habit", input, context, "manageHabits", () => {
      const current = daily.currentDay();
      if (current) establishDay(current.id);
      const previous = input.id
        ? repo.editable<HabitDefinition>(
            "habit",
            input.id,
            input.expectedVersion as number,
            context,
          )
        : null;
      if (!previous && input.expectedVersion !== undefined)
        throw new TypeError("Omit expectedVersion for a new habit.");
      const value = fields(input, context),
        sources = repo.sources(input.sourceIds, context),
        duplicate = listHabits().find(
          (habit) =>
            habit.id !== previous?.id &&
            repo.normalized(habit.name) === repo.normalized(value.name),
        );
      if (duplicate) {
        if (
          !previous &&
          repo.sameFields(duplicate, value) &&
          repo.visible(duplicate, context.actor === "valerie" ? context.turnId : undefined)
        )
          return duplicate;
        throw new DynamicConflictError(
          "A habit with this name already exists. Read it before changing the practice or target.",
        );
      }
      if (!previous && listHabits().length >= 30)
        throw new TypeError("At most 30 unarchived habits may be configured.");
      const record: HabitDefinition = { ...repo.base(previous, sources, context), ...value };
      repo.persist("habit", record);
      if (current) establishDay(current.id);
      return record;
    });
  const readVariant = (id: string, input: { turnId?: string } = {}): HabitVariantRecord | null => {
    dailyText(id, 220, "id");
    const row = repo.db
      .query<{ json: string }, [string]>(
        "SELECT record_json AS json FROM core_habit_variants WHERE id=?",
      )
      .get(id);
    const record = row ? (JSON.parse(row.json) as HabitVariantRecord) : null;
    return record && repo.daily.visible(record, input.turnId) ? record : null;
  };
  const opportunityRows = (dayId: string, input: { turnId?: string } = {}): PinnedOpportunity[] => {
    const canonical = canonicalDayId(dayId),
      rows = repo.db
        .query<{ json: string }, [string]>(
          `WITH RECURSIVE aliases(id) AS (SELECT ? UNION SELECT d.id FROM core_waking_days d JOIN aliases a ON json_extract(d.record_json,'$.mergedIntoDayId')=a.id) SELECT record_json AS json FROM core_habit_opportunities WHERE day_id IN (SELECT id FROM aliases) ORDER BY rowid LIMIT 3001`,
        )
        .all(canonical);
    if (rows.length > 3000)
      throw new TypeError("Too many merged opportunities for this bounded day view.");
    const selected = new Map<string, PinnedOpportunity>();
    for (const row of rows) {
      const item = JSON.parse(row.json) as PinnedOpportunity;
      if (
        !repo.visible(item.definition, input.turnId) ||
        !repo.daily.visible({ sources: item.stateSources }, input.turnId)
      )
        continue;
      const prior = selected.get(item.habitId);
      if (!prior || item.wakingDayId === canonical) selected.set(item.habitId, item);
    }
    return [...selected.values()];
  };
  const derive = (
    record: PinnedOpportunity,
    dayId: string,
    input: { turnId?: string } = {},
  ): HabitOpportunity => {
    const progress = daily.readBehaviorProgress(record.definition.behaviorId, dayId, input);
    let outcome: HabitOutcome = "not_reported",
      variant: HabitOpportunity["variant"] = null,
      variantRecordId: string | null = null;
    if (record.applicable === false) outcome = "not_applicable";
    else if (record.applicable === null || ["uncertain", "conflicting"].includes(progress.basis))
      outcome = "uncertain";
    else if (progress.status === "skipped" || progress.status === "excused")
      outcome = progress.status;
    else if (record.definition.threshold !== null) {
      if (progress.value !== null)
        outcome = progress.value >= record.definition.threshold ? "done" : "partial";
      else if (progress.status === "partial") outcome = "partial";
      else if (progress.status === "done") outcome = "uncertain";
    } else if (progress.status === "done") outcome = "done";
    else if (progress.status === "partial") outcome = "partial";
    const variants = repo.db
      .query<{ json: string }, [string, string]>(
        `WITH RECURSIVE aliases(id) AS (SELECT ? UNION SELECT d.id FROM core_waking_days d JOIN aliases a ON json_extract(d.record_json,'$.mergedIntoDayId')=a.id) SELECT v.record_json AS json FROM core_habit_variants v JOIN core_habit_opportunities o ON o.id=v.opportunity_id WHERE o.habit_id=? AND o.day_id IN (SELECT id FROM aliases) AND v.state='active' ORDER BY v.rowid DESC LIMIT 50`,
      )
      .all(dayId, record.habitId)
      .map((row) => JSON.parse(row.json) as HabitVariantRecord)
      .filter((tag) => repo.daily.visible(tag, input.turnId));
    for (const tag of variants) {
      const event = daily.readEvent(tag.eventId, input);
      if (
        event?.state !== "active" ||
        !event.wakingDayId ||
        canonicalDayId(event.wakingDayId) !== dayId ||
        event.payload.kind !== "progress" ||
        event.payload.behaviorId !== record.definition.behaviorId
      )
        continue;
      if (record.definition.threshold === null && event.occurred.at !== progress.asOf) continue;
      const tagDefinition = readHabit(tag.habitId, { revision: tag.definitionVersion });
      const samePractice =
        tagDefinition &&
        ["behaviorId", "fullPractice", "smallerPractice", "threshold"].every(
          (key) =>
            JSON.stringify(tagDefinition[key as keyof HabitDefinition]) ===
            JSON.stringify(record.definition[key as keyof HabitDefinition]),
        );
      if (tag.eventMeaningHash !== meaningHash(event) || !samePractice) {
        if (
          record.applicable === true &&
          !(record.definition.threshold !== null && outcome === "done")
        )
          outcome = "uncertain";
        continue;
      }
      if (record.applicable !== true) continue;
      if (
        tag.variant === "smaller" &&
        (record.definition.threshold === null || outcome !== "done")
      ) {
        outcome = "smaller_done";
        variant = "smaller";
        variantRecordId = tag.id;
        break;
      }
      if (tag.variant === "full" && outcome === "done") {
        variant = "full";
        variantRecordId = tag.id;
        break;
      }
    }
    if (outcome === "done") variant = "full";
    return {
      id: record.id,
      version: record.version,
      habitId: record.habitId,
      wakingDayId: dayId,
      definitionVersion: record.definitionVersion,
      definition: record.definition,
      establishedAt: record.establishedAt,
      applicable: record.applicable,
      applicabilityReason: record.applicabilityReason,
      localStartDate: record.localStartDate,
      outcome,
      variant,
      progress,
      eventIds: progress.eventIds,
      variantRecordId,
      reported:
        record.applicable === true &&
        !["not_reported", "uncertain", "not_applicable"].includes(outcome),
    };
  };
  const opportunities = (dayId: string, input: { turnId?: string } = {}): HabitOpportunity[] =>
    repo.db
      .transaction(() => {
        const canonical = canonicalDayId(dayId);
        if (!daily.readDay(canonical, input)) return [];
        establishDay(canonical);
        return opportunityRows(canonical, input).map((row) => derive(row, canonical, input));
      })
      .immediate();
  const syncCurrentState = (habit: HabitDefinition) => {
    const day = daily.currentDay();
    if (!day) return;
    establishDay(day.id);
    const row = repo.db
      .query<{ json: string }, [string, string]>(
        "SELECT record_json AS json FROM core_habit_opportunities WHERE habit_id=? AND day_id=?",
      )
      .get(habit.id, day.id);
    if (!row) return;
    const prior = JSON.parse(row.json) as PinnedOpportunity,
      current = derive(prior, day.id);
    if (habit.state !== "active" && current.reported) return;
    const applicable = habit.state === "active" ? prior.baseApplicable : false;
    const updated: PinnedOpportunity = {
      ...prior,
      version: prior.version + 1,
      applicable,
      applicabilityReason:
        habit.state !== "active"
          ? habit.state
          : applicable === null
            ? "unknown_weekday"
            : applicable
              ? "scheduled_for_day"
              : "weekday_not_selected",
      stateSources: habit.stateSources,
    };
    persistOpportunity(updated);
  };
  const persistVariant = (record: HabitVariantRecord) => {
    const json = JSON.stringify(record);
    repo.db
      .query(
        "INSERT INTO core_habit_variants VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state,opportunity_id=excluded.opportunity_id,event_id=excluded.event_id,record_json=excluded.record_json",
      )
      .run(record.id, record.version, record.state, record.opportunityId, record.eventId, json);
    repo.db
      .query("INSERT INTO core_habit_variant_revisions VALUES(?,?,?)")
      .run(record.id, record.version, json);
  };
  const logVariant = (
    input: HabitVariantInput,
    context: AgreementMutationContext,
  ): HabitVariantRecord =>
    repo.operation("log_habit_variant", input, context, "manageHabits", () => {
      const dayId = canonicalDayId(input.wakingDayId),
        opportunity = opportunities(dayId, {
          turnId: context.actor === "valerie" ? context.turnId : undefined,
        }).find((item) => item.habitId === input.habitId);
      if (!opportunity || opportunity.definitionVersion !== dailyVersion(input.definitionVersion))
        throw new DynamicConflictError(
          "Read this day's pinned habit opportunity before recording its variant.",
        );
      if (
        !["full", "smaller"].includes(input.variant) ||
        (input.variant === "smaller" && !opportunity.definition.smallerPractice)
      )
        throw new TypeError(
          "A smaller version needs an agreed saved meaning for this opportunity.",
        );
      const event = daily.readEvent(input.eventId, {
        turnId: context.actor === "valerie" ? context.turnId : undefined,
      });
      if (!event || event.version !== dailyVersion(input.expectedEventVersion))
        throw new DynamicConflictError("The shared report changed. Read its current version.");
      if (
        event.state !== "active" ||
        event.evidenceKind === "valerie_interpretation" ||
        !event.wakingDayId ||
        canonicalDayId(event.wakingDayId) !== dayId ||
        event.payload.kind !== "progress" ||
        event.payload.behaviorId !== opportunity.definition.behaviorId ||
        !["occurrence", "total_so_far", "status"].includes(event.payload.mode) ||
        (event.payload.mode === "status"
          ? !["done", "partial"].includes(event.payload.status ?? "")
          : (event.payload.value ?? 0) <= 0)
      )
        throw new TypeError(
          "Choose an actual positive completion/progress report for this behavior and day, not a plan, interpretation, zero, or withdrawn report.",
        );
      if (
        input.variant === "full" &&
        opportunity.definition.threshold !== null &&
        (opportunity.progress.value === null ||
          opportunity.progress.value < opportunity.definition.threshold)
      )
        throw new TypeError("The shared reported count does not establish the full target.");
      if (
        input.variant === "full" &&
        opportunity.definition.threshold === null &&
        opportunity.progress.status !== "done"
      )
        throw new TypeError("A full completion requires the shared reported done status.");
      const sources = repo.sources(input.sourceIds, context),
        previous = input.id
          ? readVariant(input.id, {
              turnId: context.actor === "valerie" ? context.turnId : undefined,
            })
          : null;
      if (input.id && (!previous || previous.version !== dailyVersion(input.expectedVersion)))
        throw new DynamicConflictError("The variant record changed. Read its current version.");
      if (previous && previous.opportunityId !== opportunity.id)
        throw new TypeError("A variant correction stays with its original opportunity.");
      const duplicate = repo.db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM core_habit_variants WHERE opportunity_id=? AND event_id=? AND state='active'",
        )
        .get(opportunity.id, event.id);
      if (duplicate && duplicate.id !== previous?.id) {
        const existing = readVariant(duplicate.id, {
          turnId: context.actor === "valerie" ? context.turnId : undefined,
        });
        if (
          existing &&
          existing.variant === input.variant &&
          existing.eventMeaningHash === meaningHash(event)
        )
          return existing;
        throw new DynamicConflictError(
          "This report already has a variant. Read and revise it rather than adding another.",
        );
      }
      const unchanged =
        previous &&
        previous.variant === input.variant &&
        previous.eventId === event.id &&
        previous.eventMeaningHash === meaningHash(event);
      const record: HabitVariantRecord = {
        id: previous?.id ?? crypto.randomUUID(),
        version: (previous?.version ?? 0) + 1,
        state: "active",
        opportunityId: opportunity.id,
        habitId: input.habitId,
        wakingDayId: dayId,
        definitionVersion: opportunity.definitionVersion,
        eventId: event.id,
        eventVersion: event.version,
        eventMeaningHash: meaningHash(event),
        variant: input.variant,
        sources: unchanged ? previous.sources : sources,
        revisionSources: sources,
        authoredBy: context.actor,
        createdAt: previous?.createdAt ?? repo.now().toISOString(),
        updatedAt: repo.now().toISOString(),
      };
      persistVariant(record);
      return record;
    });
  const voidVariant = (
    input: { id: string; expectedVersion: number; sourceIds?: string[] },
    context: AgreementMutationContext,
  ): HabitVariantRecord =>
    repo.operation("void_habit_variant", input, context, "manageHabits", () => {
      const previous = readVariant(input.id, {
        turnId: context.actor === "valerie" ? context.turnId : undefined,
      });
      if (!previous || previous.version !== dailyVersion(input.expectedVersion))
        throw new DynamicConflictError("Read the current variant version.");
      const record = {
        ...previous,
        version: previous.version + 1,
        state: "voided" as const,
        revisionSources: repo.sources(input.sourceIds, context),
        updatedAt: repo.now().toISOString(),
      };
      persistVariant(record);
      return record;
    });
  const questions = (dayId: string, slot: CheckinSlot): AgreementQuestion[] => {
    if (!["morning", "evening"].includes(slot)) throw new TypeError("Choose a check-in slot.");
    const canonical = canonicalDayId(dayId);
    if (!daily.readDay(canonical)?.current) return [];
    return opportunities(canonical)
      .filter(
        (item) =>
          item.applicable === true &&
          item.definition.slots.includes(slot) &&
          readHabit(item.habitId)?.state === "active" &&
          (readHabit(item.habitId)?.effectiveAt ?? "9999") <= repo.now().toISOString() &&
          ["not_reported", "uncertain"].includes(item.outcome),
      )
      .map((item) => ({
        key: `habit:${item.habitId}:day:${canonical}`,
        habitId: item.habitId,
        definitionVersion: item.definitionVersion,
        wakingDayId: canonical,
        name: item.definition.name,
        prompt: `Ask briefly about ${item.definition.name}: ${item.definition.fullPractice}${item.definition.smallerPractice ? ` The agreed smaller version is: ${item.definition.smallerPractice}` : ""}`,
        outcome: item.outcome,
        slots: item.definition.slots,
      }));
  };
  const metrics = (
    input: {
      period?: "day" | "week" | "month";
      habitId?: string;
      limit?: number;
      dayLimit?: number;
      turnId?: string;
    } = {},
  ): HabitMetrics => {
    const period = input.period ?? "week",
      dayLimit = input.dayLimit ?? input.limit ?? 90;
    if (
      !["day", "week", "month"].includes(period) ||
      !Number.isSafeInteger(dayLimit) ||
      dayLimit < 1 ||
      dayLimit > 366
    )
      throw new TypeError(
        "Choose day/week/month grouping over at most 366 established waking days.",
      );
    const rows = repo.db
        .query<{ id: string }, [number]>(
          "SELECT id FROM core_waking_days ORDER BY rowid DESC LIMIT ?",
        )
        .all(dayLimit),
      days = [...new Set(rows.map((row) => canonicalDayId(row.id)))]
        .map((id) => daily.readDay(id, input))
        .filter((day): day is WakingDay => Boolean(day));
    const items = days
        .flatMap((day) => opportunities(day.id, input))
        .filter((item) => !input.habitId || item.habitId === input.habitId),
      counts = emptyCounts(),
      byHabit = new Map<string, { habitId: string; name: string; counts: HabitMetricCounts }>(),
      byPeriod = new Map<string, HabitMetrics["periods"][number]>();
    const add = (target: HabitMetricCounts, item: HabitOpportunity) => {
      target.opportunities++;
      if (item.applicable === true) target.applicable++;
      if (item.reported) target.reported++;
      target.outcomes[item.outcome]++;
      target.coverage = target.applicable ? target.reported / target.applicable : null;
    };
    for (const item of items) {
      add(counts, item);
      const habit = byHabit.get(item.habitId) ?? {
        habitId: item.habitId,
        name: item.definition.name,
        counts: emptyCounts(),
      };
      add(habit.counts, item);
      byHabit.set(item.habitId, habit);
      const key = metricPeriodKey(item.localStartDate, period),
        compound = `${item.habitId}:${key}`,
        group = byPeriod.get(compound) ?? {
          ...emptyCounts(),
          key,
          habitId: item.habitId,
          localStartDate: item.localStartDate,
        };
      add(group, item);
      byPeriod.set(compound, group);
    }
    const behaviorIds = new Set(items.map((item) => item.definition.behaviorId));
    const ids = [...behaviorIds],
      placeholders = ids.map(() => "?").join(",");
    const relevant = ids.length
      ? repo.db
          .query<{ json: string }, string[]>(
            `SELECT record_json AS json FROM core_dynamic_events WHERE state='active' AND kind='progress' AND behavior_id IN (${placeholders}) ORDER BY rowid DESC LIMIT ${input.turnId ? 2001 : 50}`,
          )
          .all(...ids)
          .map((row) => JSON.parse(row.json) as DailyEvent)
      : [];
    if (input.turnId && relevant.length > 2000)
      throw new TypeError(
        "This source-scoped history exceeds the bounded metric read. No partial count was presented as complete.",
      );
    const recent = relevant.filter((event) => repo.daily.visible(event, input.turnId));
    const count = (predicate: string) =>
      ids.length
        ? (repo.db
            .query<{ count: number }, string[]>(
              `SELECT count(*) AS count FROM core_dynamic_events WHERE state='active' AND kind='progress' AND behavior_id IN (${placeholders}) AND ${predicate}`,
            )
            .get(...ids)?.count ?? 0)
        : 0;
    const unassignedReports = input.turnId
      ? recent.filter((event) => event.wakingDayId === null).length
      : count("day_id IS NULL");
    const uncertainTimingReports = input.turnId
      ? recent.filter((event) => event.occurred.at === null).length
      : count("occurred_at IS NULL");
    const dates = days
      .map((day) =>
        day.wakeTime.at ? agreementLocalDate(day.wakeTime.at, day.wakeTime.timezone).date : null,
      )
      .filter((date): date is string => Boolean(date))
      .sort();
    return {
      period,
      range: {
        dayLimit,
        wakingDays: days.length,
        fromLocalDate: dates[0] ?? null,
        toLocalDate: dates.at(-1) ?? null,
      },
      counts,
      habits: [...byHabit.values()],
      periods: [...byPeriod.values()].sort((a, b) => b.key.localeCompare(a.key)),
      unassignedReports,
      uncertainTimingReports,
      recentObstacles: recent
        .filter(
          (event) =>
            event.payload.kind === "progress" &&
            (event.payload.mode === "interpretation" ||
              ["partial", "skipped", "excused"].includes(event.payload.status ?? "")),
        )
        .slice(0, 8),
    };
  };
  return {
    readHabit,
    listHabits,
    saveHabit,
    establishDay,
    opportunities,
    syncCurrentState,
    readVariant,
    logVariant,
    voidVariant,
    questions,
    metrics,
    canonicalDayId,
  };
}
