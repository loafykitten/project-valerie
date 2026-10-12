import { createHash } from "node:crypto";
import {
  type CheckinCandidate,
  type CheckinContext,
  type CheckinQuestion,
  calculateCheckinWindow,
  createAgreementService,
  createConversationService,
  createDailyService,
  createDynamicService,
  createPromptService,
  createReminderService,
  type ReminderService,
  type ScheduledClaim,
  type Store,
} from "@valerie/core";
import type { Transport } from "@valerie/inference";
import {
  createScheduledGenerator,
  type ScheduledGeneration,
  type ScheduledSnapshot,
} from "./generation";

export interface ScheduledBinding {
  service: ReminderService;
  capture(claim: ScheduledClaim): ScheduledSnapshot;
  generate(snapshot: ScheduledSnapshot, signal: AbortSignal): Promise<ScheduledGeneration>;
  synchronize(chatId: string): void;
  stillCurrent?(claim: ScheduledClaim): boolean;
}

/** Read evidence and derive optional candidates; no timer or transport is created here. */
export function createScheduledRuntime(
  store: Store,
  apiKey: string,
  options: { now?: () => Date; transport?: Transport } = {},
): ScheduledBinding {
  const now = options.now ?? (() => new Date()),
    daily = createDailyService(store, { now }),
    agreements = createAgreementService(store, { now }),
    focus = createDynamicService(store, { now });
  const conversations = createConversationService(store, { now }),
    prompts = createPromptService(store);
  const latest = (chatId: string) =>
    store.db
      .query<{ turnId: string; watermark: number }, [string]>(
        "SELECT turn_id AS turnId,rowid AS watermark FROM core_telegram_inputs WHERE chat_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(chatId);
  const priorQuestions = (chatId: string) =>
    store.db
      .query<{ key: string; habitId: string | null; at: string }, [string]>(`
    SELECT json_extract(question.value,'$.key') AS key,json_extract(question.value,'$.habitId') AS habitId,coalesce(sent.delivered_at,sent.updated_at) AS at
    FROM (SELECT checkin_json,delivered_at,updated_at FROM core_scheduled_occurrences
      WHERE chat_id=? AND kind='checkin' AND (telegram_message_id IS NOT NULL OR status='unknown')
      ORDER BY created_at DESC LIMIT 180) sent,json_each(sent.checkin_json,'$.questions') question
    LIMIT 540
  `)
      .all(chatId);
  const focusAlreadyOffered = (chatId: string, key: string) =>
    Boolean(
      store.db
        .query<{ found: number }, [string, string]>(`
    SELECT 1 AS found FROM core_scheduled_occurrences sent,json_each(sent.checkin_json,'$.questionKeys') question
    WHERE sent.chat_id=? AND sent.kind='checkin' AND (sent.telegram_message_id IS NOT NULL OR sent.status='unknown')
      AND question.value=? LIMIT 1
  `)
        .get(chatId, key),
    );
  function readState(chatId: string) {
    return store.db.transaction(() => {
      const owner = latest(chatId),
        snapshot = daily.capture({ turnId: owner?.turnId }),
        agreement = agreements.capture({ turnId: owner?.turnId }),
        growth = focus.current({ turnId: owner?.turnId });
      const focusRevision = growth
        ? `${growth.id}:${growth.version}:${growth.phase}:${Number(growth.reviewDue)}`
        : "none";
      const prompt = prompts.compose("telegram-text", {
        habitCheckin: true,
        agreements: true,
        growthFocus: Boolean(growth),
      });
      const preparationProfile = JSON.stringify({
        focusRevision,
        promptVersions: prompt.versions,
        promptOrderVersion: prompt.orderVersion,
        characterImportId: prompt.characterImportId,
        inferenceVersion: conversations.getSettings().version,
      });
      const agreementRevision = `${agreement.revision}:${createHash("sha256").update(preparationProfile).digest("hex").slice(0, 16)}`;
      const settings = service.getCheckinSettings(),
        day = owner ? daily.currentDay(owner.turnId) : null;
      const candidates: CheckinCandidate[] = [];
      if (settings.enabled && day && owner) {
        const asked = priorQuestions(chatId),
          habitLast = new Map<string, string>();
        for (const item of asked)
          if (item.habitId && (habitLast.get(item.habitId) ?? "") < item.at)
            habitLast.set(item.habitId, item.at);
        for (const slot of ["morning", "evening"] as const) {
          const window = calculateCheckinWindow(day, slot, {
            now: now(),
            inputWatermark: owner.watermark,
          });
          if (!window) continue;
          const selected = agreements
            .questions(day.id, slot)
            .sort(
              (a, b) =>
                (habitLast.get(a.habitId) ?? "").localeCompare(habitLast.get(b.habitId) ?? "") ||
                a.habitId.localeCompare(b.habitId),
            );
          const questions: CheckinQuestion[] = selected.slice(0, 2).map((item) => ({
            key: item.key,
            title: item.name,
            detail:
              slot === "morning"
                ? "Ask briefly what would help with the agreed practice this waking day; avoid treating an unreported action as a failure."
                : "Ask briefly how the agreed practice went, with room for a smaller version or an honest difficult day.",
            habitId: item.habitId,
            habitVersion: item.definitionVersion,
          }));
          if (slot === "morning" && growth?.phase === "active" && growth.reviewDue) {
            const key = `focus:${growth.id}:review:${growth.reviewDate}:${growth.version}`;
            // Confirmed/unknown prior delivery means the review was already offered,
            // not that it was completed. Do not ask again daily for the same version.
            if (!focusAlreadyOffered(chatId, key))
              questions.splice(0, 0, {
                key,
                title: growth.title,
                detail:
                  "Offer a brief review of whether this Growth Focus still fits. Its review date does not mean it is solved or must change.",
              });
          }
          if (!questions.length) continue;
          const dueAt =
            slot === "morning"
              ? new Date(
                  Date.parse(day.wakeReceivedAt as string) + settings.morningDelayMinutes * 60000,
                ).toISOString()
              : new Date(
                  Date.parse(day.expectedSleepAt as string) - settings.eveningLeadMinutes * 60000,
                ).toISOString();
          const earliestAt = slot === "morning" ? dueAt : window.earliestAt;
          if (dueAt >= window.expiresAt) continue;
          candidates.push({
            dayId: day.id,
            slots: [slot],
            questions: questions.slice(0, 2),
            dailyRevision: snapshot.revision,
            agreementRevision,
            inputWatermark: owner.watermark,
            dueAt,
            earliestAt,
            expiresAt: window.expiresAt,
            timezone: day.wakeTime.timezone,
          });
        }
        if (candidates.length === 2) {
          const a = candidates[0],
            b = candidates[1];
          if (
            a &&
            b &&
            a.expiresAt === b.expiresAt &&
            a.dueAt >= b.earliestAt &&
            b.dueAt >= a.earliestAt &&
            a.dueAt < b.expiresAt &&
            b.dueAt < a.expiresAt
          ) {
            const byKey = new Map(
              [...a.questions, ...b.questions].map((question) => [question.key, question]),
            );
            candidates.splice(0, 2, {
              ...a,
              slots: ["morning", "evening"],
              questions: [...byKey.values()].slice(0, 2),
              dueAt: a.dueAt > b.dueAt ? a.dueAt : b.dueAt,
              earliestAt: a.earliestAt > b.earliestAt ? a.earliestAt : b.earliestAt,
              expiresAt: a.expiresAt < b.expiresAt ? a.expiresAt : b.expiresAt,
            });
          }
        }
      }
      return {
        dailyRevision: snapshot.revision,
        agreementRevision,
        inputWatermark: owner?.watermark ?? 0,
        candidates,
      };
    })();
  }
  const isCurrent = (context: CheckinContext) => {
    const anchor = store.db
      .query<{ chatId: string }, [number]>(
        "SELECT chat_id AS chatId FROM core_telegram_inputs WHERE rowid=?",
      )
      .get(context.inputWatermark);
    if (!anchor) return false;
    const state = readState(anchor.chatId);
    return (
      state.dailyRevision === context.dailyRevision &&
      state.agreementRevision === context.agreementRevision &&
      state.inputWatermark === context.inputWatermark &&
      context.slots.every((slot) =>
        state.candidates.some(
          (candidate) =>
            candidate.dayId === context.dayId &&
            candidate.slots.includes(slot) &&
            context.questionKeys.every((key) =>
              candidate.questions.some((question) => question.key === key),
            ),
        ),
      )
    );
  };
  const service = createReminderService(store, { now, isCheckinCurrent: isCurrent });
  const generator = createScheduledGenerator({ store, apiKey, now, transport: options.transport });
  return {
    service,
    capture: generator.capture,
    generate: generator.generate,
    stillCurrent: (claim) =>
      claim.kind === "explicit_reminder" || Boolean(claim.checkin && isCurrent(claim.checkin)),
    synchronize(chatId) {
      service.syncCheckins({ chatId, ...readState(chatId) });
    },
  };
}
