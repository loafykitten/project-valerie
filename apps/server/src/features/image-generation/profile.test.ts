import { expect, test } from "bun:test";
import { fictionalWorkflow, imageJobId } from "./fixtures.test";
import { prepareImageRequest, validateImageScene } from "./profile";

test("selfie replaces old composition, pins cloned graph, and preserves model and face controls", () => {
  const profile = fictionalWorkflow();
  const original = structuredClone(profile.graph);
  const result = prepareImageRequest(
    profile,
    { framing: "selfie", scene_tags: ["blue sweater", "open mouth", "Blue sweater"] },
    { jobId: imageJobId, seed: 0xffffffff },
  );
  expect(result.positivePrompt).toBe(
    "fictional adult, round figure, gray hair, round glasses, upper body, looking at viewer, full head in frame, ears in frame, blue sweater, open mouth, fangs, best quality",
  );
  expect(result.positivePrompt).not.toContain("full body");
  expect(result.positivePrompt).not.toContain("old outfit");
  expect(profile.graph).toEqual(original);
  for (const id of ["1", "2", "4", "5", "11"]) expect(result.workflow[id]).toEqual(original[id]);
  expect(result.workflow["6"]?.inputs).toEqual({ seed: 0xffffffff, cfg: 5, steps: 25 });
  expect(result.workflow["8"]?.inputs.filename_prefix).toContain(`${imageJobId}/Refined`);
  expect(result.workflow["17"]?.inputs.filename_prefix).toContain(`${imageJobId}/Original`);
  const face = result.workflow["11"];
  if (!face) throw new Error("Missing fixture face pass.");
  face.inputs.seed = 20;
  expect(profile.graph["11"]?.inputs.seed).toBe(9);
});

test("rejects identity contradictions, prompt syntax, model-controlled paths and conflicting selfie framing", () => {
  for (const tag of [
    "young",
    "slender",
    "green eyes",
    "blonde hair",
    "no glasses",
    "small build",
    "full body",
    "brown trousers",
    "(smile:2)",
    "scene, new subject",
    "<lora:other:1>",
    "https://elsewhere.invalid",
  ]) {
    expect(() => validateImageScene({ framing: "selfie", scene_tags: [tag] })).toThrow();
  }
  expect(() =>
    validateImageScene({ framing: "selfie", scene_tags: ["smile"], url: "elsewhere" }),
  ).toThrow();
  expect(() =>
    validateImageScene({ framing: "selfie", scene_tags: Array(13).fill("smile") }),
  ).toThrow();
  expect(() => validateImageScene({ framing: "selfie", scene_tags: [] })).toThrow();
  expect(
    validateImageScene({ framing: "full_body", scene_tags: ["brown trousers", "warm kitchen"] })
      .scene_tags,
  ).toEqual(["brown trousers", "warm kitchen"]);
});

test("application fangs rule keeps a maximum-sized model scene within storage limits", () => {
  const scene = ["open mouth", ...Array.from({ length: 11 }, (_, index) => `scene ${index}`)];
  const prepared = prepareImageRequest(
    fictionalWorkflow(),
    { framing: "selfie", scene_tags: scene },
    { jobId: imageJobId, seed: 1 },
  );
  expect(prepared.sceneTags).toHaveLength(12);
  expect(prepared.positivePrompt).toContain("fangs");
});
