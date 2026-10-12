import {
  createNeuralwattClient,
  discoverNeuralwattModels,
  InferenceError,
  inferenceTimeoutMs,
  validateInferenceSettings,
} from "../packages/inference/src";
import { printCatalogCheck, printInferenceProbeFailure } from "./probe-support";

// Explicit fictional live acceptance only. Never reads character assets, history, or SQLite.
const action = process.argv[2] ?? "check";
const modelId = process.argv[3] ?? "glm-5.3-flash";
try {
  if (!["check", "probe"].includes(action)) throw new InferenceError("configuration");
  const apiKey = process.env.NEURALWATT_API_KEY?.trim() ?? "";
  const catalog = await discoverNeuralwattModels({ apiKey });
  const model = catalog.models.find((entry) => entry.id === modelId);
  if (!model) throw new InferenceError("configuration");
  const reasoningEffort = model.reasoning?.supportedEfforts.includes("low") ? "low" : null;
  const settings = { maxTokens: 4096, reasoningEffort } as const;
  validateInferenceSettings(model, settings);
  if (action === "check") {
    printCatalogCheck(catalog, model);
  } else {
    const startedAt = Date.now();
    const result = await createNeuralwattClient({
      apiKey,
      model: model.id,
      capabilities: model,
      timeoutMs: inferenceTimeoutMs(model.id),
    }).complete({
      ...settings,
      messages: [
        {
          role: "system",
          content:
            "You are a fictional friendly companion in an integration test. Give a natural, concise response. Do not use tools.",
        },
        {
          role: "user",
          content:
            "I've been thinking about making a tiny herb garden on my windowsill today. I have a sunny window and no gardening experience.",
        },
        {
          role: "assistant",
          content:
            "A sunny window is a good start. Basil and chives are approachable, and you can begin with a small plant rather than seeds.",
        },
        {
          role: "user",
          content:
            "The chives sound nice. Can we keep this simple and pick just one thing for me to do next?",
        },
        {
          role: "system",
          content: "Reply in one or two sentences. Mention chives and suggest a single next step.",
        },
      ],
    });
    console.log(
      JSON.stringify(
        {
          status:
            result.complete &&
            result.text.toLowerCase().includes("chives") &&
            (!model.id.endsWith("-flex") || result.serviceTier === "flex")
              ? "passed"
              : "failed",
          model: model.id,
          reasoningEffort,
          maxTokens: settings.maxTokens,
          elapsedMs: Date.now() - startedAt,
          complete: result.complete,
          finishReason: result.finishReason,
          requestId: result.requestId,
          usage: result.usage,
          costUsd: result.costUsd,
          serviceTier: result.serviceTier,
          replyCharacters: result.text.length,
          followsFictionalTopic: result.text.toLowerCase().includes("chives"),
          hostedTools: "disabled",
          retried: false,
        },
        null,
        2,
      ),
    );
    if (
      !result.complete ||
      !result.text.toLowerCase().includes("chives") ||
      (model.id.endsWith("-flex") && result.serviceTier !== "flex")
    )
      process.exitCode = 1;
  }
} catch (error) {
  printInferenceProbeFailure(error);
}
