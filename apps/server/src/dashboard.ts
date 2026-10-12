import { resolve } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/bun";

export function mountDashboard(app: Hono, root: string) {
  app.use("/*", async (c, next) => {
    await next();
    const fingerprinted = /^\/assets\/[^/]+-[\w-]{8,}\.[a-z0-9]+$/i.test(c.req.path);
    const html = c.res.headers.get("Content-Type")?.includes("text/html");
    c.header(
      "Cache-Control",
      c.res.status === 200 && fingerprinted && !html
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
  });
  app.use("/*", serveStatic({ root }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/assets/")) return c.text("Asset not found.", 404);
    const index = Bun.file(resolve(root, "index.html"));
    // Context responses retain the security headers prepared by middleware.
    if (await index.exists()) return c.html(await index.text());
    return c.text("Project Valerie API is ready. Build the dashboard or run bun dev.", 200);
  });
}
