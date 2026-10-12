import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createImageJobService,
  openStore,
  type Store,
} from "@valerie/core";
import { type ComfyClient, ComfyError } from "./comfy";
import { fictionalWorkflow, imageJobId, testPng } from "./fixtures.test";
import { prepareImageRequest } from "./profile";
import { createImageGenerationWorker } from "./worker";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const signal = () => new AbortController().signal;
const final = {
  filename: "Refined_00001_.png",
  subfolder: `Valerie/App/${imageJobId}`,
  type: "output" as const,
};
function fixture() {
  const store = openStore(":memory:");
  stores.push(store);
  let currentTime = Date.now();
  const conversations = createConversationService(store, { now: () => new Date(currentTime) });
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    model: "fictional",
    expectedVersion: settings.version,
  });
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "10",
        chatId: "123",
        senderId: "123",
        text: "Please send a fictional selfie.",
      },
    ],
  });
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Missing test turn.");
  const service = createImageJobService(store, {
    now: () => new Date(currentTime),
    renderTimeoutMs: 1000,
  });
  const prepared = prepareImageRequest(
    fictionalWorkflow(),
    { framing: "selfie", scene_tags: ["blue sweater", "warm kitchen"] },
    { jobId: imageJobId, seed: 4 },
  );
  const job = service.enqueue({
    id: imageJobId,
    turnId: turn.id,
    toolCallId: "fictional-call",
    ...prepared,
    prompt: prepared.positivePrompt,
  });
  return {
    service,
    job,
    conversations,
    turn,
    now: () => currentTime,
    advance: (ms = 1001) => {
      currentTime += ms;
    },
  };
}
function client(overrides: Partial<ComfyClient> = {}): ComfyClient {
  return {
    submit: async (_graph, promptId) => ({ status: "queued", promptId }),
    inspect: async () => ({ status: "pending" }),
    download: async () => testPng,
    ...overrides,
  };
}

test("an uncertain POST is never retried, survives restart, and can archive the final image once", async () => {
  const f = fixture();
  let posts = 0;
  let finished = false;
  const transport = client({
    submit: async () => {
      posts++;
      throw new ComfyError("network");
    },
    inspect: async () => (finished ? { status: "succeeded", image: final } : { status: "missing" }),
  });
  let worker = createImageGenerationWorker({ service: f.service, client: transport, now: f.now });
  await worker.tick(signal());
  expect(f.service.get(f.job.id)?.status).toBe("recovery");
  f.service.recoverInterrupted();
  worker = createImageGenerationWorker({ service: f.service, client: transport, now: f.now });
  await worker.tick(signal());
  expect(posts).toBe(1);
  finished = true;
  await worker.tick(signal());
  const stored = f.service.get(f.job.id);
  expect(stored?.status).toBe("ready");
  expect(f.service.getImage(stored?.assetId ?? "")?.bytes).toEqual(testPng);
  expect(f.service.claimDelivery()).toBeNull();
  await worker.tick(signal());
  expect(f.service.get(f.job.id)?.assetId).toBe(stored?.assetId);
  expect(posts).toBe(1);
});

test("persisted submitting state is reconciled without POST and deadline remains unknown", async () => {
  const f = fixture();
  f.service.claimRender();
  let posts = 0;
  const worker = createImageGenerationWorker({
    service: f.service,
    now: f.now,
    client: client({
      submit: async () => {
        posts++;
        throw new Error();
      },
      inspect: async () => ({ status: "missing" }),
    }),
  });
  await worker.tick(signal());
  expect(posts).toBe(0);
  f.advance();
  await worker.tick(signal());
  expect(f.service.get(f.job.id)?.status).toBe("unknown");
  expect(f.service.get(f.job.id)?.failureCode).toBe("render_deadline");
  expect(await worker.tick(signal())).toBe(false);
});

test("returned prompt ID is recorded before node errors and controls recovery", async () => {
  const f = fixture();
  const returned = "00000000-0000-4000-8000-000000000099";
  let inspected = "";
  const worker = createImageGenerationWorker({
    service: f.service,
    now: f.now,
    client: client({
      submit: async () => ({ status: "unknown", promptId: returned, code: "workflow_node_errors" }),
      inspect: async (id) => {
        inspected = id;
        return { status: "failed", code: "render_failed" };
      },
    }),
  });
  await worker.tick(signal());
  expect(f.service.get(f.job.id)?.submittedPromptId).toBe(returned);
  expect(f.service.get(f.job.id)?.status).toBe("recovery");
  await worker.tick(signal());
  expect(inspected).toBe(returned);
  expect(f.service.get(f.job.id)?.status).toBe("failed");
});

