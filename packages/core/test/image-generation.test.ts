import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConversationService,
  createImageJobService,
  type ImageJobInput,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=",
  "base64",
);

function fixture(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  let clock = new Date("2026-09-13T12:00:00.000Z");
  const conversations = createConversationService(store, { now: () => clock });
  const jobs = createImageJobService(store, { now: () => clock });
  const settings = conversations.getSettings();
  if (!settings.model)
    conversations.saveSettings({
      ...settings,
      model: "fictional",
      expectedVersion: settings.version,
    });
  return {
    store,
    conversations,
    jobs,
    advance(ms: number) {
      clock = new Date(clock.valueOf() + ms);
    },
    turn(updateId = 1, chatId = "123") {
      conversations.acceptTelegramBatch({
        nextOffset: updateId + 1,
        inputs: [
          {
            updateId,
            messageId: String(updateId),
            senderId: chatId,
            chatId,
            text: "Please take a picture in a blue sweater.",
          },
        ],
      });
      const turn = conversations.startNextTurn();
      if (!turn) throw new Error("No fixture turn.");
      return turn;
    },
    deliverText(turnId: string) {
      conversations.completeGeneration(turnId, { text: "Give me a moment, Ember." });
      const delivery = conversations.claimDelivery();
      if (!delivery) throw new Error("No fixture delivery.");
      conversations.recordDelivery(delivery.id, { status: "sent", messageId: "345" });
    },
  };
}

function input(turnId: string): ImageJobInput {
  return {
    turnId,
    toolCallId: "fictional-call",
    framing: "selfie",
    sceneTags: ["blue sweater"],
    prompt: "fictional adult character, blue sweater",
    seed: 12345,
    workflow: { "3": { class_type: "FictionalPrompt", inputs: { text: "fictional prompt" } } },
    invocation: {
      call: {
        id: "fictional-call",
        name: "request_character_image",
        arguments: '{"framing":"selfie","scene_tags":["blue sweater"]}',
      },
      completion: { usage: { inputTokens: 10, outputTokens: 20 }, requestId: "req-fictional" },
    },
  };
}

function close(store: Store) {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}

test("image requests pin immutable workflow, seed and tool invocation once per originating turn", () => {
  const { jobs, store, turn } = fixture();
  const current = turn();
  const request = input(current.id);
  const first = jobs.enqueue(request);
  request.sceneTags.push("rainy window");
  request.workflow.changed = true;
  const replay = jobs.enqueue({ ...request, toolCallId: "different-provider-id", seed: 999 });
  expect(replay).toEqual(first);
  expect(jobs.getForTurn(current.id)?.sceneTags).toEqual(["blue sweater"]);
  expect(first.invocation?.completion?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  expect(first.promptId).toMatch(/^[a-f0-9-]{36}$/);
  expect(() =>
    store.db.query("UPDATE core_image_jobs SET workflow_json='{}' WHERE id=?").run(first.id),
  ).toThrow("immutable");
  expect(() =>
    store.db.query("UPDATE core_image_jobs SET seed=1 WHERE id=?").run(first.id),
  ).toThrow("immutable");
  expect(jobs.listForTurn(current.id)).toEqual([first]);
});

test("a second connection cannot claim a second render while submission or recovery is active", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-image-claim-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const first = fixture(path);
  const firstTurn = first.turn();
  const firstJob = first.jobs.enqueue(input(firstTurn.id));
  first.deliverText(firstTurn.id);
  const nextTurn = first.turn(2);
  const nextJob = first.jobs.enqueue(input(nextTurn.id));
  const other = fixture(path);
  expect(first.jobs.claimRender()?.id).toBe(firstJob.id);
  expect(other.jobs.claimRender()).toBeNull();
  other.jobs.markRecovery(firstJob.id, "submit_timeout");
  expect(first.jobs.claimRender()).toBeNull();
  expect(first.jobs.nextPendingRender()?.id).toBe(firstJob.id);
  other.jobs.fail(firstJob.id, "render_deadline", { unknown: true });
  expect(first.jobs.claimRender()?.id).toBe(nextJob.id);
});

test("an interrupted submission survives reopening for reconciliation and never becomes queued again", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-image-recover-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const first = fixture(path);
  const job = first.jobs.enqueue(input(first.turn().id));
  const claimed = first.jobs.claimRender();
  expect(claimed?.deadlineAt).toBe("2026-09-13T12:15:00.000Z");
  close(first.store);
  const reopened = fixture(path);
  expect(reopened.jobs.recoverInterrupted()).toEqual({ renders: 1, deliveries: 0 });
  expect(reopened.jobs.recoverInterrupted()).toEqual({ renders: 0, deliveries: 0 });
  expect(reopened.jobs.claimRender()).toBeNull();
  expect(reopened.jobs.nextPendingRender()).toMatchObject({
    id: job.id,
    status: "recovery",
    promptId: job.promptId,
    seed: 12345,
    deadlineAt: claimed?.deadlineAt,
    invocation: job.invocation,
  });
  expect(reopened.jobs.markSubmitted(job.id, job.promptId).status).toBe("running");
});

