import {
  createActivityService,
  createDynamicService,
  DynamicConflictError,
  DynamicPermissionError,
  type DynamicProgressNote,
  type GrowthFocusSaveInput,
  type GrowthFocusState,
  type Store,
} from "@valerie/core";
import type { Context, Hono } from "hono";
import { type RouteErrorResponse, readJsonObject, routeHandler } from "../../http";

/** Growth Focus, daily records, agreements and reminders share these owner-edit errors. */
export const dynamicErrorResponse: RouteErrorResponse = (error, c) => {
  if (error instanceof DynamicConflictError) return c.json({ error: error.message }, 409);
  if (error instanceof DynamicPermissionError) return c.json({ error: error.message }, 403);
  return undefined;
};

const body = (c: Context) =>
  readJsonObject(c, {
    contentType: "Send Dynamic Details edits as JSON.",
    shape: "Provide a Dynamic Details edit object.",
  });

/** These owner routes inherit the private host/origin, request-size and no-store boundary. */
export function mountDynamicRoutes(app: Hono, store: Store) {
  const dynamic = createDynamicService(store);
  const activity = createActivityService(store);
  const handle = routeHandler(dynamicErrorResponse);
  const changed = <T>(kind: string, action: () => T): T =>
    store.db
      .transaction(() => {
        const result = action();
        activity.append({
          kind: `dynamic.${kind}`,
          summary: `Dynamic Details ${kind}.`,
          status: "succeeded",
        });
        return result;
      })
      .immediate();

  app.get(
    "/api/dynamic",
    handle((c) =>
      c.json({
        settings: dynamic.getSettings(),
        current: dynamic.current(),
        history: dynamic.list({ limit: 20 }),
      }),
    ),
  );
  app.put(
    "/api/dynamic/settings",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        settings: changed("permissions_saved", () =>
          dynamic.saveSettings({
            expectedVersion: input.expectedVersion as number,
            allowValerieManageFocus: input.allowValerieManageFocus as boolean,
            allowValerieLogNotes: input.allowValerieLogNotes as boolean,
          }),
        ),
      });
    }),
  );
  app.get(
    "/api/dynamic/focus/:id",
    handle((c) => {
      const detail = dynamic.detail(c.req.param("id") ?? "");
      return detail ? c.json(detail) : c.json({ error: "Growth Focus not found." }, 404);
    }),
  );
  app.get(
    "/api/dynamic/focus/:id/revisions/:version",
    handle((c) => {
      const focus = dynamic.read(c.req.param("id") ?? "", {
        revision: Number(c.req.param("version")),
      });
      return focus ? c.json({ focus }) : c.json({ error: "Growth Focus revision not found." }, 404);
    }),
  );
  const save = handle(async (c) => {
    const input = await body(c);
    const id = c.req.param("id");
    const edit: GrowthFocusSaveInput = {
      title: input.title as string,
      reason: input.reason as string,
      startDate: input.startDate as string,
      reviewDate: input.reviewDate as string,
      practices: input.practices as string[],
      indicators: input.indicators as string[],
      ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds as string[] } : {}),
      ...(id ? { id, expectedVersion: input.expectedVersion as number } : {}),
    };
    return c.json({
      focus: changed("focus_saved", () => dynamic.saveFocus(edit, { actor: "owner" })),
    });
  });
  app.post("/api/dynamic/focus", save);
  app.put("/api/dynamic/focus/:id", save);
  app.post(
    "/api/dynamic/focus/:id/state",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        focus: changed("focus_state_saved", () =>
          dynamic.setFocusState(
            {
              id: c.req.param("id") ?? "",
              expectedVersion: input.expectedVersion as number,
              state: input.state as GrowthFocusState,
              ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds as string[] } : {}),
            },
            { actor: "owner" },
          ),
        ),
      });
    }),
  );
  app.get(
    "/api/dynamic/focus/:id/notes",
    handle((c) =>
      c.json(
        dynamic.notes(c.req.param("id") ?? "", {
          limit: Number(c.req.query("limit") ?? 20),
          ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
        }),
      ),
    ),
  );
  app.post(
    "/api/dynamic/focus/:id/notes",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        note: changed("note_saved", () =>
          dynamic.addNote(
            {
              focusId: c.req.param("id") ?? "",
              expectedFocusVersion: input.expectedFocusVersion as number,
              body: input.body as string,
              kind: input.kind as DynamicProgressNote["kind"],
              ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds as string[] } : {}),
              ...(input.supersedesNoteId !== undefined
                ? { supersedesNoteId: input.supersedesNoteId as string }
                : {}),
            },
            { actor: "owner" },
          ),
        ),
      });
    }),
  );
}
