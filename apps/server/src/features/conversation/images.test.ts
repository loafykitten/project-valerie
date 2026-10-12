import { afterEach, expect, test } from "bun:test";
import {
  createConversationService,
  createImageJobService,
  openStore,
  type Store,
} from "@valerie/core";
import { createApp } from "../../app";
import { loadConfig } from "../../config";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhSkAAAAASUVORK5CYII=",
  "base64",
);

test("generated image previews stay private and job summaries omit prompts, workflows and tool calls", async () => {
  const store = openStore(":memory:");
  stores.push(store);
  const conversations = createConversationService(store);
  const settings = conversations.getSettings();
  conversations.saveSettings({
    ...settings,
    expectedVersion: settings.version,
    model: "fictional-model",
  });
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      { updateId: 1, messageId: "1", chatId: "123", senderId: "123", text: "A fictional picture" },
    ],
  });
  const turn = conversations.startNextTurn();
  if (!turn) throw new Error("Fixture missing turn");
  const images = createImageJobService(store);
  const job = images.enqueue({
    turnId: turn.id,
    toolCallId: "private-tool-id",
    framing: "selfie",
    sceneTags: ["fictional outfit"],
    seed: 1,
    prompt: "private-prompt",
    workflow: {
      privateWorkflow: "private-workflow-secret",
      "4": { inputs: { text: "fictional negative" } },
      "11": { inputs: { wildcard: "fictional face guidance", hidden: "private-node-option" } },
      "12": { inputs: { text: "fictional face negative" } },
    },
  });
  images.claimRender();
  const asset = images.saveImage(job.id, png);
  const app = createApp(store, loadConfig({}), {});
  const url = `http://localhost:3100/api/conversation/generated-images/${asset.id}`;
  const response = await app.request(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect(
    (await app.request(url, { headers: { Origin: "https://untrusted.example" } })).status,
  ).toBe(403);
  expect((await app.request(url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(
    403,
  );
  expect((await app.request(url.replace("localhost:3100", "untrusted.example"))).status).toBe(403);
  const summary = await (await app.request("http://localhost:3100/api/conversation")).text();
  expect(summary).toContain(asset.id);
  for (const privateText of [
    "private-tool-id",
    "private-prompt",
    "privateWorkflow",
    png.toString("base64"),
  ])
    expect(summary).not.toContain(privateText);
  const promptUrl = `http://localhost:3100/api/conversation/image-jobs/${job.id}/prompt`;
  const promptResponse = await app.request(promptUrl);
  expect(promptResponse.headers.get("cache-control")).toBe("no-store");
  expect(await promptResponse.json()).toEqual({
    positivePrompt: "private-prompt",
    negativePrompt: "fictional negative",
    faceGuidance: "fictional face guidance",
    faceNegativePrompt: "fictional face negative",
    framing: "selfie",
    sceneTags: ["fictional outfit"],
    seed: 1,
  });
  for (const headers of [
    new Headers({ Origin: "https://untrusted.example" }),
    new Headers({ "Sec-Fetch-Site": "cross-site" }),
  ])
    expect((await app.request(promptUrl, { headers })).status).toBe(403);
  expect((await app.request(promptUrl.replace("localhost:3100", "untrusted.example"))).status).toBe(
    403,
  );
  expect(
    (await app.request("http://localhost:3100/api/conversation/image-jobs/not-a-job/prompt"))
      .status,
  ).toBe(404);
  expect(
    (
      await app.request(
        `http://localhost:3100/api/conversation/image-jobs/${crypto.randomUUID()}/prompt`,
      )
    ).status,
  ).toBe(404);
});

test("private previews return only ready image bytes with the existing access protections", async () => {
  const store = openStore(":memory:");
  stores.push(store);
  const conversations = createConversationService(store);
  conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "123",
        senderId: "123",
        text: "A fictional dot",
        images: [
          {
            fileId: "private-file-reference",
            fileUniqueId: "private-unique-reference",
            mimeType: "image/png",
          },
        ],
      },
    ],
  });
  const attachment = conversations.claimAttachmentDownload();
  if (!attachment) throw new Error("Fixture attachment was not queued.");
  const app = createApp(store, loadConfig({}), {});
  const url = `http://localhost:3100/api/conversation/attachments/${attachment.id}`;
  expect((await app.request(url)).status).toBe(404);
  conversations.saveAttachment(attachment.id, { bytes: png });
  const response = await app.request(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect(
    (await app.request(url, { headers: { Origin: "https://untrusted.example" } })).status,
  ).toBe(403);
  expect((await app.request(url, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(
    403,
  );
  expect(
    (await app.request(`http://untrusted.example/api/conversation/attachments/${attachment.id}`))
      .status,
  ).toBe(403);
  expect(
    (await app.request("http://localhost:3100/api/conversation/attachments/../../etc/passwd"))
      .status,
  ).toBe(404);
  const summary = await (await app.request("http://localhost:3100/api/conversation")).text();
  expect(summary).toContain(attachment.id);
  expect(summary).not.toContain("private-file-reference");
  expect(summary).not.toContain("private-unique-reference");
  expect(summary).not.toContain(png.toString("base64"));
});
