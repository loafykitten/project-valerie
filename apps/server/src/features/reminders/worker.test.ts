import { afterEach, expect, test } from "bun:test";
import type { CheckinCandidate, Store } from "@valerie/core";
import type { TextCompletion } from "@valerie/inference";
import { TelegramError, type TelegramTransport, type TelegramUpdate } from "../telegram/transport";
import { startTelegramWorker, type TelegramWorker } from "../telegram/worker";
import type { ScheduledGeneration, ScheduledSnapshot } from "./generation";
import { completion, required, scheduledFixture } from "./test-fixture";

const workers: TelegramWorker[] = [],
  stores: Store[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const store of stores.splice(0)) store.close();
});
async function until(check: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Scheduled worker fixture did not reach the expected state.");
}
const speak = (text = "Your fern is ready for a little water."): ScheduledGeneration => ({
  decision: "speak",
  text,
  completion: completion(text),
});
function fixture() {
  const f = scheduledFixture(new Date().toISOString());
  stores.push(f.store);
  const sent: string[] = [];
  let releasePoll: ((updates: TelegramUpdate[]) => void) | undefined;
  const start = (
    options: {
      generate?: () => Promise<TextCompletion>;
      scheduled?: (snapshot: ScheduledSnapshot) => Promise<ScheduledGeneration>;
      send?: TelegramTransport["sendMessage"];
    } = {},
  ) => {
    const worker = startTelegramWorker({
      store: f.store,
      token: "123:fictional",
      ownerUserId: "42",
      idleMs: 1,
      schedulerTickMs: 2,
      transport: {
        inspect: async () => ({ botId: "123", webhookActive: false }),
        getUpdates: () =>
          new Promise((resolve) => {
            releasePoll = resolve;
          }),
        downloadImage: async () => {
          throw new TelegramError("rejected", true);
        },
        sendMessage: async (input) => {
          sent.push(input.text);
          return options.send ? options.send(input) : { messageId: String(800 + sent.length) };
        },
      },
      generate: options.generate ?? (async () => completion("A normal direct reply.")),
      reminders: {
        service: f.reminders,
        capture: (claim) =>
          ({
            kind: "scheduled",
            occurrenceId: claim.id,
            occurrenceKind: claim.kind,
            fence: claim.fence,
          }) as ScheduledSnapshot,
        generate: options.scheduled ?? (async () => speak()),
        synchronize: () => {},
      },
    });
    workers.push(worker);
    return worker;
  };
  const optional = () => {
    f.accept("Good morning. A small creative practice might be nice later.");
    f.reply();
    const day = required(
      f.daily.recordWakingReport(
        {
          report: "day_start",
          mode: "current",
          expectedCurrentDayId: null,
          expectedDayVersion: null,
          occurred: {
            at: f.now().toISOString(),
            timezone: "America/Chicago",
            basis: "message_time",
          },
          summary: "A fictional waking day.",
        },
        { actor: "owner" },
      ).day,
    );
    f.reminders.saveCheckinSettings({
      ...f.reminders.getCheckinSettings(),
      expectedVersion: f.reminders.getCheckinSettings().version,
      enabled: true,
      minIdleMinutes: 0,
    });
    const watermark = required(
      f.store.db
        .query<{ value: number }, []>("SELECT max(rowid) AS value FROM core_telegram_inputs")
        .get(),
    ).value;
    const candidate: CheckinCandidate = {
      dayId: day.id,
      slots: ["morning"],
      questions: [
        { key: "habit:fictional", title: "Creative time", detail: "A brief invitation." },
      ],
      dailyRevision: f.daily.capture().revision,
      agreementRevision: "fixture:1",
      inputWatermark: watermark,
      dueAt: f.now().toISOString(),
      earliestAt: f.now().toISOString(),
      expiresAt: new Date(f.now().getTime() + 3600000).toISOString(),
      timezone: "America/Chicago",
    };
    f.reminders.syncCheckins({
      chatId: "42",
      candidates: [candidate],
      dailyRevision: candidate.dailyRevision,
      agreementRevision: candidate.agreementRevision,
      inputWatermark: watermark,
    });
    return required(f.reminders.listOccurrences().find((item) => item.kind === "checkin"));
  };
  const incoming = async (text: string, updateId = 2) => {
    await until(() => Boolean(releasePoll));
    releasePoll?.([
      {
        update_id: updateId,
        message: {
          message_id: updateId,
          text,
          from: { id: 42, is_bot: false },
          chat: { id: 42, type: "private" },
        },
      },
    ]);
    releasePoll = undefined;
  };
  return { ...f, start, sent, optional, incoming };
}

test("two due reminders send while ordinary inference is held, then direct replies retain order", async () => {
  const f = fixture();
  f.accept("First fictional question.");
  const reminders = ["Water the fictional fern", "Put away the fictional pencils"].map((title) =>
    f.reminders.saveReminder(f.fields({ title }), { actor: "owner" }),
  );
  let release: ((result: TextCompletion) => void) | undefined,
    ordinaryCalls = 0;
  f.start({
    generate: () => {
      ordinaryCalls++;
      return ordinaryCalls === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(completion("Second direct reply."));
    },
  });
  await until(() => Boolean(release) && f.sent.length === 2);
  expect(ordinaryCalls).toBe(1);
  for (const reminder of reminders)
    expect(f.reminders.readOccurrence(reminder.currentOccurrenceId)?.status).toBe("sent");
  await f.incoming("Second fictional question.");
  await until(
    () =>
      f.store.db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM core_telegram_inputs")
        .get()?.count === 2,
  );
  expect(ordinaryCalls).toBe(1);
  release?.(completion("First direct reply."));
  await until(() => f.sent.length === 4);
  expect(f.sent.slice(2)).toEqual(["First direct reply.", "Second direct reply."]);
});

