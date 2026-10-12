import {
  type ContextHealthReport,
  createContextHealthService,
  createContextNoticeService,
  type Store,
} from "@valerie/core";
import type { Context, Hono } from "hono";

/** Inherits the owner dashboard's host/origin boundary and no-store headers. */
export function mountContextHealthRoutes(
  app: Hono,
  store: Store,
  options: { notificationDelivery?: () => ContextHealthReport["notificationDelivery"] } = {},
) {
  const health = createContextHealthService(store);
  const notices = createContextNoticeService(store);
  app.post("/api/context-health/notices/:id/retry", async (c) => {
    if (!c.req.header("Content-Type")?.startsWith("application/json"))
      return c.json({ error: "Send the current warning attempt count as JSON." }, 415);
    const body: unknown = await c.req.json();
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("expectedAttempts" in body) ||
      !Number.isSafeInteger(body.expectedAttempts) ||
      Number(body.expectedAttempts) < 1 ||
      !/^[a-z0-9_.:/-]{1,200}$/i.test(c.req.param("id"))
    )
      return c.json({ error: "Provide the warning reference and its current attempt count." }, 400);
    return notices.retryFailed(c.req.param("id"), Number(body.expectedAttempts))
      ? c.json({ queued: true })
      : c.json(
          {
            error:
              "Only a failed warning for an ongoing condition can be retried. Refresh its status.",
          },
          409,
        );
  });
  const report = (c: Context) => {
    const raw = c.req.query("limit");
    if (raw !== undefined && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(raw))
      return c.json({ error: "Choose between 1 and 50 context records." }, 400);
    return c.json(
      health.report({
        limit: raw === undefined ? undefined : Number(raw),
        notificationDelivery: options.notificationDelivery?.(),
      }),
    );
  };
  app.get("/api/context-health", report);
  app.get("/api/context-health/export", (c) => {
    c.header("Content-Disposition", 'attachment; filename="valerie-context-health.json"');
    return report(c);
  });
  app.get("/api/context-health/:kind/:id", (c) => {
    const kind = c.req.param("kind");
    const id = c.req.param("id");
    if ((kind !== "conversation" && kind !== "heartbeat") || !/^[a-z0-9_.:/-]{1,200}$/i.test(id))
      return c.json({ error: "Provide a conversation or heartbeat reference." }, 400);
    const source = health.getSource(kind, id);
    return source ? c.json({ source }) : c.json({ error: "Context record not found." }, 404);
  });
}
