import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));
const dashboardOrigin = process.env.VALERIE_DASHBOARD_ORIGIN;
if (dashboardOrigin && dashboardOrigin !== "https://valerie.loafykitten.cafe") {
  throw new Error("The remote dashboard origin must be https://valerie.loafykitten.cafe.");
}

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Dashboard and API ports must be integers between 1 and 65535.");
  }
  return parsed;
}

const dashboardPort = port(process.env.VALERIE_DASHBOARD_PORT, 5173);
const apiPort = port(process.env.VALERIE_API_PORT, 3100);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const cacheDir = process.env.VALERIE_VITE_CACHE ?? resolve(dashboardRoot, "node_modules/.vite");

export default defineConfig({
  root: dashboardRoot,
  cacheDir,
  // The frontend receives explicit runtime settings, never the API's .env file.
  envDir: false,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: dashboardPort,
    strictPort: true,
    allowedHosts: ["valerie.loafykitten.cafe"],
    origin: dashboardOrigin,
    cors: {
      origin: dashboardOrigin ?? [
        `http://127.0.0.1:${dashboardPort}`,
        `http://localhost:${dashboardPort}`,
      ],
    },
    // Caddy forwards HTTPS and the HMR WebSocket to the same loopback listener.
    ws: dashboardOrigin
      ? { protocol: "wss", host: "valerie.loafykitten.cafe", clientPort: 443 }
      : undefined,
    proxy: {
      "^/api(?:/|$)": { target: apiOrigin, changeOrigin: true },
      "^/healthz(?:\\?|$)": { target: apiOrigin, changeOrigin: true },
    },
    forwardConsole: false,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
    fs: {
      strict: true,
      // Bun workspace dependencies resolve into .bun; do not expose the repo root.
      allow: [dashboardRoot, resolve(dashboardRoot, "../../node_modules/.bun"), cacheDir],
      deny: [
        "**/.env",
        "**/.env.*",
        "**/.npmrc",
        "**/.yarnrc.yml",
        "**/.git/**",
        "**/*.{crt,pem,key,p12,pfx,cer,der}",
        "**/{private,state,data,backups,character-imports,snapshots}/**",
        "**/*.sqlite*",
        "**/*.db",
        "**/*.db-*",
        "**/*.log",
      ],
    },
  },
});
