import { createHeartbeatService, type HeartbeatRun, type Store } from "@valerie/core";
import { createHeartbeatGenerator } from "./generation";

export interface HeartbeatRuntimeStatus {
  state: "starting" | "waiting" | "generating" | "stopped" | "failed";
  lastError: string | null;
  lastTickAt: string | null;
}

export interface HeartbeatBinding {
  service: ReturnType<typeof createHeartbeatService>;
  capture(run: HeartbeatRun): ReturnType<ReturnType<typeof createHeartbeatGenerator>["capture"]>;
  generate: ReturnType<typeof createHeartbeatGenerator>["generate"];
}

/** Scheduling is driven by the existing Telegram lifecycle and polling lease. */
export function createHeartbeatRuntime(store: Store, apiKey: string): HeartbeatBinding {
  const service = createHeartbeatService(store);
  const generator = createHeartbeatGenerator({ store, apiKey });
  return {
    service,
    capture: (run) =>
      generator.capture({
        chatId: run.chatId,
        timeZone: run.settings.timezone,
        maxMessageChars: run.settings.maxMessageChars,
        recentHeartbeats: service.confirmedHistory({
          chatId: run.chatId,
          since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
          limit: 12,
        }),
      }),
    generate: generator.generate,
  };
}
