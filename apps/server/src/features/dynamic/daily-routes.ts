import {
  createDailyService,
  type DailyEventEdit,
  type ProgressReportInput,
  resolveDailyLocalTime,
  type Store,
  type WakingReportInput,
} from "@valerie/core";
import type { Context, Hono } from "hono";
import { readJsonObject, routeHandler } from "../../http";
import { dynamicErrorResponse } from "./routes";

const body = (c: Context) =>
  readJsonObject(c, {
    contentType: "Send daily records as JSON.",
    shape: "Provide a daily record object.",
  });

function offsetLabel(minutes: number): string {
  const amount = Math.abs(minutes);
  return `UTC${minutes >= 0 ? "+" : "-"}${String(Math.floor(amount / 60)).padStart(2, "0")}:${String(amount % 60).padStart(2, "0")}`;
}

/** Owner-only routes inherit the dashboard's existing host/origin and no-store boundary. */
export function mountDailyRoutes(app: Hono, store: Store) {
  const daily = createDailyService(store);
  const handle = routeHandler(dynamicErrorResponse);
  const owner = { actor: "owner" as const };
  app.get(
    "/api/dynamic/daily",
    handle((c) => c.json(daily.overview({ limit: Number(c.req.query("limit") ?? 20) }))),
  );
  app.put(
    "/api/dynamic/daily/settings",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        settings: daily.saveSettings({
          expectedVersion: input.expectedVersion as number,
          allowValerieManageWaking: input.allowValerieManageWaking as boolean,
          allowValerieManageProgress: input.allowValerieManageProgress as boolean,
        }),
      });
    }),
  );
  app.post(
    "/api/dynamic/daily/resolve-time",
    handle(async (c) => {
      const input = await body(c);
      const timezone = input.timezone as string;
      if (typeof timezone !== "string" || timezone.length > 100)
        throw new TypeError("Provide an IANA timezone.");
      if (input.mode === "now") {
        let format: Intl.DateTimeFormat;
        try {
          format = new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          });
        } catch {
          throw new TypeError("Provide a valid IANA timezone.");
        }
        const now = new Date();
        const parts = format.formatToParts(now);
        const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
        const localDateTime = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
        const offsetMinutes =
          (Date.parse(`${localDateTime}:00Z`) - Math.floor(now.getTime() / 60000) * 60000) / 60000;
        return c.json({
          at: now.toISOString(),
          timezone,
          localDateTime,
          offset: offsetLabel(offsetMinutes),
          adjustment: "none",
          occurrence: "first",
        });
      }
      if (input.mode !== "local") throw new TypeError("Choose now or local time.");
      const resolved = resolveDailyLocalTime(
        input.localDateTime as string,
        timezone,
        input.occurrence as "first" | "second" | undefined,
      );
      return c.json({
        at: resolved.at,
        timezone: resolved.timezone,
        localDateTime: resolved.localDateTime,
        offset: offsetLabel(resolved.offsetMinutes),
        adjustment:
          resolved.adjustment === "repeated"
            ? resolved.occurrence === "second"
              ? "overlap_second"
              : "overlap_first"
            : resolved.adjustment,
        occurrence: resolved.occurrence,
      });
    }),
  );
  const saveBehavior = handle(async (c) => {
    const input = await body(c);
    const id = c.req.param("id");
    return c.json({
      behavior: daily.saveBehavior(
        {
          name: input.name as string,
          unit: input.unit as string,
          valueKind: input.valueKind as "count" | "status",
          ...(id ? { id, expectedVersion: input.expectedVersion as number } : {}),
          ...(input.state === undefined ? {} : { state: input.state as "active" | "archived" }),
          ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
        },
        owner,
      ),
    });
  });
  app.post("/api/dynamic/daily/behaviors", saveBehavior);
  app.put("/api/dynamic/daily/behaviors/:id", saveBehavior);
  app.post(
    "/api/dynamic/daily/waking",
    handle(async (c) => {
      const input = await body(c);
      return c.json(
        daily.recordWakingReport(
          {
            report: input.report as WakingReportInput["report"],
            mode: input.mode as WakingReportInput["mode"],
            expectedCurrentDayId: input.expectedCurrentDayId as string | null,
            expectedDayVersion: input.expectedDayVersion as number | null,
            occurred: input.occurred as WakingReportInput["occurred"],
            summary: input.summary as string,
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
            ...(input.wakingDayId === undefined
              ? {}
              : { wakingDayId: input.wakingDayId as string | null }),
            ...(input.evidenceQuote === undefined
              ? {}
              : { evidenceQuote: input.evidenceQuote as string }),
            ...(input.newMainPeriod === undefined
              ? {}
              : { newMainPeriod: input.newMainPeriod as boolean }),
            ...(input.expectedSleepAt === undefined
              ? {}
              : { expectedSleepAt: input.expectedSleepAt as string | null }),
            ...(input.sleepEstimateBasis === undefined
              ? {}
              : {
                  sleepEstimateBasis:
                    input.sleepEstimateBasis as WakingReportInput["sleepEstimateBasis"],
                }),
          },
          owner,
        ),
      );
    }),
  );
  app.post(
    "/api/dynamic/daily/progress",
    handle(async (c) => {
      const input = await body(c);
      if (
        input.evidenceKind !== undefined &&
        input.evidenceKind !== "owner_report" &&
        input.evidenceKind !== "valerie_interpretation"
      )
        throw new TypeError(
          "Owner entries can contain reports or labelled interpretations, not integration observations.",
        );
      return c.json(
        daily.recordProgressReport(
          {
            behaviorId: input.behaviorId as string,
            wakingDayId: input.wakingDayId as string | null,
            occurred: input.occurred as ProgressReportInput["occurred"],
            summary: input.summary as string,
            mode: input.mode as ProgressReportInput["mode"],
            ...(input.value === undefined ? {} : { value: input.value as number }),
            ...(input.status === undefined
              ? {}
              : { status: input.status as ProgressReportInput["status"] }),
            ...(input.totalThroughAt === undefined
              ? {}
              : { totalThroughAt: input.totalThroughAt as string }),
            ...(input.plannedFor === undefined ? {} : { plannedFor: input.plannedFor as string }),
            ...(input.sameEventId === undefined
              ? {}
              : {
                  sameEventId: input.sameEventId as string,
                  expectedEventVersion: input.expectedEventVersion as number,
                }),
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
            ...(input.evidenceKind === undefined
              ? {}
              : { evidenceKind: input.evidenceKind as ProgressReportInput["evidenceKind"] }),
          },
          owner,
        ),
      );
    }),
  );
  app.get(
    "/api/dynamic/daily/events",
    handle((c) =>
      c.json(
        daily.listEvents({
          ...(c.req.query("dayId") === undefined
            ? {}
            : { dayId: c.req.query("dayId") === "unassigned" ? null : c.req.query("dayId") }),
          behaviorId: c.req.query("behaviorId"),
          cursor: c.req.query("cursor"),
          limit: Number(c.req.query("limit") ?? 20),
        }),
      ),
    ),
  );
  app.get(
    "/api/dynamic/daily/events/:id",
    handle((c) => {
      const revision = c.req.query("revision");
      const event = daily.readEvent(
        c.req.param("id") ?? "",
        revision === undefined ? {} : { revision: Number(revision) },
      );
      return event ? c.json({ event }) : c.json({ error: "Daily event not found." }, 404);
    }),
  );
  app.put(
    "/api/dynamic/daily/events/:id",
    handle(async (c) => {
      const input = await body(c);
      return c.json(
        daily.reviseEvent(
          {
            id: c.req.param("id") ?? "",
            expectedVersion: input.expectedVersion as number,
            ...(input.summary === undefined ? {} : { summary: input.summary as string }),
            ...(input.occurred === undefined
              ? {}
              : { occurred: input.occurred as DailyEventEdit["occurred"] }),
            ...(input.wakingDayId === undefined
              ? {}
              : { wakingDayId: input.wakingDayId as string | null }),
            ...(input.progress === undefined
              ? {}
              : { progress: input.progress as DailyEventEdit["progress"] }),
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      );
    }),
  );
  app.post(
    "/api/dynamic/daily/events/:id/void",
    handle(async (c) => {
      const input = await body(c);
      return c.json(
        daily.voidEvent(
          {
            id: c.req.param("id") ?? "",
            expectedVersion: input.expectedVersion as number,
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      );
    }),
  );
  app.post(
    "/api/dynamic/daily/days/merge",
    handle(async (c) => {
      const input = await body(c);
      return c.json(
        daily.mergeDays(
          {
            fromId: input.fromId as string,
            expectedFromVersion: input.expectedFromVersion as number,
            intoId: input.intoId as string,
            expectedIntoVersion: input.expectedIntoVersion as number,
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      );
    }),
  );
}
