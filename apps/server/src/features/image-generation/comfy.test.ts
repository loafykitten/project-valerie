import { expect, test } from "bun:test";
import { createComfyClient } from "./comfy";
import { fictionalWorkflow, imageJobId, testPng } from "./fixtures.test";

const signal = () => new AbortController().signal;
const final = {
  filename: "Refined_00001_.png",
  subfolder: `Valerie/App/${imageJobId}`,
  type: "output" as const,
};

test("submit uses app-owned ID and graph only; validation errors with IDs stay recoverable", async () => {
  const bodies: unknown[] = [];
  const client = createComfyClient({
    baseUrl: "http://comfy.example:8188",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      expect(init.redirect).toBe("error");
      return Response.json({
        prompt_id: imageJobId,
        node_errors: { "8": { errors: ["private upstream details"] } },
      });
    },
  });
  const outcome = await client.submit(fictionalWorkflow().graph, imageJobId, signal());
  expect(outcome).toEqual({
    status: "unknown",
    promptId: imageJobId,
    code: "workflow_node_errors",
  });
  const body = bodies[0] as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["client_id", "prompt", "prompt_id"]);
  expect(body.prompt_id).toBe(imageJobId);
  expect(body.prompt).toEqual(fictionalWorkflow().graph);
});

test("history requires explicit successful completion and final output node 8", async () => {
  let history: unknown = {
    outputs: { "17": { images: [final] } },
    status: { completed: true, status_str: "success" },
  };
  const urls: string[] = [];
  const client = createComfyClient({
    baseUrl: "http://comfy.example:8188",
    fetch: async (url) => {
      urls.push(url);
      if (url.includes("/view?")) return new Response(testPng);
      return Response.json({ [imageJobId]: history });
    },
  });
  expect(await client.inspect(imageJobId, signal())).toEqual({
    status: "failed",
    code: "missing_final_image",
  });
  history = {
    outputs: {
      "8": { images: [final] },
      "17": { images: [{ ...final, filename: "Original.png" }] },
    },
    status: { completed: true, status_str: "success" },
  };
  expect(await client.inspect(imageJobId, signal())).toEqual({ status: "succeeded", image: final });
  expect(await client.download(final, signal())).toEqual(testPng);
  const view = new URL(urls.at(-1) ?? "");
  expect(view.searchParams.get("filename")).toBe(final.filename);
  expect(view.searchParams.get("subfolder")).toBe(final.subfolder);
  expect(view.searchParams.get("type")).toBe("output");
  expect(view.searchParams.has("preview")).toBe(false);
  expect(view.searchParams.has("channel")).toBe(false);
  history = { status: { completed: true, status_str: "error" } };
  expect(await client.inspect(imageJobId, signal())).toEqual({
    status: "failed",
    code: "render_failed",
  });
});

test("empty history reconciles queue and does not imply rejection", async () => {
  let queued = true;
  const client = createComfyClient({
    baseUrl: "http://comfy.example:8188",
    fetch: async (url) =>
      Response.json(
        url.endsWith("/queue")
          ? { queue_running: [], queue_pending: queued ? [[3, imageJobId, {}]] : [] }
          : {},
      ),
  });
  expect(await client.inspect(imageJobId, signal())).toEqual({ status: "pending" });
  queued = false;
  expect(await client.inspect(imageJobId, signal())).toEqual({ status: "missing" });
});

test("network failures are sanitized, stalled requests bounded, and unsafe output paths rejected", async () => {
  const broken = createComfyClient({
    baseUrl: "http://comfy.example:8188",
    fetch: async () => {
      throw new Error("private credentials");
    },
  });
  await expect(broken.submit(fictionalWorkflow().graph, imageJobId, signal())).rejects.toThrow(
    "ComfyUI request failed: network.",
  );
  const stalled = createComfyClient({
    baseUrl: "http://comfy.example:8188",
    requestTimeoutMs: 5,
    fetch: async () => new Promise<Response>(() => {}),
  });
  await expect(stalled.inspect(imageJobId, signal())).rejects.toThrow("deadline");
  for (const subfolder of [
    "../private",
    "/etc",
    "https://elsewhere.invalid",
    "folder\\..\\private",
    "%2e%2e",
  ]) {
    await expect(broken.download({ ...final, subfolder }, signal())).rejects.toThrow(
      "invalid_response",
    );
  }
  const oversized = createComfyClient({
    baseUrl: "http://comfy.example:8188",
    fetch: async () =>
      new Response("small", { headers: { "content-length": String(6 * 1024 * 1024) } }),
  });
  await expect(oversized.download(final, signal())).rejects.toThrow("image_too_large");
});
