import { resolve } from "node:path";
import { createActivityService, openStore } from "@valerie/core";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { mountDashboard } from "./dashboard";
import { createConversationGenerator } from "./features/conversation/inference";
import type { TelegramStatus } from "./features/conversation/routes";
import { createHeartbeatRuntime } from "./features/heartbeat/runtime";
import { createImageFailureGenerator } from "./features/image-generation/notice";
import { createImageRuntime } from "./features/image-generation/runtime";
import { startMemoryRuntime } from "./features/memory/runtime";
import { createScheduledRuntime } from "./features/reminders/runtime";
import { startTelegramWorker } from "./features/telegram/worker";
import { MAX_ADMIN_BODY_BYTES } from "./limits";
import { activateRuntime, type RuntimeSlot } from "./runtime";

// This global survives Bun --hot. Do not move live resources to module scope.
// Bump for any schema/lifecycle/listener-contract edit: it blocks soft activation
// until a controlled restart opens/migrates the store and creates fresh resources.
const RUNTIME_CONTRACT = "flex-streaming-v1-sqlite-021";
const globalRuntime = globalThis as typeof globalThis & { __valerieRuntime?: RuntimeSlot };
globalRuntime.__valerieRuntime ??= {};
const slot = globalRuntime.__valerieRuntime;
process.umask(0o077);

try {
  const config = loadConfig();
  const runtime = activateRuntime(
    slot,
    config,
    RUNTIME_CONTRACT,
    (store, diagnostics) => {
      const app = createApp(
        store,
        config,
        process.env,
        diagnostics,
        () =>
          (slot.current?.background?.status() as TelegramStatus | undefined) ?? {
            state: "disabled",
            lastError: null,
            lastUpdateAt: null,
          },
      );
      mountDashboard(app, resolve(import.meta.dir, "../../dashboard/dist"));
      return app.fetch;
    },
    {
      openStore,
      listen: (currentConfig, fetch) =>
        Bun.serve({
          hostname: currentConfig.host,
          port: currentConfig.port,
          fetch,
          maxRequestBodySize: MAX_ADMIN_BODY_BYTES,
        }),
      onSignal: (signal, handler) => process.on(signal, handler),
      offSignal: (signal, handler) => process.off(signal, handler),
      recordStarted: (store) =>
        createActivityService(store).append({
          kind: "service.started",
          summary: "Valerie’s dashboard and conversation storage are ready.",
          status: "succeeded",
        }),
      now: () => new Date().toISOString(),
      instanceId: () => crypto.randomUUID(),
      startBackground: (store) =>
        startMemoryRuntime({
          store,
          vaultRoot: process.env.VALERIE_VAULT_DIR?.trim(),
          startConversation: () => {
            if (process.env.VALERIE_TELEGRAM_ENABLED !== "1")
              return {
                status: () => ({ state: "disabled", lastError: null, lastUpdateAt: null }),
                stop: async () => {},
              };
            const apiKey = process.env.NEURALWATT_API_KEY;
            if (!apiKey)
              throw new Error("Neuralwatt credential is required for Telegram conversations.");
            const images = createImageRuntime(store, process.env);
            return startTelegramWorker({
              store,
              token: process.env.TELEGRAM_BOT_TOKEN ?? "",
              ownerUserId: process.env.TELEGRAM_ALLOWED_USER_ID ?? "",
              generate: createConversationGenerator({
                store,
                apiKey,
                imageGeneration: images?.binding,
              }),
              images,
              heartbeats: createHeartbeatRuntime(store, apiKey),
              reminders: createScheduledRuntime(store, apiKey),
              memoryTools: true,
              dynamicTools: true,
              dailyTools: true,
              agreementTools: true,
              reminderTools: true,
              contextNotices: true,
              generateImageFailure: images
                ? createImageFailureGenerator({ store, apiKey })
                : undefined,
            });
          },
        }),
      onShutdownComplete: () => process.exit(0),
    },
  );
  console.info(
    `Project Valerie: http://${config.host}:${config.port}; handler generation ${runtime.diagnostics.generation}`,
  );
} catch {
  // Configuration/provider failures can contain private values. Keep them out of logs.
  console.error(
    slot.current
      ? "Valerie could not apply the code update. The previous handler is still active. Check the edit and restart for schema or runtime configuration changes."
      : "Valerie could not start. Check configuration, database access and whether the port is already in use.",
  );
  if (!slot.current) process.exitCode = 1;
}
