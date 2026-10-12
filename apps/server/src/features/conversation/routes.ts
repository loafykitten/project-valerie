import {
  createConversationService,
  createImageJobService,
  InferenceSettingsConflictError,
  type Store,
} from "@valerie/core";
import {
  discoverNeuralwattModels,
  InferenceError,
  type NeuralwattCatalog,
  type ReasoningEffort,
  validateInferenceSettings,
} from "@valerie/inference";
import type { Context, Hono } from "hono";
import type { HeartbeatRuntimeStatus } from "../heartbeat/runtime";

export type TelegramStatus = {
  state: string;
  lastError: string | null;
  lastUpdateAt: string | null;
  heartbeat?: HeartbeatRuntimeStatus;
  scheduled?: {
    state: "starting" | "waiting" | "preparing" | "stopped" | "failed";
    lastError: string | null;
    lastTickAt: string | null;
  };
};

export function mountConversationRoutes(
  app: Hono,
  store: Store,
  env: Record<string, string | undefined>,
  telegramStatus?: () => TelegramStatus,
  dependencies: { discover?: typeof discoverNeuralwattModels } = {},
) {
  const conversations = createConversationService(store);
  const images = createImageJobService(store);
  const discover = dependencies.discover ?? discoverNeuralwattModels;
  const state = () =>
    telegramStatus?.() ?? { state: "disabled", lastError: null, lastUpdateAt: null };
  const withGeneratedImages = <T extends { id: string }>(turn: T) => ({
    ...turn,
    generatedImages: images.listForTurn(turn.id).map((job) => ({
      id: job.id,
      status: job.status,
      assetId: job.assetId,
      failureCode: job.failureCode,
      deliveredAt: job.deliveredAt,
    })),
  });
  const inlineImage = (c: Context, image: { bytes: Uint8Array; mimeType: string }) =>
    c.body(new Uint8Array(image.bytes), 200, {
      "Content-Type": image.mimeType,
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  app.get("/api/conversation/turns", (c) => {
    const before = c.req.query("before");
    if (before !== undefined && !/^[a-f0-9-]{36}$/i.test(before))
      return c.json({ error: "Invalid conversation cursor." }, 400);
    return c.json({
      turns: conversations.recentTurns(20, before).map(withGeneratedImages),
    });
  });
  app.get("/api/conversation", (c) =>
    c.json({
      settings: conversations.getSettings(),
      status: conversations.status(),
      telegram: state(),
      imageGeneration: {
        configured: Boolean(env.COMFYUI_BASE_URL?.trim() && env.COMFYUI_WORKFLOW_DIR?.trim()),
        available: Boolean(
          env.COMFYUI_BASE_URL?.trim() &&
            env.COMFYUI_WORKFLOW_DIR?.trim() &&
            state().state === "running" &&
            conversations.getSettings().modelCapabilities?.tools,
        ),
      },
      turns: conversations.recentTurns(20).map(withGeneratedImages),
    }),
  );
  app.get("/api/inference/models", async (c) => {
    try {
      return c.json(await discover({ apiKey: env.NEURALWATT_API_KEY ?? "", timeoutMs: 10000 }));
    } catch (error) {
      const code = error instanceof InferenceError ? error.code : "unavailable";
      return c.json(
        {
          error: `Neuralwatt model discovery failed (${code}). Check the server credential and connection.`,
        },
        503,
      );
    }
  });
  app.get("/api/conversation/attachments/:id", (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9-]{36}$/i.test(id)) return c.json({ error: "Image not found." }, 404);
    const attachment = conversations.getAttachment(id);
    if (!attachment) return c.json({ error: "Image not found." }, 404);
    return inlineImage(c, attachment);
  });
  app.get("/api/conversation/generated-images/:id", (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9-]{36}$/i.test(id)) return c.json({ error: "Image not found." }, 404);
    const image = images.getImage(id);
    if (!image) return c.json({ error: "Image not found." }, 404);
    return inlineImage(c, image);
  });
  app.get("/api/conversation/image-jobs/:id/prompt", (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9-]{36}$/i.test(id)) return c.json({ error: "Image request not found." }, 404);
    const job = images.get(id);
    if (!job) return c.json({ error: "Image request not found." }, 404);
    const textInput = (nodeId: string, inputName: string): string | null => {
      const node = job.workflow[nodeId];
      if (!node || typeof node !== "object" || !("inputs" in node)) return null;
      const inputs = node.inputs;
      if (!inputs || typeof inputs !== "object" || !(inputName in inputs)) return null;
      const value = (inputs as Record<string, unknown>)[inputName];
      return typeof value === "string" ? value : null;
    };
    // Only the requested prompt fields leave private storage; the graph stays server-side.
    return c.json({
      positivePrompt: job.prompt,
      negativePrompt: textInput("4", "text"),
      faceGuidance: textInput("11", "wildcard"),
      faceNegativePrompt: textInput("12", "text"),
      framing: job.framing,
      sceneTags: job.sceneTags,
      seed: job.seed,
    });
  });
  app.put("/api/inference/settings", async (c) => {
    if (!c.req.header("Content-Type")?.startsWith("application/json"))
      return c.json({ error: "Send settings as JSON." }, 415);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON." }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Provide inference settings." }, 400);
    const input = body as Record<string, unknown>;
    if (
      typeof input.model !== "string" ||
      typeof input.expectedVersion !== "number" ||
      ![input.maxOutputTokens, input.contextTokens, input.historyTokens, input.historyHours].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value),
      ) ||
      (input.temperature !== null && typeof input.temperature !== "number") ||
      (input.reasoningEffort !== null && typeof input.reasoningEffort !== "string")
    )
      return c.json(
        { error: "Provide a model, numeric budgets, and the current settings version." },
        400,
      );
    // Reject stale saves before the network request; saveSettings checks again after it.
    if (input.expectedVersion !== conversations.getSettings().version)
      return c.json({ error: "Settings changed elsewhere. Reload before saving." }, 409);
    let catalog: NeuralwattCatalog;
    try {
      catalog = await discover({ apiKey: env.NEURALWATT_API_KEY ?? "", timeoutMs: 10000 });
    } catch {
      return c.json(
        { error: "Could not verify the model with Neuralwatt. Settings were not saved." },
        503,
      );
    }
    try {
      const model = catalog.models.find((entry) => entry.id === input.model);
      if (!model || model.maxContextTokens === null)
        return c.json(
          { error: "This model is unavailable or has no verified context limit." },
          400,
        );
      validateInferenceSettings(model, {
        maxTokens: input.maxOutputTokens as number,
        temperature: input.temperature === null ? undefined : (input.temperature as number),
        reasoningEffort:
          input.reasoningEffort === null ? undefined : (input.reasoningEffort as ReasoningEffort),
      });
      const settings = conversations.saveSettings({
        expectedVersion: input.expectedVersion,
        model: model.id,
        maxOutputTokens: input.maxOutputTokens as number,
        contextTokens: input.contextTokens as number,
        historyTokens: input.historyTokens as number,
        historyHours: input.historyHours as number,
        temperature: input.temperature as number | null,
        reasoningEffort: input.reasoningEffort as string | null,
        modelContextTokens: model.maxContextTokens,
        modelMaxOutputTokens: model.maxOutputTokens ?? 32768,
        modelCapabilities: model,
        capabilityCheckedAt: catalog.checkedAt,
      });
      return c.json({ settings });
    } catch (error) {
      if (error instanceof InferenceSettingsConflictError)
        return c.json({ error: "Settings changed elsewhere. Reload before saving." }, 409);
      if (error instanceof TypeError) return c.json({ error: error.message }, 400);
      if (error instanceof InferenceError && error.code === "configuration")
        return c.json({ error: "These settings are unsupported by the selected model." }, 400);
      return c.json(
        { error: "Could not verify the model with Neuralwatt. Settings were not saved." },
        503,
      );
    }
  });
  app.post("/api/conversation/turns/:id/retry", (c) => {
    try {
      conversations.retryTurn(c.req.param("id"));
      return c.json({ queued: true });
    } catch (error) {
      if (error instanceof TypeError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
}
