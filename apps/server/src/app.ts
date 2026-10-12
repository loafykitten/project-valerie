import { hostname as systemHostname } from "node:os";
import {
  createActivityService,
  createCharacterService,
  createConversationService,
  createDynamicService,
  createPromptService,
  MAX_PROMPT_BYTES,
  PromptConflictError,
  PromptNotFoundError,
  PromptOrderConflictError,
  PromptOrderValidationError,
  type Store,
} from "@valerie/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "./config";
import { mountContextHealthRoutes } from "./features/context-health/routes";
import { mountMessageEditRoutes } from "./features/conversation/edit-routes";
import { mountConversationRoutes, type TelegramStatus } from "./features/conversation/routes";
import { mountAgreementRoutes } from "./features/dynamic/agreement-routes";
import { mountDailyRoutes } from "./features/dynamic/daily-routes";
import { mountDynamicRoutes } from "./features/dynamic/routes";
import { mountHeartbeatRoutes } from "./features/heartbeat/routes";
import { mountMemoryRoutes } from "./features/memory/routes";
import { mountReminderRoutes } from "./features/reminders/routes";
import { MAX_ADMIN_BODY_BYTES } from "./limits";
import type { RuntimeDiagnostics } from "./runtime";

const channels = ["telegram-text", "telegram-voice", "desktop-voice"] as const;

