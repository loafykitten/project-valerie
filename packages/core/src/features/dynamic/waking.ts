import type {
  DailyEvent,
  DailyMutationContext,
  DailyWriteResult,
  WakingDay,
  WakingReport,
  WakingReportInput,
  WakingState,
} from "./daily-types";
import { type DailyRepository, dailyVersion } from "./evidence";
import { dailyInstant } from "./time";
import { DynamicConflictError, DynamicValidationError } from "./types";

const states: Partial<Record<WakingReport["report"], WakingState>> = {
  day_start: "awake_reported",
  main_wake: "awake_reported",
  awake_update: "awake_reported",
  nap_wake: "awake_reported",
  main_sleep_intent: "main_sleep_intended",
  nap_intent: "nap_intended",
  uncertain: "unknown",
};
export function createWakingRecords(repo: DailyRepository) {
  const recalculateDay = (id: string, causalEventId: string): WakingDay | null => {
    const day = repo.readDay(id);
    if (!day) return null;
    const events = repo
      .allEvents(id)
      .filter((e) => e.state === "active" && e.stateApplied && e.payload.kind === "waking");
    const opening = events.find((e) => e.id === day.wakeEventId);
    let state: WakingState = "unknown",
      stateEventId: string | null = null,
      expectedSleepAt: string | null = null,
      sleepEstimateBasis: WakingDay["sleepEstimateBasis"] = "none",
      sleepPlanEventId: string | null = null;
    for (const event of events) {
      if (event.payload.kind !== "waking") continue;
      const report = event.payload;
      const next = states[report.report];
      if (next) {
        state = next;
        stateEventId = event.id;
      }
      if (Object.hasOwn(report, "expectedSleepAt")) {
        if (report.sleepEstimateBasis !== "usual_routine" || sleepEstimateBasis !== "owner_plan") {
          expectedSleepAt = report.expectedSleepAt ?? null;
          sleepEstimateBasis = expectedSleepAt
            ? (report.sleepEstimateBasis ?? "owner_plan")
            : "none";
          sleepPlanEventId = expectedSleepAt ? event.id : null;
        }
      }
      if (
        next === "awake_reported" &&
        expectedSleepAt &&
        (event.occurred.at ?? event.recordedAt) >= expectedSleepAt
      ) {
        expectedSleepAt = null;
        sleepEstimateBasis = "none";
        sleepPlanEventId = null;
      }
    }
    const updated: WakingDay = {
      ...day,
      version: day.version + 1,
      wakeTime: opening?.occurred ?? { ...day.wakeTime, at: null, basis: "unknown" },
      morningEligible: day.morningEligible && Boolean(opening),
      state,
      stateEventId,
      expectedSleepAt,
      sleepEstimateBasis,
      sleepPlanEventId,
      inputWatermark: events.at(-1)?.inputWatermark ?? day.inputWatermark,
      updatedAt: repo.now().toISOString(),
    };
    repo.persistDay(updated, causalEventId);
    return updated;
  };
  const recordWakingReport = (
    input: WakingReportInput,
    context: DailyMutationContext,
  ): DailyWriteResult =>
    repo.operation("record_waking", input, context, "manageWaking", () => {
      if (
        ![
          "day_start",
          "main_wake",
          "awake_update",
          "main_sleep_intent",
          "nap_intent",
          "nap_wake",
          "sleep_plan",
          "uncertain",
        ].includes(input.report) ||
        !["current", "history"].includes(input.mode)
      )
        throw new TypeError("Choose a known waking report and current or history mode.");
      const sources = repo.evidence(input.sourceIds, context);
      // Validate an explicitly supplied fact time even when its quote/freshness
      // also needs repair. Message-time defaults are resolved from the qualified
      // current report below, rather than an older supporting routine.
      if (input.occurred?.basis !== "message_time" || input.occurred.at !== null)
        repo.timeFor(input.occurred, sources);
      const fresh = repo.currentSource(sources, context, input.evidenceQuote);
      if (input.mode === "current" && !fresh.eligible)
        return {
          effect: "needs_clarification",
          event: null,
          day: repo.currentDay(context.turnId),
          reason: fresh.reason,
        };
      const claimSources =
        input.mode === "current"
          ? sources.filter((source) => fresh.reportSourceIds.includes(source.id))
          : sources;
      const occurred = repo.timeFor(input.occurred, claimSources);
      const key = input.report === "sleep_plan" ? "sleep_plan" : "waking_status";
      const prior = repo.claimed(claimSources, key);
      if (
        context.actor === "valerie" &&
        prior.some((event) => !repo.visible(event, context.turnId))
      )
        throw new DynamicValidationError(
          "sourceIds",
          "source_unavailable",
          "That source claim has a revision unavailable to this turn. No waking state changed.",
        );
      if (prior.length) {
        if (prior.length > 1)
          return {
            effect: "needs_clarification",
            event: null,
            day: repo.currentDay(context.turnId),
            reason: "sources_refer_to_different_events",
          };
        const event = prior[0] as DailyEvent;
        const originalReport = event.payload.kind === "waking" ? event.payload : null;
        const sameReport =
          originalReport?.report === input.report ||
          ((input.report === "main_wake" || input.report === "day_start") &&
            originalReport &&
            ["awake_update", "nap_wake"].includes(originalReport.report));
        const differs =
          !sameReport ||
          event.stateApplied !== (input.mode === "current") ||
          event.occurred.at !== occurred.at ||
          (input.mode === "history" && event.wakingDayId !== (input.wakingDayId ?? null)) ||
          (input.expectedSleepAt !== undefined &&
            (input.expectedSleepAt === null ? null : dailyInstant(input.expectedSleepAt)) !==
              (originalReport?.expectedSleepAt ?? null)) ||
          (input.sleepEstimateBasis !== undefined &&
            input.sleepEstimateBasis !== (originalReport?.sleepEstimateBasis ?? "none"));
        if (event.state === "voided" || differs)
          return {
            effect: "needs_clarification",
            event,
            day: event.wakingDayId
              ? repo.readDay(event.wakingDayId, { turnId: context.turnId })
              : null,
            reason:
              event.state === "voided"
                ? "source_claim_withdrawn"
                : "source_claim_requires_correction",
          };
        return {
          effect: "already_recorded",
          event,
          day: event.wakingDayId
            ? repo.readDay(event.wakingDayId, { turnId: context.turnId })
            : null,
        };
      }
      let current = repo.currentDay();
      if (
        input.mode === "current" &&
        ((current?.id ?? null) !== input.expectedCurrentDayId ||
          (current?.version ?? null) !== input.expectedDayVersion)
      )
        throw new DynamicConflictError(
          "The current waking day changed. Read its ID and version before applying this report.",
        );
      let report = input.report;
      if (input.mode === "current" && current && occurred.at) {
        const latestState = current.stateEventId ? repo.readEvent(current.stateEventId) : null;
        const threshold = [current.wakeTime.at, latestState?.occurred.at]
          .filter((at): at is string => Boolean(at))
          .sort()
          .at(-1);
        if (threshold && occurred.at < threshold)
          return {
            effect: "needs_clarification",
            event: null,
            day: current,
            reason: "historical_time_requires_history_or_correction",
          };
      }
      const startsPeriod = report === "day_start" || report === "main_wake";
      const requestsNewPeriod = report === "day_start" || input.newMainPeriod === true;
      let newDay = input.mode === "current" && startsPeriod && !current;
      if (input.mode === "current" && startsPeriod && current) {
        const greetingOnly =
          /^(?:hey[,!\s]*)?(?:good\s+morning|morning|hello|hi)(?:[,!.\s]*(?:again|there))*[,!.\s]*$/i.test(
            input.evidenceQuote?.trim() ?? "",
          );
        const lastReport = current.stateEventId ? repo.readEvent(current.stateEventId) : null;
        const lastReportAt =
          lastReport?.sources
            .map((source) => source.observedAt)
            .sort()
            .at(-1) ??
          current.wakeReceivedAt ??
          current.createdAt;
        const recentRepeat = Date.parse(fresh.receivedAt) - Date.parse(lastReportAt) < 30 * 60000;
        if (occurred.at && occurred.at === current.wakeTime.at) report = "awake_update";
        else if (
          current.state === "nap_intended" &&
          ((input.report === "main_wake" && input.newMainPeriod !== true) ||
            (input.report === "day_start" && greetingOnly && recentRepeat))
        )
          report = "nap_wake";
        else if (current.state === "main_sleep_intended") newDay = true;
        else if (!requestsNewPeriod) report = "awake_update";
        else {
          // A model flag alone must not turn repeated greetings into duplicate days.
          // This rejects ambiguous transitions; it never creates a wake from text.
          // A recent bare greeting is a likely repeat. A longer gap still needs
          // explicit current-message interpretation; elapsed time creates no day.
          if (context.actor === "valerie" && greetingOnly && recentRepeat)
            return {
              effect: "needs_clarification",
              event: null,
              day: current,
              reason: "new_main_period_not_established",
            };
          newDay = true;
        }
      }
      if (input.mode === "current" && !current && !newDay)
        return {
          effect: "needs_clarification",
          event: null,
          day: null,
          reason: "waking_day_not_established",
        };
      const payload: WakingReport = { kind: "waking", report };
      if (input.expectedSleepAt !== undefined) {
        payload.expectedSleepAt =
          input.expectedSleepAt === null ? null : dailyInstant(input.expectedSleepAt);
        payload.sleepEstimateBasis =
          input.expectedSleepAt === null ? "none" : (input.sleepEstimateBasis ?? "owner_plan");
      }
      if (
        input.sleepEstimateBasis !== undefined &&
        !["owner_plan", "usual_routine", "none"].includes(input.sleepEstimateBasis)
      )
        throw new TypeError("Choose a stated plan, usual-routine estimate, or no estimate.");
      if (report === "sleep_plan" && input.expectedSleepAt === undefined)
        throw new TypeError("Provide an expected sleep time or null to clear the plan.");
      const event: DailyEvent = {
        ...repo.eventBase(input.summary, occurred, sources, context),
        wakingDayId: input.mode === "history" ? (input.wakingDayId ?? null) : (current?.id ?? null),
        evidenceKind: "owner_report",
        payload,
        stateApplied: input.mode === "current",
        inputWatermark: fresh.watermark,
      };
      repo.assertDay(event.wakingDayId);
      if (newDay) {
        if (current) {
          current = {
            ...current,
            version: current.version + 1,
            current: false,
            closedReason:
              report === "day_start" ? "next_day_start_reported" : "next_main_wake_reported",
            updatedAt: repo.now().toISOString(),
          };
          repo.persistDay(current, event.id);
        }
        const id = crypto.randomUUID();
        event.wakingDayId = id;
        current = {
          id,
          version: 1,
          current: true,
          wakeTime: occurred,
          startReport: report === "day_start" ? "day_start" : "main_wake",
          wakeEventId: event.id,
          wakeReceivedAt: fresh.receivedAt,
          morningEligible:
            input.mode === "current" &&
            (!occurred.at || Date.parse(fresh.receivedAt) - Date.parse(occurred.at) < 4 * 3600000),
          state: "awake_reported",
          stateEventId: event.id,
          expectedSleepAt: payload.expectedSleepAt ?? null,
          sleepEstimateBasis: payload.expectedSleepAt
            ? (payload.sleepEstimateBasis ?? "owner_plan")
            : "none",
          sleepPlanEventId: payload.expectedSleepAt ? event.id : null,
          inputWatermark: fresh.watermark,
          mergedIntoDayId: null,
          closedReason: null,
          createdAt: repo.now().toISOString(),
          updatedAt: repo.now().toISOString(),
        };
        repo.persistDay(current, event.id);
      }
      repo.persistEvent(event);
      repo.attachClaims(event, claimSources);
      if (input.mode === "current" && current && !newDay) {
        current = recalculateDay(current.id, event.id);
      }
      return {
        effect: "created",
        event,
        day:
          input.mode === "current"
            ? current
            : event.wakingDayId
              ? repo.readDay(event.wakingDayId)
              : null,
      };
    });
  const mergeDays = (
    input: {
      fromId: string;
      expectedFromVersion: number;
      intoId: string;
      expectedIntoVersion: number;
      sourceIds?: string[];
    },
    context: DailyMutationContext,
  ): DailyWriteResult =>
    repo.operation("merge_days", input, context, "manageWaking", () => {
      if (context.actor !== "owner")
        throw new TypeError("Merge mistaken waking days through the owner dashboard.");
      if (input.fromId === input.intoId) throw new TypeError("Choose two different waking days.");
      const from = repo.readDay(input.fromId),
        into = repo.readDay(input.intoId);
      if (!from || !into || from.mergedIntoDayId || into.mergedIntoDayId)
        throw new TypeError("Choose two available waking days.");
      if (
        from.version !== dailyVersion(input.expectedFromVersion) ||
        into.version !== dailyVersion(input.expectedIntoVersion)
      )
        throw new DynamicConflictError("A waking day changed before the merge.");
      const sources = repo.evidence(input.sourceIds, context),
        time = {
          at: repo.now().toISOString(),
          timezone: into.wakeTime.timezone,
          basis: "message_time" as const,
        };
      const event: DailyEvent = {
        ...repo.eventBase("Owner merged a mistaken duplicate waking day.", time, sources, context),
        wakingDayId: into.id,
        evidenceKind: "owner_report",
        payload: { kind: "day_merge", fromId: from.id, intoId: into.id },
        stateApplied: false,
        inputWatermark: null,
      };
      repo.persistEvent(event);
      for (const existing of repo.allEvents(from.id)) {
        repo.persistEvent({
          ...existing,
          version: existing.version + 1,
          wakingDayId: into.id,
          revisionSources: sources,
          updatedAt: repo.now().toISOString(),
        });
      }
      repo.persistDay(
        {
          ...from,
          version: from.version + 1,
          current: false,
          mergedIntoDayId: into.id,
          closedReason: "merged",
          updatedAt: repo.now().toISOString(),
        },
        event.id,
      );
      const merged = {
        ...into,
        version: into.version + 1,
        current: into.current || from.current,
        closedReason: null,
        morningEligible: false,
        updatedAt: repo.now().toISOString(),
      };
      repo.persistDay(merged, event.id);
      return { effect: "updated", event, day: recalculateDay(into.id, event.id) };
    });
  return { recordWakingReport, recalculateDay, mergeDays };
}
