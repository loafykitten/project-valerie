import type {
  DailyEvent,
  DailyEventEdit,
  DailyMutationContext,
  DailyOverview,
  DailySnapshot,
  DailyWriteResult,
} from "./daily-types";
import { createDailyRepository, dailyText, dailyVersion } from "./evidence";
import { createProgressRecords } from "./progress";
import { createDynamicService } from "./service";
import { calculateCheckinWindow } from "./time";
import { DynamicConflictError } from "./types";
import { createWakingRecords } from "./waking";

export function createDailyService(
  store: Parameters<typeof createDailyRepository>[0],
  options: Parameters<typeof createDailyRepository>[1] = {},
) {
  const repo = createDailyRepository(store, options),
    waking = createWakingRecords(repo),
    progress = createProgressRecords(repo),
    dynamic = createDynamicService(store, options);
  const listDays = (input: { limit?: number; turnId?: string } = {}) => {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new TypeError("Choose a bounded day list.");
    return repo.db
      .query<{ id: string }, [number]>(
        "SELECT id FROM core_waking_days ORDER BY rowid DESC LIMIT ?",
      )
      .all(limit)
      .map((row) => repo.readDay(row.id, input))
      .filter((day): day is NonNullable<typeof day> => Boolean(day));
  };
  const listEvents = (
    input: {
      dayId?: string | null;
      behaviorId?: string;
      limit?: number;
      cursor?: string;
      turnId?: string;
    } = {},
  ) => {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new TypeError("Choose a bounded event page.");
    let before = Number.MAX_SAFE_INTEGER;
    if (input.cursor) {
      const row = repo.db
        .query<{ position: number }, [string]>(
          "SELECT rowid AS position FROM core_dynamic_events WHERE id=?",
        )
        .get(dailyText(input.cursor, 220, "cursor"));
      if (!row) throw new TypeError("Reload events without the old cursor.");
      before = row.position;
    }
    const rows = repo.db
      .query<
        { json: string },
        [number, number, string | null, string | null, string | null, number]
      >(
        `SELECT record_json AS json FROM core_dynamic_events WHERE rowid<? AND (?=0 OR day_id IS ?) AND (? IS NULL OR behavior_id=?) ORDER BY rowid DESC LIMIT ?`,
      )
      .all(
        before,
        Number(Object.hasOwn(input, "dayId")),
        input.dayId ?? null,
        input.behaviorId ?? null,
        input.behaviorId ?? null,
        limit + 1,
      );
    const scanned = rows.slice(0, limit).map((row) => JSON.parse(row.json) as DailyEvent);
    return {
      items: scanned.filter((event) => repo.visible(event, input.turnId)),
      nextCursor: rows.length > limit ? (scanned.at(-1)?.id ?? null) : null,
    };
  };
  const reviseEvent = (input: DailyEventEdit, context: DailyMutationContext): DailyWriteResult => {
    const initial = repo.readEvent(input.id, {
      turnId: context.actor === "valerie" ? context.turnId : undefined,
    });
    if (!initial || initial.payload.kind === "day_merge")
      throw new TypeError("Choose an available waking or progress event.");
    return repo.operation(
      "revise_daily_event",
      input,
      context,
      initial.payload.kind === "waking" ? "manageWaking" : "manageProgress",
      () => {
        const previous = repo.readEvent(input.id, {
          turnId: context.actor === "valerie" ? context.turnId : undefined,
        });
        if (!previous || previous.version !== dailyVersion(input.expectedVersion))
          throw new DynamicConflictError("This event changed. Read its current version.");
        const sources = repo.evidence(input.sourceIds, context),
          dayId = input.wakingDayId === undefined ? previous.wakingDayId : input.wakingDayId;
        repo.assertDay(dayId);
        if (
          dayId &&
          !repo.readDay(dayId, { turnId: context.actor === "valerie" ? context.turnId : undefined })
        )
          throw new TypeError("Choose a day available to this conversation.");
        let payload = previous.payload;
        if (input.progress) {
          if (previous.payload.kind !== "progress")
            throw new TypeError("Progress corrections cannot change a waking report.");
          const behavior = progress.readBehavior(previous.payload.behaviorId);
          if (!behavior) throw new TypeError("Behavior unavailable.");
          payload = progress.payloadFor(
            {
              ...input.progress,
              behaviorId: behavior.id,
              wakingDayId: dayId,
              occurred: input.occurred ?? previous.occurred,
              summary: input.summary ?? previous.summary,
            },
            behavior,
            sources,
          );
        }
        const contentChanged =
          input.summary !== undefined ||
          input.occurred !== undefined ||
          input.progress !== undefined;
        const event: DailyEvent = {
          ...previous,
          version: previous.version + 1,
          state: previous.state,
          wakingDayId: dayId,
          payload,
          summary:
            input.summary === undefined
              ? previous.summary
              : dailyText(input.summary, 1000, "summary"),
          occurred: input.occurred ? repo.timeFor(input.occurred, sources) : previous.occurred,
          evidenceKind: input.progress
            ? payload.kind === "progress" && payload.mode === "interpretation"
              ? "valerie_interpretation"
              : "owner_report"
            : previous.evidenceKind,
          sources: contentChanged ? sources : previous.sources,
          revisionSources: sources,
          updatedAt: repo.now().toISOString(),
        };
        repo.persistEvent(event);
        repo.attachClaims(event, sources);
        if (previous.payload.kind === "waking") {
          if (previous.wakingDayId) waking.recalculateDay(previous.wakingDayId, event.id);
          if (dayId && dayId !== previous.wakingDayId) waking.recalculateDay(dayId, event.id);
        }
        return { effect: "updated", event, day: dayId ? repo.readDay(dayId) : null };
      },
    );
  };
  const voidEvent = (
    input: { id: string; expectedVersion: number; sourceIds?: string[] },
    context: DailyMutationContext,
  ): DailyWriteResult => {
    const original = repo.readEvent(input.id, {
      turnId: context.actor === "valerie" ? context.turnId : undefined,
    });
    if (!original || original.payload.kind === "day_merge")
      throw new TypeError("Choose an available waking or progress event.");
    return repo.operation(
      "void_daily_event",
      input,
      context,
      original.payload.kind === "waking" ? "manageWaking" : "manageProgress",
      () => {
        const previous = repo.readEvent(input.id, {
          turnId: context.actor === "valerie" ? context.turnId : undefined,
        });
        if (!previous || previous.version !== dailyVersion(input.expectedVersion))
          throw new DynamicConflictError("This event changed. Read its current version.");
        const sources = repo.evidence(input.sourceIds, context),
          event: DailyEvent = {
            ...previous,
            version: previous.version + 1,
            state: "voided",
            revisionSources: sources,
            updatedAt: repo.now().toISOString(),
          };
        repo.persistEvent(event);
        if (event.payload.kind === "waking" && event.wakingDayId)
          waking.recalculateDay(event.wakingDayId, event.id);
        return {
          effect: "updated",
          event,
          day: event.wakingDayId ? repo.readDay(event.wakingDayId) : null,
        };
      },
    );
  };
  const overview = (input: { turnId?: string; limit?: number } = {}): DailyOverview =>
    repo.db.transaction(() => {
      const currentDay = repo.currentDay(input.turnId),
        behaviors = progress.listBehaviors({ ...input, includeArchive: true }),
        currentProgress = currentDay
          ? behaviors
              .filter((b) => b.state === "active")
              .map((b) => progress.readBehaviorProgress(b.id, currentDay.id, input))
          : [];
      return {
        settings: dynamic.getSettings(),
        currentDay,
        days: listDays(input),
        behaviors,
        events: listEvents(input).items,
        progress: currentProgress,
        windows: currentDay
          ? [
              calculateCheckinWindow(currentDay, "morning", {
                now: repo.now(),
                inputWatermark: repo.latestWatermark(input.turnId),
              }),
              calculateCheckinWindow(currentDay, "evening", {
                now: repo.now(),
                inputWatermark: repo.latestWatermark(input.turnId),
              }),
            ].filter((window): window is NonNullable<typeof window> => Boolean(window))
          : [],
      };
    })();
  return {
    getSettings: dynamic.getSettings,
    saveSettings(input: {
      expectedVersion: number;
      allowValerieManageWaking: boolean;
      allowValerieManageProgress: boolean;
    }) {
      if (
        typeof input.allowValerieManageWaking !== "boolean" ||
        typeof input.allowValerieManageProgress !== "boolean"
      )
        throw new TypeError("Choose both daily tracking permissions.");
      return repo.db
        .transaction(() => {
          const settings = dynamic.getSettings();
          return dynamic.saveSettings({ ...settings, ...input });
        })
        .immediate();
    },
    overview,
    readDay: repo.readDay,
    currentDay: repo.currentDay,
    listDays,
    readEvent: repo.readEvent,
    listEvents,
    readBehavior: progress.readBehavior,
    listBehaviors: progress.listBehaviors,
    saveBehavior: progress.saveBehavior,
    recordWakingReport: waking.recordWakingReport,
    recordProgressReport: progress.recordProgressReport,
    reviseEvent,
    voidEvent,
    mergeDays: waking.mergeDays,
    readBehaviorProgress: progress.readBehaviorProgress,
    capture(input: { turnId?: string } = {}): DailySnapshot {
      return repo.db.transaction(() => {
        const settings = dynamic.getSettings(),
          day = repo.currentDay(input.turnId),
          permissions = {
            manageWaking: settings.allowValerieManageWaking === true,
            manageProgress: settings.allowValerieManageProgress === true,
          };
        const currentDay = day
          ? (({ createdAt: _created, updatedAt: _updated, ...compact }) => compact)(day)
          : null;
        const currentProgress = day
          ? progress
              .listBehaviors(input)
              .slice(0, 8)
              .map((b) => progress.readBehaviorProgress(b.id, day.id, input))
          : [];
        const renderedProgress = currentProgress.map((item) => ({
          ...item,
          name: progress.readBehavior(item.behaviorId)?.name,
          unit: progress.readBehavior(item.behaviorId)?.unit,
          eventIds: item.eventIds.slice(-5),
          unresolvedEventIds: item.unresolvedEventIds.slice(-5),
        }));
        return {
          revision: `${settings.version}:${repo.db.query<{ value: number }, []>("SELECT coalesce(max(rowid),0) AS value FROM core_waking_day_revisions").get()?.value ?? 0}:${repo.db.query<{ value: number }, []>("SELECT coalesce(max(rowid),0) AS value FROM core_dynamic_event_revisions").get()?.value ?? 0}:${repo.db.query<{ value: number }, []>("SELECT coalesce(max(rowid),0) AS value FROM core_progress_behavior_revisions").get()?.value ?? 0}`,
          capturedAt: repo.now().toISOString(),
          settingsVersion: settings.version,
          permissions,
          currentDay,
          progress: renderedProgress,
          content: day
            ? `Reported waking-day context (sleep intentions are not observations; counts describe reports, not worth):\n${JSON.stringify({ day: currentDay, progress: renderedProgress })}`
            : "",
        };
      })();
    },
  };
}
export type DailyService = ReturnType<typeof createDailyService>;
