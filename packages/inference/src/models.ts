import {
  InferenceError,
  positiveTokenCount,
  type RequestOptions,
  record,
  request,
  safeIdPattern,
} from "./transport";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const efforts: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface NeuralwattModel {
  id: string;
  displayName: string;
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
  vision: boolean;
  tools?: boolean;
  maxImages: number | null;
  systemRole: boolean;
  reasoningEffort: boolean;
  deprecated: boolean;
  reasoning: {
    mandatory: boolean;
    defaultEnabled: boolean;
    defaultEffort: ReasoningEffort | null;
    supportedEfforts: ReasoningEffort[];
    acceptedEfforts: ReasoningEffort[];
    effortAliases: Partial<Record<ReasoningEffort, ReasoningEffort>>;
  } | null;
  pricing: {
    currency: "USD" | null;
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    cachedInputPerMillion: number | null;
    pricingTbd: boolean;
  };
}

export interface NeuralwattCatalog {
  scope: "customer";
  checkedAt: string;
  requestId: string | null;
  models: NeuralwattModel[];
}

function isEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && efforts.includes(value);
}

function effortList(value: unknown): ReasoningEffort[] {
  return Array.isArray(value) ? [...new Set(value.filter(isEffort))] : [];
}

function price(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function modelFrom(value: unknown): NeuralwattModel | null {
  const entry = record(value);
  if (typeof entry.id !== "string" || !safeIdPattern.test(entry.id)) return null;
  const metadata = record(entry.metadata);
  const capabilities = record(metadata.capabilities);
  const limits = record(metadata.limits);
  const reasoning = record(metadata.reasoning);
  const pricing = record(metadata.pricing);
  const effortAliases: Partial<Record<ReasoningEffort, ReasoningEffort>> = {};
  for (const [from, to] of Object.entries(record(reasoning.effort_aliases))) {
    if (isEffort(from) && isEffort(to)) effortAliases[from] = to;
  }
  const pricingKnown = pricing.currency === "USD" && pricing.pricing_tbd === false;
  return {
    id: entry.id,
    displayName:
      typeof metadata.display_name === "string" ? metadata.display_name.slice(0, 200) : entry.id,
    maxContextTokens: positiveTokenCount(limits.max_context_length ?? entry.max_model_len),
    maxOutputTokens: positiveTokenCount(limits.max_output_tokens),
    vision: capabilities.vision === true,
    tools: capabilities.tools === true,
    maxImages: capabilities.vision === true ? positiveTokenCount(limits.max_images) : null,
    systemRole: capabilities.system_role === true,
    reasoningEffort: capabilities.reasoning_effort === true,
    deprecated: metadata.deprecated === true,
    reasoning:
      metadata.reasoning !== null && typeof metadata.reasoning === "object"
        ? {
            mandatory: reasoning.mandatory === true,
            defaultEnabled: reasoning.default_enabled === true,
            defaultEffort: isEffort(reasoning.default_effort) ? reasoning.default_effort : null,
            supportedEfforts: effortList(reasoning.supported_efforts),
            acceptedEfforts: effortList(reasoning.accepted_efforts),
            effortAliases,
          }
        : null,
    pricing: {
      currency: pricing.currency === "USD" ? "USD" : null,
      inputPerMillion: pricingKnown ? price(pricing.input_per_million) : null,
      outputPerMillion: pricingKnown ? price(pricing.output_per_million) : null,
      cachedInputPerMillion: pricingKnown ? price(pricing.cached_input_per_million) : null,
      pricingTbd: !pricingKnown,
    },
  };
}

/** Only an authenticated account catalog can validate a selectable model. */
export async function discoverNeuralwattModels(
  options: RequestOptions & { signal?: AbortSignal },
): Promise<NeuralwattCatalog> {
  const result = await request(
    "/models",
    { ...options, timeoutMs: options.timeoutMs ?? 30_000 },
    options,
  );
  if (result.scope !== "customer" || result.body.scope !== "customer")
    throw new InferenceError("catalog_scope");
  if (!Array.isArray(result.body.data)) throw new InferenceError("invalid_response");
  const models = result.body.data.map(modelFrom).filter((model) => model !== null);
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new InferenceError("invalid_response");
  return {
    scope: "customer",
    checkedAt: new Date().toISOString(),
    requestId: result.requestId,
    models,
  };
}