test("slow optional preparation cannot block an explicit due reminder", async () => {
  const f = fixture(),
    optional = f.optional();
  let release: ((result: ScheduledGeneration) => void) | undefined;
  f.start({
    scheduled: (snapshot) =>
      snapshot.occurrenceKind === "checkin"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(speak()),
  });
  await until(() => Boolean(release));
  const reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" });
  await until(() => f.reminders.readOccurrence(reminder.currentOccurrenceId)?.status === "sent");
  expect(f.sent).toHaveLength(1);
  expect(f.reminders.readOccurrence(optional.id)?.status).toBe("generating");
  release?.(speak("A brief optional creative invitation."));
  await until(() => f.reminders.readOccurrence(optional.id)?.status === "sent");
  expect(f.sent).toHaveLength(2);
});

test("new owner input suppresses optional preparation but preserves an explicit commitment and late usage", async () => {
  const f = fixture(),
    optional = f.optional();
  const reminder = f.reminders.saveReminder(
    f.fields({ dueAt: new Date(f.now().getTime() + 30000).toISOString(), allowFallback: false }),
    { actor: "owner" },
  );
  const releases = new Map<string, (result: ScheduledGeneration) => void>();
  f.start({
    scheduled: (snapshot) =>
      new Promise((resolve) => {
        releases.set(snapshot.occurrenceKind, resolve);
      }),
  });
  await until(() => releases.size === 2);
  await f.incoming("I already did the creative practice, and I have a question.");
  await until(() => f.sent.includes("A normal direct reply."));
  releases.get("checkin")?.(speak("An outdated check-in."));
  releases.get("explicit_reminder")?.(speak("Your requested fern reminder."));
  await until(
    () =>
      f.reminders.generationReceipts(optional.id)[0]?.result != null &&
      f.reminders.readOccurrence(reminder.currentOccurrenceId)?.status === "prepared",
  );
  f.advance(31000);
  await until(() => f.reminders.readOccurrence(reminder.currentOccurrenceId)?.status === "sent");
  expect(f.sent).toEqual(["A normal direct reply.", "Your requested fern reminder."]);
  expect(f.reminders.readOccurrence(optional.id)?.status).toBe("suppressed");
  expect(f.reminders.generationReceipts(optional.id)[0]?.result).toMatchObject({
    requestId: "fictional-scheduled-receipt",
  });
});

test("cancelling during preparation retains the late result without reviving or sending the task", async () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(
      f.fields({ dueAt: new Date(f.now().getTime() + 30000).toISOString(), allowFallback: false }),
      { actor: "owner" },
    );
  let release: ((result: ScheduledGeneration) => void) | undefined;
  f.start({
    scheduled: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await until(() => Boolean(release));
  f.reminders.cancel({ id: reminder.id, expectedVersion: reminder.version }, { actor: "owner" });
  f.advance(31000);
  release?.(speak("An outdated fern reminder."));
  await until(
    () => f.reminders.generationReceipts(reminder.currentOccurrenceId)[0]?.result != null,
  );
  expect(f.reminders.readOccurrence(reminder.currentOccurrenceId)?.status).toBe("cancelled");
  expect(f.reminders.read(reminder.id)?.state).toBe("cancelled");
  expect(f.sent).toHaveLength(0);
});

test("an interrupted scheduled send becomes unknown and is not replayed after restart", async () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" });
  const worker = f.start({ send: () => new Promise(() => {}) });
  await until(() => f.reminders.readOccurrence(reminder.currentOccurrenceId)?.status === "sending");
  await worker.stop();
  expect(f.reminders.readOccurrence(reminder.currentOccurrenceId)?.status).toBe("unknown");
  const next = f.start();
  await until(() => next.status().scheduled?.lastTickAt != null);
  expect(f.sent).toHaveLength(1);
  expect(f.reminders.read(reminder.id)?.state).toBe("active");
  expect(
    f.store.db.query("SELECT id FROM core_conversation_search WHERE id LIKE 'scheduled:%'").all(),
  ).toHaveLength(0);
});

test("a confirmed send after lease replacement is retained as evidence without reactivating a cancelled parent", async () => {
  const f = fixture(),
    reminder = f.reminders.saveReminder(f.fields(), { actor: "owner" });
  let release: ((receipt: { messageId: string }) => void) | undefined;
  const worker = f.start({
    send: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await until(() => Boolean(release));
  f.reminders.cancel({ id: reminder.id, expectedVersion: reminder.version }, { actor: "owner" });
  f.store.db
    .query("UPDATE core_telegram_state SET lease_owner='replacement' WHERE singleton=1")
    .run();
  f.reminders.recoverInterrupted("replacement");
  release?.({ messageId: "987" });
  await until(() => worker.status().state === "failed");
  expect(f.reminders.readOccurrence(reminder.currentOccurrenceId)).toMatchObject({
    status: "sent",
    telegramMessageId: "987",
  });
  expect(f.reminders.read(reminder.id)?.state).toBe("cancelled");
  expect(
    f.store.db.query("SELECT role FROM core_conversation_search WHERE id LIKE 'scheduled:%'").all(),
  ).toEqual([{ role: "assistant" }]);
});
