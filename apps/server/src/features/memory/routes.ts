import {
  createActivityService,
  createMemoryService,
  MemoryBudgetError,
  MemoryConflictError,
  type MemorySaveInput,
  type Store,
} from "@valerie/core";
import type { Context, Hono } from "hono";
import { readJsonObject, routeHandler } from "../../http";

const body = (c: Context) =>
  readJsonObject(c, {
    contentType: "Send memory edits as JSON.",
    shape: "Provide a memory edit object.",
  });

/** These routes inherit the owner's private host/origin and no-store boundary. */
export function mountMemoryRoutes(app: Hono, store: Store) {
  const memory = createMemoryService(store);
  const activity = createActivityService(store);
  const handle = routeHandler((error, c) =>
    error instanceof MemoryConflictError || error instanceof MemoryBudgetError
      ? c.json({ error: error.message }, 409)
      : undefined,
  );
  const recordChange = <T>(kind: string, action: () => T) =>
    store.db
      .transaction(() => {
        const result = action();
        activity.append({
          kind: `memory.${kind}`,
          summary: `Memory ${kind}.`,
          status: "succeeded",
        });
        return result;
      })
      .immediate();

  app.get(
    "/api/memory/status",
    handle((c) => c.json(memory.status())),
  );
  app.get(
    "/api/memory/recall",
    handle((c) => c.json(memory.recentRecall())),
  );
  app.get(
    "/api/memory/search",
    handle((c) => {
      const source = c.req.query("source") ?? "all";
      if (!["all", "records", "vault"].includes(source))
        throw new TypeError("Unknown memory source.");
      return c.json(
        memory.search({
          query: c.req.query("q") ?? "",
          source: source as "all" | "records" | "vault",
          tier: c.req.query("tier") as "core" | "short" | "long" | undefined,
          includeArchive: c.req.query("includeArchive") === "true",
          cursor: c.req.query("cursor") || undefined,
          limit: Number(c.req.query("limit") ?? 20),
        }),
      );
    }),
  );
  app.get(
    "/api/memory/topics",
    handle((c) =>
      c.json(
        memory.topicsList({
          query: c.req.query("q") ?? "",
          cursor: c.req.query("cursor") || undefined,
          limit: Number(c.req.query("limit") ?? 10),
        }),
      ),
    ),
  );
  app.get(
    "/api/memory/notes",
    handle((c) =>
      c.json(
        memory.browseNotes({
          folder: c.req.query("folder") ?? "Notes",
          query: c.req.query("q") ?? "",
          includeArchive: c.req.query("includeArchive") === "true",
          cursor: c.req.query("cursor") || undefined,
          limit: Number(c.req.query("limit") ?? 8),
        }),
      ),
    ),
  );
  app.get(
    "/api/memory/conversations",
    handle((c) =>
      c.json(
        memory.conversationSearch({
          query: c.req.query("q") ?? "",
          cursor: c.req.query("cursor") || undefined,
          before: c.req.query("before"),
          after: c.req.query("after"),
          limit: Number(c.req.query("limit") ?? 10),
        }),
      ),
    ),
  );
  app.get(
    "/api/memory/conversations/:id",
    handle((c) => {
      const record = memory.conversationRead({
        id: c.req.param("id") ?? "",
        offset: Number(c.req.query("offset") ?? 0),
        maxBytes: 4000,
      });
      return record ? c.json(record) : c.json({ error: "Conversation source not found." }, 404);
    }),
  );
  app.get(
    "/api/memory/records/:id",
    handle((c) => {
      const version = c.req.query("version");
      const record = memory.read({
        id: c.req.param("id") ?? "",
        ...(version ? { revision: Number(version) } : {}),
        offset: Number(c.req.query("offset") ?? 0),
        includeArchive: c.req.query("includeArchive") === "true",
      });
      return record
        ? c.json(record)
        : c.json({ error: "Memory not found or source unavailable." }, 404);
    }),
  );
  app.put(
    "/api/memory/settings",
    handle(async (c) => {
      const input = await body(c);
      if (
        ["expectedVersion", "coreTokens", "retrievedTokens", "topicTokens"].some(
          (key) => typeof input[key] !== "number" || !Number.isSafeInteger(input[key]),
        )
      )
        throw new TypeError("Provide numeric recall budgets and the current settings version.");
      return c.json(
        recordChange("budgets saved", () =>
          memory.saveSettings({
            version: Number(input.expectedVersion),
            expectedVersion: Number(input.expectedVersion),
            coreTokens: Number(input.coreTokens),
            retrievedTokens: Number(input.retrievedTokens),
            topicTokens: Number(input.topicTokens),
          }),
        ),
      );
    }),
  );
  const save = handle(async (c) => {
    const input = await body(c);
    const id = c.req.param("id");
    if (id && !Number.isSafeInteger(input.expectedVersion))
      throw new TypeError("Provide the current memory version.");
    // Owner edits deliberately become owner evidence. Model-supplied provenance cannot
    // enter through this handler or grant permissions to a tool invocation.
    const edit: MemorySaveInput = {
      title: input.title as string,
      body: input.body as string,
      ...(input.thoughts !== undefined ? { thoughts: input.thoughts as string } : {}),
      authoredBy: "owner",
      tier: input.tier as MemorySaveInput["tier"],
      kind: input.kind as MemorySaveInput["kind"],
      ...(id ? { id, expectedVersion: input.expectedVersion as number } : {}),
    };
    return c.json(recordChange("saved", () => memory.save(edit)));
  });
  app.post("/api/memory/records", save);
  app.put("/api/memory/records/:id", save);
  app.post(
    "/api/memory/records/:id/archive",
    handle(async (c) => {
      const input = await body(c);
      if (!Number.isSafeInteger(input.expectedVersion))
        throw new TypeError("Provide the current memory version.");
      return c.json(
        recordChange("archived", () =>
          memory.archive({
            id: c.req.param("id") ?? "",
            expectedVersion: input.expectedVersion as number,
          }),
        ),
      );
    }),
  );
}
