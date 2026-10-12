import {
  createMessageEditService,
  MessageEditConflictError,
  MessageEditNotFoundError,
  type Store,
} from "@valerie/core";
import type { Context, Hono } from "hono";
import { routeHandler } from "../../http";

export function mountMessageEditRoutes(app: Hono, store: Store, ownerChatId: string) {
  const edits = createMessageEditService(store);
  const route = routeHandler((error, c) => {
    if (error instanceof MessageEditNotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof MessageEditConflictError) return c.json({ error: error.message }, 409);
    return undefined;
  });
  const handle = (action: (c: Context) => Response | Promise<Response>) =>
    route((c) =>
      /^[1-9]\d*$/.test(ownerChatId)
        ? action(c)
        : c.json({ error: "Configure the Telegram owner before editing messages." }, 503),
    );
  app.get(
    "/api/conversation/turns/:id/messages",
    handle((c) => c.json({ messages: edits.messages(c.req.param("id") ?? "", ownerChatId) })),
  );
  app.get(
    "/api/conversation/messages/:id/revisions",
    handle((c) =>
      c.json({
        revisions: edits.history(
          c.req.param("id") ?? "",
          ownerChatId,
          c.req.query("before") === undefined ? undefined : Number(c.req.query("before")),
        ),
      }),
    ),
  );
  app.post(
    "/api/conversation/messages/:id/edits",
    handle(async (c) => {
      if (!c.req.header("Content-Type")?.startsWith("application/json"))
        return c.json({ error: "Send edits as JSON." }, 415);
      const input: unknown = await c.req.json();
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new TypeError("Provide a message edit.");
      const value = input as Record<string, unknown>;
      return c.json(
        {
          edit: edits.queue(
            {
              id: value.id as string,
              deliveryId: c.req.param("id") ?? "",
              expectedVersion: value.expectedVersion as number,
              text: value.text as string,
            },
            ownerChatId,
          ),
        },
        202,
      );
    }),
  );
  app.post(
    "/api/conversation/edits/:id/retry",
    handle((c) => c.json({ edit: edits.retry(c.req.param("id") ?? "", ownerChatId) }, 202)),
  );
}