test("ticks cannot overlap, and stopping leaves the durable render recoverable", async () => {
  const f = fixture();
  let resolvePost: ((value: { status: "queued"; promptId: string }) => void) | undefined;
  const worker = createImageGenerationWorker({
    service: f.service,
    now: f.now,
    client: client({
      submit: async () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    }),
  });
  const controller = new AbortController();
  const pending = worker.tick(controller.signal);
  expect(await worker.tick(signal())).toBe(false);
  controller.abort();
  resolvePost?.({ status: "queued", promptId: f.job.promptId });
  await pending;
  expect(f.service.get(f.job.id)?.status).toBe("submitting");
});

test("an unrelated output cannot be attached even when history reports success", async () => {
  const f = fixture();
  let downloads = 0;
  const worker = createImageGenerationWorker({
    service: f.service,
    now: f.now,
    client: client({
      inspect: async () => ({
        status: "succeeded",
        image: { ...final, subfolder: "Another/Request" },
      }),
      download: async () => {
        downloads++;
        return testPng;
      },
    }),
  });
  await worker.tick(signal());
  await worker.tick(signal());
  expect(downloads).toBe(0);
  expect(f.service.get(f.job.id)?.status).toBe("unknown");
  expect(f.service.get(f.job.id)?.failureCode).toBe("output_mismatch");
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred was not initialized.");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("Deferred was not initialized.");
  };
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

for (const stage of ["submit", "inspect", "download"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`lease loss during ${stage} ${outcome} fences all writes after a successor takes ownership`, async () => {
      const f = fixture();
      const controller = new AbortController();
      const expires = () => new Date(f.now() + 120_000).toISOString();
      expect(f.conversations.acquireTelegramLease("predecessor", expires())).toBe(true);
      const assertActive = () => {
        if (!f.conversations.renewTelegramLease("predecessor", expires())) {
          controller.abort();
          throw new Error("Lease lost.");
        }
      };
      if (stage !== "submit") {
        f.service.claimRender();
        f.service.markSubmitted(f.job.id, f.job.promptId);
      }
      const entered = deferred<void>();
      const operation = deferred<void>();
      let networkCalls = 0;
      const checkpoint = async (current: typeof stage) => {
        networkCalls++;
        if (current === stage) {
          entered.resolve();
          await operation.promise;
        }
      };
      const worker = createImageGenerationWorker({
        service: f.service,
        now: f.now,
        client: client({
          submit: async (_workflow, promptId) => {
            await checkpoint("submit");
            return { status: "queued", promptId };
          },
          inspect: async () => {
            await checkpoint("inspect");
            return { status: "succeeded", image: final };
          },
          download: async () => {
            await checkpoint("download");
            return testPng;
          },
        }),
      });
      const pending = worker.tick(controller.signal, assertActive);
      await entered.promise;
      f.advance(120_001);
      expect(f.conversations.acquireTelegramLease("successor", expires())).toBe(true);
      f.service.recoverInterrupted();
      f.service.markRecovery(f.job.id, "successor_recovery");
      const successorState = f.service.get(f.job.id);
      const priorCalls = networkCalls;
      if (outcome === "resolve") operation.resolve();
      else operation.reject(new ComfyError("network"));
      await pending;
      expect(controller.signal.aborted).toBe(true);
      expect(f.service.get(f.job.id)).toEqual(successorState);
      expect(networkCalls).toBe(priorCalls);
      // A fenced object stays inert even if a caller accidentally supplies a fresh signal.
      expect(await worker.tick(signal())).toBe(false);
      expect(networkCalls).toBe(priorCalls);
    });
  }
}

test("an expired lease is checked before claiming or posting another queued image", async () => {
  const f = fixture();
  let posts = 0;
  const worker = createImageGenerationWorker({
    service: f.service,
    now: f.now,
    client: client({
      submit: async (_workflow, promptId) => {
        posts++;
        return { status: "queued", promptId };
      },
    }),
  });
  expect(
    await worker.tick(signal(), () => {
      throw new Error("Lease lost before next tick.");
    }),
  ).toBe(false);
  expect(f.service.get(f.job.id)?.status).toBe("queued");
  expect(posts).toBe(0);
  expect(await worker.tick(signal())).toBe(false);
  expect(posts).toBe(0);
});
