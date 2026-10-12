import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { loadConfig } from "../apps/server/src/config";

try {
  const config = loadConfig();
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE search_probe USING fts5(content)");
  db.close();
  console.info(`Project Valerie • Bun ${Bun.version}`);
  console.info(`Local server: ${config.host}:${config.port} • ${config.timezone}`);
  console.info("SQLite and FTS5: ready");
  console.info(
    "Dashboard access: private, no separate login; remote access through SSH or restricted Tailscale Serve",
  );
  console.info(
    `Dashboard build: ${existsSync("apps/dashboard/dist/index.html") ? "ready" : "run bun run build"}`,
  );
  for (const [name, keys] of [
    ["Neuralwatt", ["NEURALWATT_API_KEY"]],
    ["Telegram", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"]],
    ["ElevenLabs", ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"]],
    ["ComfyUI", ["COMFYUI_BASE_URL", "COMFYUI_WORKFLOW_DIR"]],
  ] as const) {
    console.info(
      `${name}: ${keys.every((key) => Boolean(process.env[key])) ? "credentials present" : "not fully configured"}; connection not tested`,
    );
  }
  console.info(
    `Telegram lifecycle: ${process.env.VALERIE_TELEGRAM_ENABLED === "1" ? "enabled at process startup" : "disabled"}. Model and history settings are stored in SQLite; inspect Conversation for actual status.`,
  );
  console.info(
    "No external requests or messages were sent. Memory storage and tools are implemented; vault indexing is checked by the running service. Reminders remain unavailable.",
  );
} catch {
  console.error(
    "Local readiness failed. Check loopback host, port, origin, timezone settings and SQLite support. Remove any obsolete VALERIE_ADMIN_TOKEN setting.",
  );
  process.exitCode = 1;
}
