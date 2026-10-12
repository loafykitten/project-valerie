import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { record } from "../../json";

export type ImageFraming = "selfie" | "full_body";
export interface ImageScene {
  framing: ImageFraming;
  scene_tags: string[];
}
export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export interface ImageWorkflow {
  graph: ComfyGraph;
  identityTags: string[];
  styleTags: string[];
  framing: Record<ImageFraming, string[]>;
}
export interface PreparedImageRequest {
  framing: ImageFraming;
  sceneTags: string[];
  seed: number;
  positivePrompt: string;
  workflow: ComfyGraph;
}

export class ImageRequestError extends Error {
  constructor(readonly code: "invalid_scene" | "identity_conflict" | "invalid_workflow") {
    super(`Image request failed: ${code}.`);
    this.name = "ImageRequestError";
  }
}

function tags(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 64 ||
    value.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 100)
  ) {
    throw new ImageRequestError("invalid_workflow");
  }
  return value as string[];
}

/** The private bundle is owner configuration. Its graph is never accepted from a model. */
export function loadImageWorkflow(bundleDir: string): ImageWorkflow {
  try {
    if (!isAbsolute(bundleDir)) throw new ImageRequestError("invalid_workflow");
    const read = (name: string) => {
      const path = join(bundleDir, name);
      if (statSync(path).size > 256 * 1024) throw new ImageRequestError("invalid_workflow");
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    };
    return parseImageWorkflow(read("comfyui-val.api.template.json"), read("prompt-profile.json"));
  } catch {
    // Configuration failures must not expose private paths, workflow content, or prose.
    throw new ImageRequestError("invalid_workflow");
  }
}

export function parseImageWorkflow(template: unknown, profile: unknown): ImageWorkflow {
  const graph = record(record(template).prompt);
  if (
    Object.keys(graph).length < 8 ||
    Object.values(graph).some((node) => {
      const value = record(node);
      return typeof value.class_type !== "string" || !value.inputs || Array.isArray(value.inputs);
    })
  ) {
    throw new ImageRequestError("invalid_workflow");
  }
  const binding = (id: string, type: string) => {
    const node = record(graph[id]);
    if (node.class_type !== type) throw new ImageRequestError("invalid_workflow");
    return record(node.inputs);
  };
  if (typeof binding("3", "CLIPTextEncode").text !== "string")
    throw new ImageRequestError("invalid_workflow");
  if (typeof binding("6", "KSampler").seed !== "number")
    throw new ImageRequestError("invalid_workflow");
  for (const id of ["8", "17"])
    if (typeof binding(id, "SaveImage").filename_prefix !== "string")
      throw new ImageRequestError("invalid_workflow");
  const dimensions = binding("5", "EmptyLatentImage");
  if (dimensions.width !== 1024 || dimensions.height !== 1344 || dimensions.batch_size !== 1)
    throw new ImageRequestError("invalid_workflow");
  const config = record(profile);
  const framings = record(config.framing_profiles);
  const frame = (name: ImageFraming) => {
    const value = record(framings[name]);
    if (value.width !== 1024 || value.height !== 1344)
      throw new ImageRequestError("invalid_workflow");
    return tags(value.tags);
  };
  return {
    graph: structuredClone(graph) as ComfyGraph,
    identityTags: tags(config.identity_tags),
    styleTags: tags(config.style_tags),
    framing: { selfie: frame("selfie"), full_body: frame("full_body") },
  };
}

/** Only concise visual scene phrases may cross the model-to-renderer boundary. */
export function validateImageScene(value: unknown): ImageScene {
  const scene = record(value);
  if (
    !["selfie", "full_body"].includes(String(scene.framing)) ||
    Object.keys(scene).some((key) => !["framing", "scene_tags"].includes(key)) ||
    !Array.isArray(scene.scene_tags) ||
    scene.scene_tags.length < 1 ||
    scene.scene_tags.length > 12
  ) {
    throw new ImageRequestError("invalid_scene");
  }
  const validated: string[] = [];
  for (const raw of scene.scene_tags) {
    if (typeof raw !== "string") throw new ImageRequestError("invalid_scene");
    const tag = raw.trim().replace(/\s+/g, " ").toLowerCase();
    if (!/^[a-z][a-z0-9 '-]{0,79}$/.test(tag)) throw new ImageRequestError("invalid_scene");
    // Identity attributes belong to the protected profile; scene tags control dress and setting.
    if (
      /\b(child|teen(?:ager|age)?|young|youthful|petite|slim|slender|skinny|thin body|muscular|boy|male|man|human|catgirl|foxgirl|bunny|elf|blue eyes|green eyes|red eyes|purple eyes|heterochromia|no glasses|without glasses|no ears|no tail|barefoot child)\b/.test(
        tag,
      ) ||
      /\b(?:hair|eyes|ears|eyewear|glasses|sidelocks|body shape|figure|age)\b/.test(tag) ||
      /\b(?:small|tiny|narrow|slim|slender|thin) (?:shoulders|body|figure|build)\b/.test(tag) ||
      (scene.framing === "selfie" &&
        /\b(full body|wide shot|feet in frame|shoes|trousers|pants)\b/.test(tag))
    ) {
      throw new ImageRequestError("identity_conflict");
    }
    if (!validated.includes(tag)) validated.push(tag);
  }
  return { framing: scene.framing as ImageFraming, scene_tags: validated };
}

export function prepareImageRequest(
  profile: ImageWorkflow,
  value: unknown,
  options: { jobId: string; seed?: number },
): PreparedImageRequest {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.jobId))
    throw new ImageRequestError("invalid_scene");
  const scene = validateImageScene(value);
  const seed = options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  if (seed === undefined || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new ImageRequestError("invalid_scene");
  const positivePrompt = [
    ...new Set([
      ...profile.identityTags,
      ...profile.framing[scene.framing],
      ...scene.scene_tags,
      ...(scene.scene_tags.some((tag) => /\bopen mouth\b/.test(tag)) ? ["fangs"] : []),
      ...profile.styleTags,
    ]),
  ].join(", ");
  const workflow = structuredClone(profile.graph);
  const input = (id: string) => {
    const node = workflow[id];
    if (!node) throw new ImageRequestError("invalid_workflow");
    return node.inputs;
  };
  input("3").text = positivePrompt;
  input("6").seed = seed;
  input("8").filename_prefix = `Valerie/App/${options.jobId}/Refined`;
  input("17").filename_prefix = `Valerie/App/${options.jobId}/Original`;
  return { framing: scene.framing, sceneTags: scene.scene_tags, seed, positivePrompt, workflow };
}
