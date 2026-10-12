import {
  createHeartbeatService,
  HeartbeatSettingsConflictError,
  type HeartbeatSettingsInput,
  type Store,
} from "@valerie/core";
import type { Context, Hono } from "hono";
import { routeHandler } from "../../http";
import type { HeartbeatRuntimeStatus } from "./runtime";

export type { HeartbeatRuntimeStatus };

const publicReasons = new Set([
  "disabled",
  "paused",
  "no_owner_chat",
  "no_owner_input",
  "quiet_hours",
  "conversation_pending",
  "recent_conversation",
  "minimum_interval",
  "daily_limit",
  "unanswered_limit",
  "active_run",
  "settings_changed",
  "owner_input_changed",
  "unknown_delivery",
  "telegram_unavailable",
  "lease_lost",
  "expired",
  "stale",
  "missed_opportunity",
  "opportunity_expired",
  "interrupted_delivery",
  "interrupted_generation",
]);

async function body(c: Context) {
  if (!c.req.header("Content-Type")?.startsWith("application/json"))
    return { response: c.json({ error: "Send heartbeat settings as JSON." }, 415) };
  const value: unknown = await c.req.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Provide heartbeat settings and the current settings version.");
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1)
    throw new TypeError("Provide the current heartbeat settings version.");
  return { input };
}

/** Inherits the private dashboard's host, origin, body-size, and no-store protections. */
export function mountHeartbeatRoutes(
  app: Hono,
  store: Store,
  env: Record<string, string | undefined>,
  runtimeStatus?: () => HeartbeatRuntimeStatus,
) {
  const heartbeats = createHeartbeatService(store);
  const chatId = env.TELEGRAM_ALLOWED_USER_ID?.trim() || null;
  const response = () => {
    const runtime = runtimeStatus?.() ?? {
      state: "stopped" as const,
      lastError: null,
      lastTickAt: null,
    };
    return {
      settings: heartbeats.getSettings(),
      status: heartbeats.getStatus(chatId),
      runtime: {
        state: runtime.state,
        lastError: runtime.lastError ? "heartbeat_unavailable" : null,
        lastTickAt: runtime.lastTickAt,
      },
      recentRuns: heartbeats.recentRuns(20).map((run) => ({
        id: run.id,
        status: run.status,
        reason: run.reason && publicReasons.has(run.reason) ? run.reason : null,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        deliveredAt: run.deliveredAt,
      })),
    };
  };
  const handle = routeHandler((error, c) =>
    error instanceof HeartbeatSettingsConflictError
      ? c.json(
          {
            error:
              "Heartbeat settings changed elsewhere. Load the saved settings before saving again. Your draft is still here.",
          },
          409,
        )
      : undefined,
  );
  app.get(
    "/api/heartbeat",
    handle((c) => c.json(response())),
  );
  app.put(
    "/api/heartbeat/settings",
    handle(async (c) => {
      const parsed = await body(c);
      if (parsed.response) return parsed.response;
      const { input } = parsed;
      if (
        typeof input.enabled !== "boolean" ||
        ["timezone", "activeStart", "activeEnd"].some((key) => typeof input[key] !== "string") ||
        [
          "minIntervalMinutes",
          "maxIntervalMinutes",
          "minIdleMinutes",
          "maxPerDay",
          "maxUnanswered",
          "maxMessageChars",
        ].some((key) => !Number.isSafeInteger(input[key]))
      )
        throw new TypeError(
          "Provide heartbeat hours, timezone, numeric limits, and whether heartbeats are enabled.",
        );
      const current = heartbeats.getSettings();
      heartbeats.saveSettings({
        expectedVersion: input.expectedVersion as number,
        enabled: input.enabled,
        timezone: input.timezone as string,
        activeStart: input.activeStart as string,
        activeEnd: input.activeEnd as string,
        minIntervalMinutes: input.minIntervalMinutes as number,
        maxIntervalMinutes: input.maxIntervalMinutes as number,
        minIdleMinutes: input.minIdleMinutes as number,
        maxPerDay: input.maxPerDay as number,
        maxUnanswered: input.maxUnanswered as number,
        maxMessageChars: input.maxMessageChars as number,
        paused: current.paused,
        pausedUntil: current.pausedUntil,
      } satisfies HeartbeatSettingsInput);
      return c.json(response());
    }),
  );
  app.post(
    "/api/heartbeat/pause",
    handle(async (c) => {
      const parsed = await body(c);
      if (parsed.response) return parsed.response;
      const { input } = parsed;
      if (input.pausedUntil !== null && typeof input.pausedUntil !== "string")
        throw new TypeError("Provide a pause end time, or null to pause until resumed.");
      heartbeats.pause({
        expectedVersion: input.expectedVersion as number,
        pausedUntil: input.pausedUntil,
      });
      return c.json(response());
    }),
  );
  app.post(
    "/api/heartbeat/resume",
    handle(async (c) => {
      const parsed = await body(c);
      if (parsed.response) return parsed.response;
      heartbeats.resume({ expectedVersion: parsed.input.expectedVersion as number });
      return c.json(response());
    }),
  );
}
