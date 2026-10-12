import {
  createReminderService,
  ReminderConflictError,
  type ReminderSaveInput,
  type Store,
} from "@valerie/core";
import type { Context, Hono } from "hono";
import { readJsonObject, routeHandler } from "../../http";
import type { TelegramStatus } from "../conversation/routes";
import { dynamicErrorResponse } from "../dynamic/routes";

const body = (c: Context) =>
  readJsonObject(c, {
    contentType: "Send reminder edits as JSON.",
    shape: "Provide a reminder edit object.",
  });

export function mountReminderRoutes(
  app: Hono,
  store: Store,
  telegramStatus?: () => TelegramStatus,
) {
  const reminders = createReminderService(store),
    owner = { actor: "owner" as const };
  const handle = routeHandler((error, c) =>
    error instanceof ReminderConflictError
      ? c.json({ error: error.message }, 409)
      : dynamicErrorResponse(error, c),
  );
  app.get(
    "/api/reminders",
    handle((c) =>
      c.json({
        ...reminders.overview(),
        worker: telegramStatus?.().scheduled ?? {
          state: "disabled",
          lastTickAt: null,
          lastError: null,
        },
      }),
    ),
  );
  app.put(
    "/api/reminders/permissions",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        settings: reminders.savePermissions({
          expectedVersion: input.expectedVersion as number,
          allowValerieManageReminders: input.allowValerieManageReminders as boolean,
        }),
      });
    }),
  );
  app.put(
    "/api/reminders/checkin-settings",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        settings: reminders.saveCheckinSettings({
          expectedVersion: input.expectedVersion as number,
          enabled: input.enabled as boolean,
          morningDelayMinutes: input.morningDelayMinutes as number,
          eveningLeadMinutes: input.eveningLeadMinutes as number,
          minIdleMinutes: input.minIdleMinutes as number,
          maxMessageChars: input.maxMessageChars as number,
        }),
      });
    }),
  );
  app.get(
    "/api/reminders/occurrences",
    handle((c) =>
      c.json({
        occurrences: reminders.listOccurrences({
          limit: Number(c.req.query("limit") ?? 20),
          reminderId: c.req.query("reminderId"),
        }),
      }),
    ),
  );
  app.get(
    "/api/reminders/occurrences/:id",
    handle((c) => {
      const occurrence = reminders.readOccurrence(c.req.param("id") ?? "");
      return occurrence
        ? c.json({ occurrence })
        : c.json({ error: "Reminder occurrence not found." }, 404);
    }),
  );
  app.get(
    "/api/reminders/:id",
    handle((c) => {
      const reminder = reminders.read(c.req.param("id") ?? "");
      return reminder ? c.json({ reminder }) : c.json({ error: "Reminder not found." }, 404);
    }),
  );
  const save = handle(async (c) => {
    const input = await body(c),
      id = c.req.param("id");
    return c.json({
      reminder: reminders.saveReminder(
        {
          title: input.title as string,
          purpose: input.purpose as string,
          dueAt: input.dueAt as string,
          timezone: input.timezone as string,
          originalTimeIntent: input.originalTimeIntent as string,
          expiresAt: input.expiresAt as string | null,
          allowFallback: input.allowFallback as boolean,
          ...(id ? { id, expectedVersion: input.expectedVersion as number } : {}),
          ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
        } as ReminderSaveInput,
        owner,
      ),
    });
  });
  app.post("/api/reminders", save);
  app.put("/api/reminders/:id", save);
  app.post(
    "/api/reminders/:id/snooze",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        reminder: reminders.snooze(
          {
            id: c.req.param("id") ?? "",
            expectedVersion: input.expectedVersion as number,
            occurrenceId: input.occurrenceId as string,
            dueAt: input.dueAt as string,
            originalTimeIntent: input.originalTimeIntent as string,
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      });
    }),
  );
  app.post(
    "/api/reminders/:id/complete",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        reminder: reminders.complete(
          {
            id: c.req.param("id") ?? "",
            expectedVersion: input.expectedVersion as number,
            occurrenceId: input.occurrenceId as string,
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      });
    }),
  );
  app.post(
    "/api/reminders/:id/cancel",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        reminder: reminders.cancel(
          {
            id: c.req.param("id") ?? "",
            expectedVersion: input.expectedVersion as number,
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      });
    }),
  );
  app.post(
    "/api/reminders/:id/retry-failed",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        reminder: reminders.retryFailed(
          {
            id: c.req.param("id") ?? "",
            expectedVersion: input.expectedVersion as number,
            occurrenceId: input.occurrenceId as string,
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      });
    }),
  );
}
