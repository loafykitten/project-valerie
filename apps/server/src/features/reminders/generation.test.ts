import { afterEach, expect, test } from "bun:test";
import { CHECKIN_SILENT_MARKER, type Store } from "@valerie/core";
import { createScheduledGenerator, validateScheduledCompletion } from "./generation";
import { completion, required, scheduledFixture } from "./test-fixture";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const f = scheduledFixture();
  stores.push(f.store);
  f.conversations.acquireTelegramLease("fixture", "2026-09-16T18:00:00.000Z");
  const reminder = f.reminders.saveReminder(f.fields({ dueAt: "2026-09-15T18:00:30.000Z" }), {
    actor: "owner",
  });
  const claim = required(f.reminders.claimPreparation({ chatId: "42", leaseOwner: "fixture" }));
  return { ...f, reminder, claim };
}

test("explicit generation keeps its pinned voice and purpose, uses no tools, and retains the exact receipt", async () => {
  const f = fixture();
  f.accept("I made a little fictional lantern.");
  f.reply("Your lantern sounds lovely.");
  const text = "A little nudge, Ember: your fern is ready for its water.";
  let requests = 0;
  const generator = createScheduledGenerator({
    store: f.store,
    apiKey: "fictional",
    now: f.now,
    transport: async (_url, request) => {
      requests++;
      const body = JSON.parse(String(request.body));
      expect(body.model).toBe("fictional-model");
      expect(body.max_tokens).toBe(4096);
      expect(body.tools).toBeUndefined();
      const messages = JSON.stringify(body.messages);
      expect(messages).toContain("Water the fictional fern");
      expect(messages).toContain("Your lantern sounds lovely.");
      expect(messages).not.toContain("A later voice revision");
      return Response.json(
        {
          choices: [{ message: { content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 84, completion_tokens: 15 },
        },
        { headers: { "x-request-id": "fictional-reminder-request" } },
      );
    },
  });
  const snapshot = generator.capture(f.claim),
    before = JSON.stringify(snapshot);
  expect(snapshot.prompt.versions.reminders).toBe(1);
  expect(snapshot.prompt.versions.habits).toBeUndefined();
  f.prompts.update("voice", { content: "A later voice revision", expectedVersion: 1 });
  f.conversations.saveSettings({
    ...f.conversations.getSettings(),
    expectedVersion: f.conversations.getSettings().version,
    temperature: 0.3,
  });
  const generated = await generator.generate(snapshot, new AbortController().signal);
  expect(generated).toMatchObject({
    decision: "speak",
    text,
    completion: {
      requestId: "fictional-reminder-request",
      usage: { inputTokens: 84, outputTokens: 15 },
    },
  });
  expect(requests).toBe(1);
  expect(JSON.stringify(snapshot)).toBe(before);
  expect(f.store.db.query("SELECT count(*) AS count FROM core_telegram_inputs").get()).toEqual({
    count: 1,
  });
});

test("only optional check-ins may be silent; partial and structured output never becomes a message", () => {
  const f = fixture(),
    generator = createScheduledGenerator({ store: f.store, apiKey: "fictional", now: f.now });
  const explicit = generator.capture(f.claim),
    optional = { ...explicit, occurrenceKind: "checkin" as const, maxMessageChars: 480 };
  expect(validateScheduledCompletion(optional, completion(CHECKIN_SILENT_MARKER)).decision).toBe(
    "silent",
  );
  expect(validateScheduledCompletion(explicit, completion(CHECKIN_SILENT_MARKER)).decision).toBe(
    "rejected",
  );
  for (const text of [
    '{"text":"Hi"',
    "```text\nHi\n```",
    "decision: speak\ntext: hello",
    "[[HEARTBEAT_SILENT]]",
    "x".repeat(481),
  ])
    expect(validateScheduledCompletion(optional, completion(text)).decision).toBe("rejected");
  expect(
    validateScheduledCompletion(
      optional,
      completion("A cut-off answer", { complete: false, finishReason: "length" }),
    ).decision,
  ).toBe("rejected");
  expect(validateScheduledCompletion(optional, completion("*smiles warmly*"))).toMatchObject({
    decision: "speak",
    text: "*smiles warmly*",
  });
});

test("scheduled history preserves quote provenance and explicitly omits image pixels", () => {
  const f = fixture();
  f.conversations.acceptTelegramBatch({
    nextOffset: 2,
    inputs: [
      {
        updateId: 1,
        messageId: "1",
        chatId: "42",
        senderId: "42",
        text: "A caption with a quoted greeting: Good morning",
        receivedAt: f.now().toISOString(),
        images: [{ fileId: "fictional-file-secret", fileUniqueId: "fictional-unique-secret" }],
        sourceMetadata: {
          version: 1,
          provenance: "forwarded",
          quotedRanges: [{ offset: 32, length: 12 }],
          replyQuote: null,
          incomplete: false,
        },
      },
    ],
  });
  const snapshot = createScheduledGenerator({
    store: f.store,
    apiKey: "fictional",
    now: f.now,
  }).capture(f.claim);
  const contents = JSON.stringify(snapshot.messages);
  expect(contents).toContain("forwarded");
  expect(contents).toContain("quotedRanges");
  expect(contents).toContain("No images are included");
  expect(contents).toContain("contents are unavailable");
  expect(contents).not.toContain("fictional-file-secret");
  expect(contents).not.toContain("fictional-unique-secret");
  expect(snapshot.history.omissionReasons).toContain("media_limit");
});

test("check-ins retain Rules guidance and an explicit empty-current-rules state after expiry", () => {
  const f = scheduledFixture();
  stores.push(f.store);
  f.conversations.acquireTelegramLease("fixture", "2026-09-16T18:00:00.000Z");
  f.accept("Good morning.");
  f.reply();
  const day = required(
    f.daily.recordWakingReport(
      {
        report: "day_start",
        mode: "current",
        expectedCurrentDayId: null,
        expectedDayVersion: null,
        occurred: { at: f.now().toISOString(), timezone: "America/Chicago", basis: "message_time" },
        summary: "A fictional day starts.",
      },
      { actor: "owner" },
    ).day,
  );
  f.agreements.saveRule(
    {
      name: "A brief fictional rule",
      meaning: "Pause the fictional game briefly.",
      reason: "A short break.",
      scope: "The fictional game.",
      effectiveAt: f.now().toISOString(),
      expiresAt: "2026-09-15T18:00:01.000Z",
      timezone: "America/Chicago",
      window: null,
      exceptions: [],
      condition: null,
    },
    { actor: "owner" },
  );
  f.advance(2000);
  f.reminders.saveCheckinSettings({
    ...f.reminders.getCheckinSettings(),
    expectedVersion: f.reminders.getCheckinSettings().version,
    enabled: true,
    minIdleMinutes: 0,
  });
  const revisions = {
    dailyRevision: f.daily.capture().revision,
    agreementRevision: f.agreements.capture().revision,
    inputWatermark: 1,
  };
  f.reminders.syncCheckins({
    chatId: "42",
    ...revisions,
    candidates: [
      {
        ...revisions,
        dayId: day.id,
        slots: ["morning"],
        questions: [
          { key: "fictional", title: "A creative practice", detail: "A brief invitation." },
        ],
        dueAt: f.now().toISOString(),
        earliestAt: f.now().toISOString(),
        expiresAt: "2026-09-15T19:00:00.000Z",
        timezone: "America/Chicago",
      },
    ],
  });
  const claim = required(
    f.reminders.claimPreparation({ chatId: "42", leaseOwner: "fixture", kind: "checkin" }),
  );
  const snapshot = createScheduledGenerator({
    store: f.store,
    apiKey: "fictional",
    now: f.now,
  }).capture(claim);
  expect(snapshot.prompt.versions.rules).toBe(1);
  expect(snapshot.prompt.versions.habits).toBe(1);
  expect(JSON.stringify(snapshot.messages)).toContain("Currently applicable saved Rules: []");
  expect(JSON.stringify(snapshot.messages)).not.toContain("Pause the fictional game briefly");
});