test("a returned ComfyUI prompt ID is archived separately from its immutable submission ID", () => {
  const { jobs, turn } = fixture();
  const job = jobs.enqueue(input(turn().id));
  jobs.claimRender();
  const returned = crypto.randomUUID();
  expect(jobs.markSubmitted(job.id, returned)).toMatchObject({
    promptId: job.promptId,
    submittedPromptId: returned,
    status: "recovery",
    failureCode: "prompt_id_mismatch",
  });
});

test("final image bytes survive reopening and photo delivery waits for the initiating text receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-generated-image-"));
  directories.push(directory);
  const path = join(directory, "test.sqlite");
  const first = fixture(path);
  const turn = first.turn(1, "567");
  const job = first.jobs.enqueue(input(turn.id));
  first.jobs.claimRender();
  first.jobs.markSubmitted(job.id, job.promptId);
  const image = first.jobs.saveImage(job.id, png);
  expect(first.jobs.saveImage(job.id, png).id).toBe(image.id);
  expect(first.jobs.getImage(image.id)).toMatchObject({
    jobId: job.id,
    turnId: turn.id,
    chatId: "567",
    width: 1,
    height: 1,
    mimeType: "image/png",
  });
  expect(first.jobs.getImage(image.id)?.bytes).toEqual(png);
  expect(() =>
    first.store.db.query("UPDATE core_generated_images SET width=2 WHERE id=?").run(image.id),
  ).toThrow("immutable");
  expect(() =>
    first.store.db.query("DELETE FROM core_generated_images WHERE id=?").run(image.id),
  ).toThrow("retained");
  expect(first.jobs.claimDelivery()).toBeNull();
  first.conversations.completeGeneration(turn.id, { text: "Give me a moment." });
  expect(first.jobs.claimDelivery()).toBeNull();
  const text = first.conversations.claimDelivery();
  if (!text) throw new Error("Missing initiating text.");
  first.conversations.recordDelivery(text.id, { status: "sent", messageId: "456" });
  close(first.store);
  const reopened = fixture(path);
  const delivery = reopened.jobs.claimDelivery();
  expect(delivery).toMatchObject({
    id: job.id,
    turnId: turn.id,
    chatId: "567",
    assetId: image.id,
    attempts: 1,
  });
  expect(delivery?.image.bytes).toEqual(png);
  expect(reopened.jobs.claimDelivery()).toBeNull();
  reopened.jobs.recordDelivery(job.id, { status: "sent", messageId: "789" });
  expect(reopened.jobs.get(job.id)).toMatchObject({ status: "sent", telegramMessageId: "789" });
  expect(reopened.jobs.claimDelivery()).toBeNull();
});

test("ambiguous image sends retain bytes and never resend after worker restart", () => {
  const { jobs, turn, deliverText } = fixture();
  const current = turn();
  const job = jobs.enqueue(input(current.id));
  jobs.claimRender();
  const image = jobs.saveImage(job.id, png);
  deliverText(current.id);
  expect(jobs.claimDelivery()?.id).toBe(job.id);
  expect(jobs.recoverInterrupted()).toEqual({ renders: 0, deliveries: 1 });
  expect(jobs.get(job.id)).toMatchObject({
    status: "unknown",
    failureCode: "interrupted_delivery",
  });
  expect(jobs.claimDelivery()).toBeNull();
  expect(jobs.getImage(image.id)?.bytes).toEqual(png);
  expect(() => jobs.recordDelivery(job.id, { status: "sent", messageId: "999" })).toThrow(
    "required state",
  );
});

test("only confirmed safe photo retries are claimed when due with the same immutable image", () => {
  const { jobs, turn, deliverText, advance } = fixture();
  const current = turn();
  const job = jobs.enqueue(input(current.id));
  jobs.claimRender();
  const image = jobs.saveImage(job.id, png);
  deliverText(current.id);
  jobs.claimDelivery();
  jobs.recordDelivery(job.id, {
    status: "retry",
    code: "rate_limited",
    retryAt: "2026-09-13T12:00:03.000Z",
  });
  expect(jobs.claimDelivery()).toBeNull();
  advance(3000);
  expect(jobs.claimDelivery()).toMatchObject({ id: job.id, assetId: image.id, attempts: 2 });
  jobs.recordDelivery(job.id, { status: "failed", code: "rejected" });
  expect(jobs.claimDelivery()).toBeNull();
  expect(jobs.getImage(image.id)?.bytes).toEqual(png);
});

test("invalid images and failure transitions cannot create a deliverable success", () => {
  const { jobs, turn, deliverText } = fixture();
  const current = turn();
  const job = jobs.enqueue(input(current.id));
  jobs.claimRender();
  expect(() => jobs.saveImage(job.id, Buffer.from("not an image"))).toThrow();
  jobs.fail(job.id, "missing_final_image");
  expect(jobs.get(job.id)).toMatchObject({ status: "failed", assetId: null });
  deliverText(current.id);
  expect(jobs.claimDelivery()).toBeNull();
  expect(() => jobs.saveImage(job.id, png)).toThrow("required state");
  expect(() => jobs.markRecovery(job.id, "network")).toThrow("required state");
});

