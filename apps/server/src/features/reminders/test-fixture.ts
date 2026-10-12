import {
  createAgreementService,
  createConversationService,
  createDailyService,
  createPromptService,
  createReminderService,
  openStore,
  type ReminderFields,
  type TelegramSourceMetadata,
} from "@valerie/core";
import type { NeuralwattModel, TextCompletion } from "@valerie/inference";

export const fictionalModel: NeuralwattModel = {
  id: "fictional-model",
  displayName: "Fictional model",
  maxContextTokens: 131072,
  maxOutputTokens: 8192,
  systemRole: true,
  reasoningEffort: false,
  deprecated: false,
  tools: true,
  vision: false,
  maxImages: null,
  reasoning: {
    mandatory: false,
    defaultEnabled: false,
    defaultEffort: null,
    supportedEfforts: [],
    acceptedEfforts: [],
    effortAliases: {},
  },
  pricing: {
    currency: "USD",
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
    pricingTbd: true,
  },
};
export const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fictional record.");
  return value;
};
export const completion = (
  text: string,
  changes: Partial<TextCompletion> = {},
): TextCompletion => ({
  text,
  complete: true,
  finishReason: "stop",
  requestId: "fictional-scheduled-receipt",
  costUsd: null,
  usage: { inputTokens: 40, outputTokens: 12 },
  ...changes,
});
export function scheduledFixture(at = "2026-09-15T18:00:00.000Z") {
  const store = openStore(":memory:");
  let clock = new Date(at),
    update = 0;
  const now = () => new Date(clock),
    conversations = createConversationService(store, { now }),
    reminders = createReminderService(store, { now }),
    daily = createDailyService(store, { now }),
    agreements = createAgreementService(store, { now }),
    prompts = createPromptService(store);
  conversations.saveSettings({
    ...conversations.getSettings(),
    expectedVersion: conversations.getSettings().version,
    model: fictionalModel.id,
    modelCapabilities: fictionalModel,
    modelContextTokens: 131072,
    modelMaxOutputTokens: 8192,
    maxOutputTokens: 4096,
    reasoningEffort: null,
  });
  const accept = (
    text: string,
    extra: {
      chatId?: string;
      metadata?: TelegramSourceMetadata;
      receivedAt?: string;
      mediaGroupId?: string;
    } = {},
  ) => {
    const updateId = ++update,
      chatId = extra.chatId ?? "42";
    conversations.acceptTelegramBatch({
      nextOffset: updateId + 1,
      inputs: [
        {
          updateId,
          messageId: String(updateId),
          chatId,
          senderId: chatId,
          text,
          mediaGroupId: extra.mediaGroupId,
          receivedAt: extra.receivedAt ?? now().toISOString(),
          sourceMetadata: extra.metadata ?? {
            version: 1,
            provenance: "original",
            quotedRanges: [],
            replyQuote: null,
            incomplete: false,
          },
        },
      ],
    });
    const row = required(
      store.db
        .query<{ id: string; turnId: string }, [number]>(
          "SELECT id,turn_id AS turnId FROM core_telegram_inputs WHERE update_id=?",
        )
        .get(updateId),
    );
    return { ...row, sourceId: `conversation:${row.id}` };
  };
  const fields = (changes: Partial<ReminderFields> = {}): ReminderFields => ({
    title: "Water the fictional fern",
    purpose: "A little water for the fern.",
    dueAt: now().toISOString(),
    timezone: "America/Chicago",
    originalTimeIntent: "Now",
    expiresAt: null,
    allowFallback: true,
    ...changes,
  });
  const reply = (text = "A fictional earlier direct reply.") => {
    const turn = required(conversations.startNextTurn());
    conversations.completeGeneration(turn.id, completion(text));
    const delivery = required(conversations.claimDelivery());
    conversations.recordDelivery(delivery.id, { status: "sent", messageId: String(2000 + update) });
    return turn;
  };
  return {
    store,
    now,
    conversations,
    reminders,
    daily,
    agreements,
    prompts,
    accept,
    fields,
    reply,
    set: (at: string) => {
      clock = new Date(at);
    },
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
