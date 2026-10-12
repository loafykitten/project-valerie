import type {
  BehaviorProgress,
  DailyEvent,
  DailyMutationContext,
  DailyWriteResult,
  ProgressBehavior,
  ProgressReport,
  ProgressReportInput,
} from "./daily-types";
import { type DailyRepository, dailyText, dailyVersion } from "./evidence";
import { dailyInstant } from "./time";
import { DynamicConflictError, DynamicValidationError } from "./types";

export function createProgressRecords(repo: DailyRepository) {
  const readBehavior = (id: string, input: { turnId?: string } = {}): ProgressBehavior | null => {
    const row = repo.db
      .query<{ json: string }, [string]>(
        "SELECT record_json AS json FROM core_progress_behaviors WHERE id=?",
      )
      .get(dailyText(id, 220, "behaviorId"));
    const behavior = row ? (JSON.parse(row.json) as ProgressBehavior) : null;
    return behavior && repo.visible(behavior, input.turnId) ? behavior : null;
  };
  const listBehaviors = (input: { includeArchive?: boolean; turnId?: string } = {}) =>
    repo.db
      .query<{ json: string }, [number]>(
        "SELECT record_json AS json FROM core_progress_behaviors WHERE state='active' OR ?=1 ORDER BY rowid DESC LIMIT 100",
      )
      .all(Number(input.includeArchive === true))
      .map((row) => JSON.parse(row.json) as ProgressBehavior)
      .filter((b) => repo.visible(b, input.turnId));
  const saveBehavior = (
    input: {
      id?: string;
      expectedVersion?: number;
      name: string;
      unit: string;
      valueKind: "count" | "status";
      state?: "active" | "archived";
      sourceIds?: string[];
    },
    context: DailyMutationContext,
  ): ProgressBehavior =>
    repo.operation("save_behavior", input, context, "manageProgress", () => {
      const previous = input.id ? readBehavior(input.id) : null;
      if (
        input.id &&
        (!previous ||
          !repo.visible(previous, context.actor === "valerie" ? context.turnId : undefined))
      )
        throw new TypeError("The behavior is unavailable.");
      if (previous && previous.version !== dailyVersion(input.expectedVersion))
        throw new DynamicConflictError("The behavior changed. Read its current version.");
      if (!previous && input.expectedVersion !== undefined)
        throw new TypeError("Omit expectedVersion for a new behavior.");
      if (
        !["count", "status"].includes(input.valueKind) ||
        !["active", "archived"].includes(input.state ?? "active")
      )
        throw new TypeError("Choose a known value kind and state.");
      const name = dailyText(input.name, 120, "name"),
        unit = dailyText(input.unit, 60, "unit");
      if (previous && (previous.unit !== unit || previous.valueKind !== input.valueKind))
        throw new DynamicValidationError(
          "unit",
          "meaning_changed",
          "Create a new behavior for a different unit or measurement meaning. Historical values keep their original meaning.",
        );
      const state = input.state ?? previous?.state ?? "active";
      const sources = repo.evidence(input.sourceIds, context);
      const normalized = (value: string) =>
        value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
      const active = listBehaviors();
      const identical =
        state === "active"
          ? active.find(
              (item) =>
                item.id !== previous?.id &&
                normalized(item.name) === normalized(name) &&
                normalized(item.unit) === normalized(unit) &&
                item.valueKind === input.valueKind,
            )
          : undefined;
      if (identical) {
        if (
          previous ||
          !repo.visible(identical, context.actor === "valerie" ? context.turnId : undefined)
        )
          throw new DynamicConflictError(
            "An identical active tracking subject already exists. Use that subject instead of creating a parallel counter.",
          );
        return identical;
      }
      if (state === "active" && previous?.state !== "active" && active.length >= 50)
        throw new TypeError("At most 50 active behaviors may be configured.");
      const behavior: ProgressBehavior = {
        id: previous?.id ?? crypto.randomUUID(),
        version: (previous?.version ?? 0) + 1,
        name,
        unit,
        valueKind: input.valueKind,
        aggregation: input.valueKind === "count" ? "count" : "latest_status",
        state,
        sources,
        createdAt: previous?.createdAt ?? repo.now().toISOString(),
        updatedAt: repo.now().toISOString(),
      };
      const json = JSON.stringify(behavior);
      repo.db
        .query(
          "INSERT INTO core_progress_behaviors VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state,record_json=excluded.record_json",
        )
        .run(behavior.id, behavior.version, behavior.state, json);
      repo.db
        .query("INSERT INTO core_progress_behavior_revisions VALUES(?,?,?)")
        .run(behavior.id, behavior.version, json);
      return behavior;
    });
  const payloadFor = (
    input: ProgressReportInput,
    behavior: ProgressBehavior,
    sources: DailyEvent["sources"],
  ): ProgressReport => {
    if (!["occurrence", "total_so_far", "status", "plan", "interpretation"].includes(input.mode))
      throw new TypeError("Choose a known reporting mode.");
    if (
      input.evidenceKind &&
      !["owner_report", "valerie_interpretation"].includes(input.evidenceKind)
    )
      throw new TypeError(
        "Only registered observation adapters may record integration observations.",
      );
    if (
      (input.evidenceKind === "valerie_interpretation") !== (input.mode === "interpretation") &&
      input.evidenceKind !== undefined
    )
      throw new TypeError(
        "Interpretations use interpretation mode and never count as completed actions.",
      );
    const payload: ProgressReport = {
      kind: "progress",
      behaviorId: behavior.id,
      behaviorVersion: behavior.version,
      mode: input.mode,
    };
    if (input.mode === "occurrence" || input.mode === "total_so_far") {
      if (
        behavior.valueKind !== "count" ||
        !Number.isSafeInteger(input.value) ||
        Number(input.value) < (input.mode === "occurrence" ? 1 : 0) ||
        Number(input.value) > 1000000
      )
        throw new TypeError(
          "Count reports need a bounded nonnegative whole quantity; occurrences must be positive.",
        );
      payload.value = input.value;
      if (input.mode === "total_so_far")
        payload.totalThroughAt = repo.assertNotFuture(
          input.totalThroughAt ??
            sources
              .map((s) => s.observedAt)
              .sort()
              .at(-1) ??
            repo.now().toISOString(),
          sources,
        );
      if (
        input.status !== undefined ||
        input.plannedFor !== undefined ||
        (input.mode === "occurrence" && input.totalThroughAt !== undefined)
      )
        throw new TypeError("A count report cannot also be a plan or status.");
    } else if (input.mode === "status") {
      if (
        !["done", "partial", "skipped", "excused"].includes(input.status ?? "") ||
        input.value !== undefined ||
        input.totalThroughAt !== undefined ||
        input.plannedFor !== undefined
      )
        throw new TypeError(
          "A status report is done, partial, skipped or excused, without a numeric quantity.",
        );
      payload.status = input.status;
    } else if (input.mode === "plan") {
      if (input.status !== undefined || input.totalThroughAt !== undefined)
        throw new TypeError("A plan is not completed progress.");
      if (input.value !== undefined) {
        if (!Number.isSafeInteger(input.value) || input.value < 0 || input.value > 1000000)
          throw new TypeError("Invalid planned quantity.");
        payload.value = input.value;
      }
      if (input.plannedFor !== undefined) payload.plannedFor = dailyInstant(input.plannedFor);
    } else if (
      input.value !== undefined ||
      input.status !== undefined ||
      input.totalThroughAt !== undefined ||
      input.plannedFor !== undefined
    )
      throw new TypeError("Interpretations retain prose, not a completion or quantity.");
    return payload;
  };
  const recordProgressReport = (
    input: ProgressReportInput,
    context: DailyMutationContext,
  ): DailyWriteResult =>
    repo.operation("record_progress", input, context, "manageProgress", () => {
      const behavior = readBehavior(input.behaviorId);
      if (
        behavior?.state !== "active" ||
        !repo.visible(behavior, context.actor === "valerie" ? context.turnId : undefined)
      )
        throw new TypeError(
          "Choose an active available behavior, or configure the actual tracking subject first.",
        );
      repo.assertDay(input.wakingDayId);
      const sources = repo.evidence(input.sourceIds, context),
        occurred = repo.timeFor(input.occurred, sources),
        payload = payloadFor(input, behavior, sources),
        claims = repo.claimed(sources, `behavior:${behavior.id}`);
      if (
        context.actor === "valerie" &&
        claims.some((event) => !repo.visible(event, context.turnId))
      )
        throw new DynamicValidationError(
          "sourceIds",
          "source_unavailable",
          "That source claim has a revision unavailable to this turn. No progress changed.",
        );
      if (!input.sameEventId && claims.length) {
        if (claims.length > 1)
          return {
            effect: "needs_clarification",
            event: null,
            day: input.wakingDayId ? repo.readDay(input.wakingDayId) : null,
            reason: "sources_refer_to_different_events",
          };
        const event = claims[0] as DailyEvent;
        const differs =
          event.payload.kind !== "progress" ||
          event.payload.mode !== payload.mode ||
          event.payload.value !== payload.value ||
          event.payload.status !== payload.status ||
          event.payload.totalThroughAt !== payload.totalThroughAt ||
          event.payload.plannedFor !== payload.plannedFor ||
          event.wakingDayId !== input.wakingDayId ||
          event.occurred.at !== occurred.at;
        if (event.state === "voided" || differs)
          return {
            effect: "needs_clarification",
            event,
            day: event.wakingDayId ? repo.readDay(event.wakingDayId) : null,
            reason:
              event.state === "voided"
                ? "source_claim_withdrawn"
                : "source_claim_requires_correction",
          };
        return {
          effect: "already_recorded",
          event,
          day: event.wakingDayId ? repo.readDay(event.wakingDayId) : null,
        };
      }
      let event: DailyEvent;
      if (input.sameEventId) {
        const existing = repo.readEvent(input.sameEventId, {
          turnId: context.actor === "valerie" ? context.turnId : undefined,
        });
        if (
          existing?.state !== "active" ||
          existing.payload.kind !== "progress" ||
          existing.payload.behaviorId !== behavior.id
        )
          throw new TypeError("Choose an active event for this behavior.");
        if (existing.version !== dailyVersion(input.expectedEventVersion))
          throw new DynamicConflictError("This event changed. Read its current version.");
        if (
          input.wakingDayId !== existing.wakingDayId ||
          payload.mode !== existing.payload.mode ||
          payload.value !== existing.payload.value ||
          payload.status !== existing.payload.status ||
          payload.totalThroughAt !== existing.payload.totalThroughAt ||
          payload.plannedFor !== existing.payload.plannedFor
        )
          throw new DynamicValidationError(
            "sameEventId",
            "different_claim",
            "A same-event reference enriches evidence without changing its count, mode or day. Use an explicit correction to change the report.",
          );
        event = {
          ...existing,
          version: existing.version + 1,
          revisionSources: sources,
          updatedAt: repo.now().toISOString(),
        };
      } else
        event = {
          ...repo.eventBase(input.summary, occurred, sources, context),
          wakingDayId: input.wakingDayId,
          evidenceKind: input.mode === "interpretation" ? "valerie_interpretation" : "owner_report",
          payload,
        };
      repo.persistEvent(event);
      repo.attachClaims(event, sources);
      return {
        effect: input.sameEventId ? "updated" : "created",
        event,
        day: event.wakingDayId ? repo.readDay(event.wakingDayId) : null,
      };
    });
  const readBehaviorProgress = (
    behaviorId: string,
    wakingDayId: string,
    input: { turnId?: string } = {},
  ): BehaviorProgress => {
    const behavior = readBehavior(behaviorId);
    if (!behavior || !repo.visible(behavior, input.turnId) || !repo.readDay(wakingDayId, input))
      throw new TypeError("Choose an available behavior and waking day.");
    const events = repo
      .allEvents(wakingDayId, behaviorId)
      .filter(
        (e) =>
          e.state === "active" &&
          repo.visible(e, input.turnId) &&
          e.evidenceKind !== "valerie_interpretation" &&
          e.payload.kind === "progress" &&
          !["plan", "interpretation"].includes(e.payload.mode),
      );
    const base: BehaviorProgress = {
      behaviorId,
      wakingDayId,
      value: null,
      status: null,
      basis: "not_reported",
      asOf: null,
      reportedTotal: null,
      eventIds: events.map((e) => e.id),
      unresolvedEventIds: [],
    };
    const numeric = events.filter(
      (e) =>
        e.payload.kind === "progress" && ["occurrence", "total_so_far"].includes(e.payload.mode),
    );
    const statuses = events.filter(
      (e) => e.payload.kind === "progress" && e.payload.mode === "status",
    );
    if (behavior.valueKind === "status" || (!numeric.length && statuses.length)) {
      if (!statuses.length) return base;
      const unknown = statuses.filter((e) => !e.occurred.at);
      if (unknown.length > 1 || (unknown.length && statuses.length > 1))
        return { ...base, basis: "uncertain", unresolvedEventIds: unknown.map((e) => e.id) };
      statuses.sort((a, b) =>
        (a.occurred.at ?? a.recordedAt).localeCompare(b.occurred.at ?? b.recordedAt),
      );
      const latest = statuses.at(-1) as DailyEvent;
      return {
        ...base,
        status: latest.payload.kind === "progress" ? (latest.payload.status ?? null) : null,
        basis: "status_report",
        asOf: latest.occurred.at,
      };
    }
    if (!numeric.length) return base;
    const quantity = (e: DailyEvent) =>
      e.payload.kind === "progress" ? (e.payload.value ?? 0) : 0;
    const occurrences = numeric.filter(
      (e) => e.payload.kind === "progress" && e.payload.mode === "occurrence",
    );
    const totals = numeric
      .filter((e) => e.payload.kind === "progress" && e.payload.mode === "total_so_far")
      .sort((a, b) =>
        (a.payload.kind === "progress" ? (a.payload.totalThroughAt ?? "") : "").localeCompare(
          b.payload.kind === "progress" ? (b.payload.totalThroughAt ?? "") : "",
        ),
      );
    if (!totals.length)
      return {
        ...base,
        value: occurrences.reduce((sum, e) => sum + quantity(e), 0),
        basis: "occurrences",
        asOf:
          occurrences
            .map((e) => e.occurred.at)
            .filter((v): v is string => Boolean(v))
            .sort()
            .at(-1) ?? null,
      };
    const checkpoint = totals.at(-1) as DailyEvent,
      cutoff =
        checkpoint.payload.kind === "progress" ? (checkpoint.payload.totalThroughAt as string) : "",
      total = quantity(checkpoint);
    const unknown = occurrences.filter((e) => !e.occurred.at),
      before = occurrences.filter((e) => e.occurred.at && e.occurred.at <= cutoff),
      after = occurrences.filter((e) => e.occurred.at && e.occurred.at > cutoff);
    const conflicting = totals.filter((e) => e.id !== checkpoint.id && quantity(e) > total);
    const sameTime = totals.filter(
      (e) =>
        e.payload.kind === "progress" &&
        e.payload.totalThroughAt === cutoff &&
        quantity(e) !== total,
    );
    if (
      conflicting.length ||
      sameTime.length ||
      before.reduce((sum, e) => sum + quantity(e), 0) > total
    )
      return {
        ...base,
        basis: "conflicting",
        reportedTotal: total,
        asOf: cutoff,
        unresolvedEventIds: [...new Set([...conflicting, ...sameTime, ...before].map((e) => e.id))],
      };
    if (unknown.length)
      return {
        ...base,
        basis: "uncertain",
        reportedTotal: total,
        asOf: cutoff,
        unresolvedEventIds: unknown.map((e) => e.id),
      };
    return {
      ...base,
      value: total + after.reduce((sum, e) => sum + quantity(e), 0),
      reportedTotal: total,
      basis: after.length ? "reported_total_plus_occurrences" : "reported_total",
      asOf:
        after
          .map((e) => e.occurred.at as string)
          .sort()
          .at(-1) ?? cutoff,
    };
  };
  return {
    readBehavior,
    listBehaviors,
    saveBehavior,
    payloadFor,
    recordProgressReport,
    readBehaviorProgress,
  };
}