test("failure notices use the pinned snapshot and wait for text delivery before composing once", () => {
  const { jobs, turn, deliverText, store } = fixture();
  const current = turn();
  const job = jobs.enqueue(input(current.id));
  jobs.claimRender();
  jobs.fail(job.id, "comfyui_unavailable");
  expect(jobs.claimFailureNotice()).toBeNull();
  deliverText(current.id);
  const notice = jobs.claimFailureNotice();
  expect(notice).toMatchObject({
    id: job.id,
    job: { status: "failed", failureCode: "comfyui_unavailable" },
    snapshot: current.snapshot,
    text: null,
    status: "generating",
  });
  expect(jobs.claimFailureNotice()).toBeNull();
  const text = "The camera's being stubborn, Ember. I couldn't finish your picture.";
  const result = {
    text,
    usage: { inputTokens: 200, outputTokens: 20 },
    requestId: "notice-req",
    costUsd: 0.001,
  };
  jobs.completeFailureNotice(job.id, text, result);
  expect(() =>
    store.db
      .query("UPDATE core_image_failure_notices SET text='another' WHERE job_id=?")
      .run(job.id),
  ).toThrow("immutable");
  expect(jobs.claimFailureNoticeDelivery()).toMatchObject({
    id: job.id,
    text,
    status: "sending",
    result,
  });
  expect(jobs.claimFailureNoticeDelivery()).toBeNull();
  jobs.recordFailureNoticeDelivery(job.id, { status: "sent", messageId: "988" });
  expect(jobs.getFailureNotice(job.id)).toMatchObject({ status: "sent", telegramMessageId: "988" });
  expect(jobs.claimFailureNotice()).toBeNull();
  expect(jobs.claimFailureNoticeDelivery()).toBeNull();
});

test("interrupted failure notice generation can resume while interrupted notice delivery is never replayed", () => {
  const { jobs, turn, deliverText } = fixture();
  const current = turn();
  const job = jobs.enqueue(input(current.id));
  jobs.claimRender();
  jobs.fail(job.id, "render_deadline", { unknown: true });
  deliverText(current.id);
  expect(jobs.claimFailureNotice()?.job.status).toBe("unknown");
  jobs.recoverInterrupted();
  expect(jobs.claimFailureNotice()?.id).toBe(job.id);
  jobs.completeFailureNotice(job.id, "I couldn't confirm whether your picture finished.");
  jobs.claimFailureNoticeDelivery();
  jobs.recoverInterrupted();
  expect(jobs.getFailureNotice(job.id)).toMatchObject({
    status: "unknown",
    failureCode: "interrupted_delivery",
  });
  expect(jobs.claimFailureNoticeDelivery()).toBeNull();
  expect(jobs.claimFailureNotice()).toBeNull();
});

test("failure notification failures remain terminal without recursively scheduling another notice", () => {
  const { jobs, turn, deliverText } = fixture();
  const current = turn();
  const job = jobs.enqueue(input(current.id));
  jobs.fail(job.id, "comfyui_unavailable");
  deliverText(current.id);
  jobs.claimFailureNotice();
  jobs.failFailureNotice(job.id, "incomplete_response", {
    text: "Partial",
    finishReason: "length",
    usage: { outputTokens: 200 },
  });
  expect(jobs.getFailureNotice(job.id)).toMatchObject({
    status: "failed",
    failureCode: "incomplete_response",
    result: { finishReason: "length", usage: { outputTokens: 200 } },
  });
  jobs.recoverInterrupted();
  expect(jobs.claimFailureNotice()).toBeNull();
  expect(jobs.claimFailureNoticeDelivery()).toBeNull();
});

test.each(["failed", "unknown"] as const)(
  "a terminal %s acknowledgement does not strand the requested image or invent an image failure",
  (status) => {
    const { jobs, turn, conversations } = fixture();
    const current = turn();
    const job = jobs.enqueue(input(current.id));
    jobs.claimRender();
    jobs.saveImage(job.id, png);
    conversations.completeGeneration(current.id, { text: "Give me a moment." });
    const text = conversations.claimDelivery();
    if (!text) throw new Error("No acknowledgement delivery.");
    conversations.recordDelivery(text.id, { status, code: "network" });
    expect(jobs.claimDelivery()?.id).toBe(job.id);
    jobs.recordDelivery(job.id, { status: "sent", messageId: "111" });
    expect(jobs.get(job.id)?.status).toBe("sent");
    expect(jobs.getFailureNotice(job.id)).toBeNull();
  },
);

test("image failure notice can explain a real render failure after acknowledgement generation failed", () => {
  const { jobs, turn, conversations } = fixture();
  const current = turn();
  const job = jobs.enqueue(input(current.id));
  jobs.fail(job.id, "comfyui_unavailable");
  conversations.failGeneration(current.id, { code: "provider" });
  expect(jobs.claimFailureNotice()?.id).toBe(job.id);
  jobs.completeFailureNotice(job.id, "I couldn't finish your picture, Ember.");
  expect(jobs.claimFailureNoticeDelivery()?.id).toBe(job.id);
});