export function createApp(
  store: Store,
  config: ServerConfig,
  env: Record<string, string | undefined> = process.env,
  diagnostics?: RuntimeDiagnostics,
  telegramStatus?: () => TelegramStatus,
) {
  const app = new Hono();
  const prompts = createPromptService(store);
  const characters = createCharacterService(store);
  const activity = createActivityService(store);
  const conversations = createConversationService(store);
  const hostname = config.host.includes(":") ? `[${config.host}]` : config.host;
  const origins = new Set([
    `http://${hostname}:${config.port}`,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    ...config.origins,
  ]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!hosts.has(new URL(c.req.url).host)) return c.json({ error: "Unexpected host." }, 403);
    const origin = c.req.header("Origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Unexpected origin." }, 403);
    if (c.req.header("Sec-Fetch-Site") === "cross-site")
      return c.json({ error: "Cross-site access is not allowed." }, 403);
    await next();
  });
  app.get("/healthz", (c) => {
    store.db.query("SELECT 1").get();
    return c.json({ ok: true, service: "Project Valerie", mode: "conversation" });
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_ADMIN_BODY_BYTES,
      onError: (c) => c.json({ error: "Request is too large." }, 413),
    }),
  );

  app.get("/api/status", (c) =>
    c.json({
      service: "Project Valerie",
      mode: "conversation",
      runtime: { hostname: config.hostLabel ?? systemHostname(), ...diagnostics },
      characterImported: characters.getActive() !== null,
      timezone: config.timezone,
      integrations: [
        {
          name: "Neuralwatt",
          configured: Boolean(env.NEURALWATT_API_KEY && conversations.getSettings().model),
          implemented: true,
        },
        {
          name: "Telegram",
          configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_ID),
          implemented: true,
          state: telegramStatus?.().state ?? "disabled",
        },
        {
          name: "ElevenLabs",
          configured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID),
          implemented: false,
        },
        {
          name: "ComfyUI",
          configured: Boolean(env.COMFYUI_BASE_URL?.trim() && env.COMFYUI_WORKFLOW_DIR?.trim()),
          implemented: true,
        },
      ],
    }),
  );
  app.get("/api/character", (c) => c.json({ character: characters.getActive() }));
  app.get("/api/prompts", (c) => c.json(prompts.catalog()));
  app.get("/api/prompts/preview", (c) => {
    const channel = c.req.query("channel") || "telegram-text";
    const selected = channels.find((candidate) => candidate === channel);
    if (!selected) return c.json({ error: "Unknown communication channel." }, 400);
    const tools = Boolean(conversations.getSettings().modelCapabilities?.tools);
    return c.json(
      prompts.compose(selected, {
        memoryTools: tools,
        growthFocus: tools || Boolean(createDynamicService(store).current()),
        dailyRecords: tools,
        agreements: tools,
        imageGeneration: Boolean(
          env.COMFYUI_BASE_URL?.trim() && env.COMFYUI_WORKFLOW_DIR?.trim() && tools,
        ),
      }),
    );
  });
  app.get("/api/prompts/:id/history", (c) => {
    if (!prompts.get(c.req.param("id"))) return c.json({ error: "Prompt not found." }, 404);
    return c.json({ revisions: prompts.history(c.req.param("id")) });
  });
  app.put("/api/prompts/order", async (c) => {
    if (!c.req.header("Content-Type")?.startsWith("application/json"))
      return c.json({ error: "Send the prompt order as JSON." }, 415);
    const body: unknown = await c.req.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("ids" in body) ||
      !Array.isArray(body.ids) ||
      !body.ids.every((id): id is string => typeof id === "string") ||
      !("expectedOrderVersion" in body) ||
      typeof body.expectedOrderVersion !== "number"
    )
      return c.json({ error: "Provide the section IDs and current order version." }, 400);
    const { ids, expectedOrderVersion } = body;
    const result = store.db
      .transaction(() => {
        const saved = prompts.reorder({
          ids,
          expectedOrderVersion,
        });
        if (saved.orderVersion !== expectedOrderVersion)
          activity.append({
            kind: "prompt.reordered",
            summary: "Saved prompt section order.",
            status: "succeeded",
            metadata: { orderVersion: saved.orderVersion },
          });
        return saved;
      })
      .immediate();
    return c.json(result);
  });
  app.put("/api/prompts/:id", async (c) => {
    if (!c.req.header("Content-Type")?.startsWith("application/json")) {
      return c.json({ error: "Send a JSON prompt revision." }, 415);
    }
    const body: unknown = await c.req.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("content" in body) ||
      typeof body.content !== "string" ||
      !("expectedVersion" in body) ||
      typeof body.expectedVersion !== "number" ||
      !Number.isSafeInteger(body.expectedVersion) ||
      body.expectedVersion < 1
    ) {
      return c.json({ error: "Provide prompt content and its current version." }, 400);
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_PROMPT_BYTES) {
      return c.json({ error: "This prompt is too large. Keep its text under 256 KiB." }, 413);
    }
    const { content, expectedVersion } = body;
    const prompt = store.db
      .transaction(() => {
        const saved = prompts.update(c.req.param("id"), { content, expectedVersion });
        activity.append({
          kind: "prompt.saved",
          summary: `Saved ${saved.title}, version ${saved.version}.`,
          status: "succeeded",
          metadata: { promptId: saved.id, version: saved.version },
        });
        return saved;
      })
      .immediate();
    return c.json({ prompt });
  });
  app.get("/api/activity", (c) => {
    const query = c.req.query("q") || "";
    if (query.length > 200) return c.json({ error: "Search is too long." }, 400);
    return c.json({ events: activity.list({ query }), outstanding: activity.outstanding() });
  });
  mountConversationRoutes(app, store, env, telegramStatus);
  mountMessageEditRoutes(app, store, env.TELEGRAM_ALLOWED_USER_ID ?? "");
  mountMemoryRoutes(app, store);
  mountDynamicRoutes(app, store);
  mountDailyRoutes(app, store);
  mountAgreementRoutes(app, store);
  mountReminderRoutes(app, store, telegramStatus);
  mountContextHealthRoutes(app, store, {
    notificationDelivery: () =>
      telegramStatus && telegramStatus().state !== "disabled" ? "enabled" : "disabled",
  });
  mountHeartbeatRoutes(
    app,
    store,
    env,
    () =>
      telegramStatus?.().heartbeat ?? {
        state: "stopped",
        lastError: null,
        lastTickAt: null,
      },
  );
  app.all("/api/*", (c) => c.json({ error: "API route not found." }, 404));
  app.onError((error, c) => {
    if (error instanceof PromptOrderConflictError)
      return c.json(
        { error: "The prompt order or available sections changed. Reload before reordering." },
        409,
      );
    if (error instanceof PromptOrderValidationError) return c.json({ error: error.message }, 400);
    if (error instanceof PromptConflictError) {
      return c.json(
        { error: "This prompt changed elsewhere. Reload it before saving again." },
        409,
      );
    }
    if (error instanceof PromptNotFoundError) return c.json({ error: "Prompt not found." }, 404);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON." }, 400);
    console.error(
      JSON.stringify({ kind: "http.error", summary: "A request could not be completed." }),
    );
    return c.json(
      { error: "The request could not be completed. Check service health and retry." },
      500,
    );
  });
  return app;
}
