import { createHash } from "node:crypto";
import type { Store } from "../../store";
import { createActivityService } from "../activity/service";
import { createAgreementService } from "../dynamic/agreements";
import type { AgreementSnapshot } from "../dynamic/agreements-types";
import { createDailyService } from "../dynamic/daily";
import type { DailySnapshot } from "../dynamic/daily-types";
import { createDynamicService } from "../dynamic/service";
import type { DynamicSnapshot } from "../dynamic/types";
import { createMemoryService } from "../memory/service";
import type { MemorySnapshot } from "../memory/types";
import { createPromptService, type PromptService, type PromptSnapshot } from "../prompts/service";
import { createReminderService } from "../reminders/service";
import type { ReminderPermissions } from "../reminders/types";
import {
  type ConversationToolCapabilities,
  type ConversationToolCatalog,
  validateConversationToolCatalog,
} from "../tools/catalog";
import { validateGenerationReceipt } from "./generation-receipt";
import {
  IMAGE_TOKEN_ALLOWANCE,
  type ImageMimeType,
  inspectImageBytes,
  MAX_CONTEXT_IMAGE_BYTES,
  MAX_CONTEXT_IMAGES,
  MAX_CURRENT_IMAGES,
  MAX_HISTORY_IMAGES,
  MAX_IMAGE_BYTES,
} from "./images";
import {
  readTelegramSourceMetadata,
  type TelegramSourceMetadata,
  validateTelegramSourceMetadata,
} from "./provenance";

const conversationClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  dateStyle: "full",
  timeStyle: "long",
});
const localTime = (timestamp: string) => conversationClock.format(new Date(timestamp));

export type InferenceReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** A provider-neutral persisted copy of the discovered model contract. */
export interface InferenceModelCapabilities {
  id: string;
  displayName: string;
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
  systemRole: boolean;
  reasoningEffort: boolean;
  deprecated: boolean;
  vision?: boolean;
  tools?: boolean;
  maxImages?: number | null;
  reasoning: {
    mandatory: boolean;
    defaultEnabled: boolean;
    defaultEffort: InferenceReasoningEffort | null;
    supportedEfforts: InferenceReasoningEffort[];
    acceptedEfforts: InferenceReasoningEffort[];
    effortAliases: Partial<Record<InferenceReasoningEffort, InferenceReasoningEffort>>;
  } | null;
  pricing: {
    currency: "USD" | null;
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    cachedInputPerMillion: number | null;
    pricingTbd: boolean;
  };
}

export interface InferenceSettings {
  version: number;
  model: string;
  maxOutputTokens: number;
  contextTokens: number;
  historyTokens: number;
  historyHours: number;
  temperature: number | null;
  reasoningEffort: string | null;
  modelContextTokens: number;
  modelMaxOutputTokens: number;
  capabilityCheckedAt: string | null;
  modelCapabilities: InferenceModelCapabilities | null;
  updatedAt: string;
}

export type InferenceSettingsInput = Omit<InferenceSettings, "version" | "updatedAt"> & {
  expectedVersion: number;
};

export class InferenceSettingsConflictError extends Error {
  constructor() {
    super("Inference settings changed. Reload before saving.");
    this.name = "InferenceSettingsConflictError";
  }
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string | ConversationContentPart[];
}

export type ConversationContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      attachmentId: string;
      sha256: string;
      mimeType: ImageMimeType;
    };

export interface ConversationInputSource {
  id: string;
  receivedAt: string;
  sourceMetadata: TelegramSourceMetadata | null;
}

export interface ConversationSnapshot {
  capturedAt: string;
  imageGenerationEnabled?: boolean;
  memoryToolsEnabled?: boolean;
  dynamicToolsEnabled?: boolean;
  dailyToolsEnabled?: boolean;
  agreementToolsEnabled?: boolean;
  reminderToolsEnabled?: boolean;
  toolCatalog?: ConversationToolCatalog;
  dynamic?: DynamicSnapshot;
  daily?: DailySnapshot;
  agreements?: AgreementSnapshot;
  reminders?: {
    permissions: ReminderPermissions;
    settingsVersion: number;
    replyTarget?: {
      matchedDelivery: {
        occurrenceId: string;
        reminderVersion: number | null;
        telegramMessageId: string | null;
        deliveredAt: string | null;
        title: string;
        purpose: string;
      };
      currentReminder: {
        id: string;
        version: number;
        state: string;
        title: string;
        purpose: string;
        currentOccurrenceId: string;
        dueAt: string;
        timezone: string;
      };
      /** Textual changes, not an automatic judgment that the task's meaning changed. */
      purposeChanged: boolean;
      titleChanged: boolean;
    };
  };
  memory?: MemorySnapshot;
  settings: InferenceSettings;
  prompt: PromptSnapshot;
  messages: ConversationMessage[];
  inputSources?: ConversationInputSource[];
  contextBudget?: {
    contextUnits: number;
    outputReserveUnits: number;
    safetyReserveUnits: number;
    toolReserveUnits: number;
    requiredUnits: number;
  };
  history: {
    estimator: "utf8-byte-upper-bound" | "utf8-byte-upper-bound-plus-image-allowance";
    includedTurns: number;
    includedHeartbeats?: number;
    includedScheduled?: number;
    estimatedTokens: number;
    budgetTokens: number;
    since: string;
    truncated: boolean;
    omissionReasons?: string[];
    includedImages?: number;
    omittedImages?: number;
    imageTokenAllowance?: number;
  };
}

export interface TelegramInput {
  updateId: number;
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  receivedAt?: string;
  images?: TelegramImageInput[];
  mediaGroupId?: string;
  rejectionCode?: string;
  sourceMetadata?: TelegramSourceMetadata | null;
}

export interface TelegramImageInput {
  fileId: string;
  fileUniqueId: string;
  mimeType?: ImageMimeType;
  fileSize?: number;
  width?: number;
  height?: number;
}

export interface ConversationAttachmentSummary {
  id: string;
  status: "pending" | "downloading" | "retry" | "ready" | "failed";
  mimeType: ImageMimeType | null;
  width: number | null;
  height: number | null;
  failureCode: string | null;
}

export interface AttachmentDownload {
  id: string;
  turnId: string;
  chatId: string;
  fileId: string;
  fileUniqueId: string;
  mimeType: ImageMimeType | null;
  fileSize: number | null;
  attempts: number;
}

export interface ArchivedAttachment {
  id: string;
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

export type ConversationTurnStatus =
  | "queued"
  | "generating"
  | "retry"
  | "generated"
  | "delivered"
  | "failed"
  | "unknown";

export interface ConversationTurn {
  id: string;
  chatId: string;
  inputMessageId: string;
  inputText: string;
  receivedAt: string;
  status: ConversationTurnStatus;
  snapshot: ConversationSnapshot;
  attempts: number;
}

export interface ConversationDelivery {
  id: string;
  turnId: string;
  chatId: string;
  text: string;
  sequence: number;
  attempts: number;
}

export interface ConversationGenerationResult {
  text: string;
  /** Common tier across requests; mixed or missing receipts remain unknown. */
  serviceTier?: "flex" | "standard" | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    reasoningTokens?: number | null;
  };
  finishReason?: string;
  requestId?: string | null;
  costUsd?: number | null;
}

export interface ConversationTurnSummary {
  id: string;
  inputText: string;
  outputText: string | null;
  inputTruncated: boolean;
  outputTruncated: boolean;
  status: ConversationTurnStatus;
  receivedAt: string;
  completedAt: string | null;
  canRetry: boolean;
  nextAttemptAt: string | null;
  attempts: number;
  failureCode: string | null;
  settingsVersion: number | null;
  historyTurns: number | null;
  attachments: ConversationAttachmentSummary[];
}

interface TurnRow {
  id: string;
  chatId: string;
  inputMessageId: string;
  inputText: string;
  receivedAt: string;
  status: ConversationTurnStatus;
  snapshotJson: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  albumReadyAt: string | null;
  mediaGroupId: string | null;
}

const turnColumns = `id, chat_id AS chatId, message_id AS inputMessageId, input_text AS inputText,
  received_at AS receivedAt, status, snapshot_json AS snapshotJson, attempts,
  next_attempt_at AS nextAttemptAt, album_ready_at AS albumReadyAt, media_group_id AS mediaGroupId`;
const encoder = new TextEncoder();
const messageCost = (message: ConversationMessage) =>
  16 +
  (typeof message.content === "string"
    ? encoder.encode(message.content).length
    : message.content.reduce(
        (sum, part) =>
          sum + (part.type === "text" ? encoder.encode(part.text).length : IMAGE_TOKEN_ALLOWANCE),
        0,
      ));
const validDate = (value: string) => Number.isFinite(Date.parse(value));
const safeCode = (value: string) => {
  if (!/^[a-z0-9_.-]{1,100}$/i.test(value)) throw new TypeError("A safe failure code is required.");
  return value;
};

function resultMetadata(result: ConversationGenerationResult) {
  if (
    result.serviceTier != null &&
    result.serviceTier !== "flex" &&
    result.serviceTier !== "standard"
  )
    throw new TypeError("Invalid inference service tier.");
  if (typeof result.text !== "string" || encoder.encode(result.text).length > 1024 * 1024)
    throw new TypeError("Generated text exceeds the supported bound.");
  validateGenerationReceipt(result);
  return {
    usage: result.usage ?? null,
    finishReason: result.finishReason ?? null,
    requestId: result.requestId ?? null,
    costUsd: result.costUsd ?? null,
    serviceTier: result.serviceTier ?? null,
  };
}

function validateSettings(input: InferenceSettingsInput): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new TypeError("A positive expectedVersion is required.");
  if (typeof input.model !== "string" || input.model.length > 200 || /\s/.test(input.model))
    throw new TypeError("Model must be a provider model identifier.");
  for (const [key, value, min, max] of [
    ["maxOutputTokens", input.maxOutputTokens, 1, 1_000_000],
    ["contextTokens", input.contextTokens, 4096, 2_000_000],
    ["historyTokens", input.historyTokens, 0, 2_000_000],
    ["historyHours", input.historyHours, 1, 168],
    ["modelContextTokens", input.modelContextTokens, 4096, 2_000_000],
    ["modelMaxOutputTokens", input.modelMaxOutputTokens, 1, 1_000_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new TypeError(`${key} is outside the supported range.`);
  }
  if (input.contextTokens > input.modelContextTokens)
    throw new TypeError("Context budget exceeds the model context limit.");
  if (
    input.maxOutputTokens > input.modelMaxOutputTokens ||
    input.maxOutputTokens + 2048 >= input.contextTokens
  )
    throw new TypeError("Output budget must leave room for the input and fit the model limit.");
  if (
    input.temperature !== null &&
    (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)
  )
    throw new TypeError("Temperature must be null or between 0 and 2.");
  if (
    input.reasoningEffort !== null &&
    (typeof input.reasoningEffort !== "string" ||
      !/^[a-z0-9_-]{1,30}$/i.test(input.reasoningEffort))
  )
    throw new TypeError("Reasoning effort must be null or a provider-supported identifier.");
  if (input.capabilityCheckedAt !== null && !validDate(input.capabilityCheckedAt))
    throw new TypeError("Capability discovery date must be valid.");
  if (
    input.modelCapabilities !== null &&
    (input.modelCapabilities.id !== input.model ||
      !input.modelCapabilities.systemRole ||
      input.modelCapabilities.deprecated ||
      input.modelCapabilities.maxContextTokens !== input.modelContextTokens ||
      (input.modelCapabilities.maxOutputTokens !== null &&
        input.modelCapabilities.maxOutputTokens !== input.modelMaxOutputTokens))
  )
    throw new TypeError("Selected model capabilities do not match the saved model limits.");
}

export function createConversationService(
  store: Store,
  options: {
    prompts?: PromptService;
    now?: () => Date;
    imageGeneration?: boolean;
    memoryTools?: boolean;
    dynamicTools?: boolean;
    dailyTools?: boolean;
    agreementTools?: boolean;
    reminderTools?: boolean;
    captureToolCatalog?: (flags: ConversationToolCapabilities) => ConversationToolCatalog;
  } = {},
) {
  const { db } = store;
  const prompts = options.prompts ?? createPromptService(store);
  const activity = createActivityService(store);
  const memories = createMemoryService(store, { now: options.now });
  const dynamics = createDynamicService(store, { now: options.now });
  const dailyRecords = createDailyService(store, { now: options.now });
  const agreements = createAgreementService(store, { now: options.now });
  const reminders = createReminderService(store, { now: options.now });
  const now = () => (options.now?.() ?? new Date()).toISOString();
  db.transaction(() => {
    if (db.query("SELECT singleton FROM core_inference_settings WHERE singleton = 1").get()) return;
    const updatedAt = now();
    const initial: InferenceSettings = {
      version: 1,
      model: "",
      maxOutputTokens: 4096,
      contextTokens: 131072,
      historyTokens: 96000,
      historyHours: 48,
      temperature: null,
      reasoningEffort: null,
      modelContextTokens: 131072,
      modelMaxOutputTokens: 16384,
      capabilityCheckedAt: null,
      modelCapabilities: null,
      updatedAt,
    };
    const json = JSON.stringify(initial);
    db.query(
      "INSERT INTO core_inference_settings(singleton,version,settings_json,updated_at) VALUES (1,1,?,?)",
    ).run(json, updatedAt);
    db.query(
      "INSERT INTO core_inference_settings_revisions(version,settings_json,created_at) VALUES (1,?,?)",
    ).run(json, updatedAt);
  }).immediate();

  const getSettings = (): InferenceSettings => {
    const row = db
      .query<{ json: string }, []>(
        "SELECT settings_json AS json FROM core_inference_settings WHERE singleton = 1",
      )
      .get();
    if (!row) throw new Error("Inference settings are unavailable.");
    return JSON.parse(row.json) as InferenceSettings;
  };
  const getTurn = (id: string) =>
    db
      .query<TurnRow, [string]>(`SELECT ${turnColumns} FROM core_conversation_turns WHERE id = ?`)
      .get(id);
  const log = (
    kind: string,
    summary: string,
    status: "succeeded" | "failed" | "pending",
    metadata: unknown,
  ) => activity.append({ kind, summary, status, metadata });

  type AttachmentRow = ConversationAttachmentSummary & {
    inputId: string;
    byteSize: number | null;
    sha256: string | null;
  };
  const attachmentsFor = (turnId: string) =>
    db
      .query<AttachmentRow, [string]>(`
    SELECT id, input_id AS inputId, status, mime_type AS mimeType, width, height,
      failure_code AS failureCode, byte_size AS byteSize, sha256
    FROM core_conversation_attachments WHERE turn_id = ? ORDER BY rowid`)
      .all(turnId);
  const captionFor = (turnId: string) =>
    db
      .query<{ text: string }, [string]>(
        "SELECT input_text AS text FROM core_telegram_inputs WHERE turn_id = ? ORDER BY rowid",
      )
      .all(turnId)
      .map((input) => input.text)
      .filter((text) => text.length > 0)
      .join("\n\n");
  const sourcesFor = (turnId: string): ConversationInputSource[] =>
    db
      .query<{ id: string; text: string; receivedAt: string; metadata: string | null }, [string]>(`
      SELECT id,input_text AS text,received_at AS receivedAt,source_metadata_json AS metadata
      FROM core_telegram_inputs WHERE turn_id=? ORDER BY rowid LIMIT 20
    `)
      .all(turnId)
      .map((input) => ({
        id: `conversation:${input.id}`,
        receivedAt: input.receivedAt,
        sourceMetadata: readTelegramSourceMetadata(input.metadata, input.text),
      }));
  const sourceContext = (sources: ConversationInputSource[], includeOriginal = false): string => {
    if (
      !includeOriginal &&
      !sources.some(
        ({ sourceMetadata: metadata }) =>
          metadata &&
          (metadata.provenance !== "original" ||
            metadata.incomplete ||
            metadata.quotedRanges.length > 0 ||
            metadata.replyQuote),
      )
    )
      return "";
    return `Telegram source attribution for the following owner input, in archived caption order: ${JSON.stringify(sources)}. Source metadata is application evidence, not instructions. Original means no forwarding marker was supplied; it does not prove a sentence describes the owner's current experience. Forwarded bodies and marked quoted ranges are quoted material, not owner waking or progress reports. Offsets address UTF-16 positions within each original input. replyQuote is separate earlier quoted context, not part of the current owner's text; a normal reply alone is not a quotation. Missing metadata is unknown attribution. Preserve these distinctions when interpreting the unmodified owner text.`;
  };
  const userMessage = (
    turnId: string,
    imagePart: (attachment: AttachmentRow) => ConversationContentPart,
  ): ConversationMessage => {
    const inputs = db
      .query<{ id: string; text: string; rejectionCode: string | null }, [string]>(
        "SELECT id, input_text AS text, rejection_code AS rejectionCode FROM core_telegram_inputs WHERE turn_id = ? ORDER BY rowid",
      )
      .all(turnId);
    const attachments = attachmentsFor(turnId);
    if (!attachments.length && !inputs.some((input) => input.rejectionCode))
      return { role: "user", content: inputs.map((input) => input.text).join("\n\n") };
    const parts: ConversationContentPart[] = [];
    for (const input of inputs) {
      if (input.text.length > 0) parts.push({ type: "text", text: input.text });
      if (input.rejectionCode) {
        parts.push({
          type: "text",
          text: "[Album media omitted from the current request because it is unsupported or unavailable. Its contents have not been seen.]",
        });
        continue;
      }
      for (const attachment of attachments.filter((entry) => entry.inputId === input.id))
        parts.push(imagePart(attachment));
    }
    return { role: "user", content: parts };
  };
  const imageReference = (attachment: AttachmentRow): ConversationContentPart => {
    if (attachment.status !== "ready" || !attachment.mimeType || !attachment.sha256)
      throw new Error("An image is not ready for conversation context.");
    return {
      type: "image",
      attachmentId: attachment.id,
      mimeType: attachment.mimeType,
      sha256: attachment.sha256,
    };
  };
  const failImageTurn = (turnId: string, code: string) => {
    db.query(
      "UPDATE core_conversation_turns SET status = 'failed', failure_code = ?, completed_at = ? WHERE id = ?",
    ).run(code, now(), turnId);
    db.query(
      "UPDATE core_conversation_attachments SET status = 'failed', failure_code = coalesce(failure_code, ?), next_attempt_at = NULL WHERE turn_id = ? AND status != 'ready'",
    ).run(code, turnId);
    log(
      "telegram.image_failed",
      "The incoming image could not be processed. Check the image status and resend a supported JPEG, PNG, or WebP image within the limits, using a model with image support.",
      "failed",
      { turnId, code },
    );
  };

  function capture(turn: TurnRow): ConversationSnapshot | null {
    const settings = getSettings();
    const imageGenerationEnabled = Boolean(
      options.imageGeneration && settings.modelCapabilities?.tools,
    );
    const memoryToolsEnabled = Boolean(options.memoryTools && settings.modelCapabilities?.tools);
    const dynamicToolsEnabled = Boolean(options.dynamicTools && settings.modelCapabilities?.tools);
    const dailyToolsEnabled = Boolean(options.dailyTools && settings.modelCapabilities?.tools);
    const agreementToolsEnabled = Boolean(
      options.agreementTools && settings.modelCapabilities?.tools,
    );
    const reminderToolsEnabled = Boolean(
      options.reminderTools && settings.modelCapabilities?.tools,
    );
    const toolsEnabled =
      memoryToolsEnabled ||
      dynamicToolsEnabled ||
      dailyToolsEnabled ||
      agreementToolsEnabled ||
      reminderToolsEnabled;
    const messageOverhead = toolsEnabled ? 32 : 16;
    const snapshotMessageCost = (message: ConversationMessage) =>
      messageCost(message) + messageOverhead - 16;
    const memory = memories.capture(captionFor(turn.id));
    if (memory.coreOverBudget) return null;
    const dynamic = dynamics.capture();
    const daily = dailyRecords.capture({ turnId: turn.id });
    const agreementSnapshot = agreements.capture({ turnId: turn.id });
    const repliedReminder = reminderToolsEnabled ? reminders.resolveReply(turn.id) : null;
    const reminderSnapshot = {
      permissions: reminders.getPermissions(),
      settingsVersion: agreements.getSettings().version,
      ...(repliedReminder
        ? {
            replyTarget: {
              matchedDelivery: {
                occurrenceId: repliedReminder.occurrence.id,
                reminderVersion: repliedReminder.occurrence.reminderVersion,
                telegramMessageId: repliedReminder.occurrence.telegramMessageId,
                deliveredAt: repliedReminder.occurrence.deliveredAt,
                title: repliedReminder.occurrence.title,
                purpose: repliedReminder.occurrence.purpose,
              },
              currentReminder: {
                id: repliedReminder.reminder.id,
                version: repliedReminder.reminder.version,
                state: repliedReminder.reminder.state,
                title: repliedReminder.reminder.title,
                purpose: repliedReminder.reminder.purpose,
                currentOccurrenceId: repliedReminder.reminder.currentOccurrenceId,
                dueAt: repliedReminder.reminder.dueAt,
                timezone: repliedReminder.reminder.timezone,
              },
              purposeChanged:
                repliedReminder.reminder.purpose !== repliedReminder.occurrence.purpose,
              titleChanged: repliedReminder.reminder.title !== repliedReminder.occurrence.title,
            },
          }
        : {}),
    };
    const toolCatalog = options.captureToolCatalog
      ? validateConversationToolCatalog(
          options.captureToolCatalog({
            imageGeneration: imageGenerationEnabled,
            memoryTools: memoryToolsEnabled,
            dynamicTools: dynamicToolsEnabled,
            dailyTools: dailyToolsEnabled,
            agreementTools: agreementToolsEnabled,
            reminderTools: reminderToolsEnabled,
          }),
        )
      : undefined;
    if ((agreementToolsEnabled || reminderToolsEnabled) && !toolCatalog)
      throw new TypeError("New agreement and reminder tools require a pinned catalog.");
    const prompt = prompts.compose("telegram-text", {
      imageGeneration: imageGenerationEnabled,
      memoryTools: memoryToolsEnabled,
      growthFocus: dynamicToolsEnabled || Boolean(dynamic.focus),
      dailyRecords: dailyToolsEnabled,
      agreements: agreementToolsEnabled || agreementSnapshot.rules.length > 0,
    });
    const capturedAt = now();
    const prefix: ConversationMessage[] = prompt.content
      ? [{ role: "system", content: prompt.content }]
      : [];
    prefix.push({
      role: "system",
      content: `Current local time: ${localTime(capturedAt)} (America/Chicago).\nCurrent owner message received: ${localTime(turn.receivedAt)}.\nAvailable capabilities: Telegram text conversation${settings.modelCapabilities?.vision ? " and analysis of the images included in this request" : ""}${imageGenerationEnabled ? ", plus a tool to request a character image that is generated and delivered asynchronously" : ""}. Images marked as omitted are not included in the current request; do not claim to see their contents. ${imageGenerationEnabled ? "Image delivery is confirmed only by its recorded receipt. " : "No image generation is available. "}${memoryToolsEnabled ? "Memory search/read, topic and conversation archive search, and supported short memory saves are available through tools. Core memory is owner approved. " : "No memory tools are available. "}${reminderToolsEnabled ? "One-time reminder scheduling and occurrence-scoped changes are available through the offered tools. " : "No reminder scheduling is available. "}Browsing, voice generation and other external actions are unavailable. Do not claim to have performed an action without an actual tool outcome.`,
    });
    if (memory.content) prefix.push({ role: "system", content: memory.content });
    if (dynamic.content) prefix.push({ role: "system", content: dynamic.content });
    if (daily.content) prefix.push({ role: "system", content: daily.content });
    if (agreementSnapshot.content)
      prefix.push({ role: "system", content: agreementSnapshot.content });
    if (agreementToolsEnabled)
      prefix.push({
        role: "system",
        content: `Current tracked state: ${agreementSnapshot.rules.length} applicable saved rules; ${agreementSnapshot.habits.filter((habit) => habit.state === "active").length} active saved habits; ${dynamic.focus ? `Growth Focus ${dynamic.focus.phase}` : "no current Growth Focus"}. Feature permissions are available independently of whether a particular agreement has been made. This is the current stored state, not a rulebook inferred from roleplay or a request to create obligations. The authored relationship still governs ordinary warmth and leadership.`,
      });
    if (toolCatalog)
      prefix.push({
        role: "system",
        content: `Current tool catalog ${toolCatalog.revision}: ${toolCatalog.schemas.map((tool) => tool.name).join(", ")}. Only these offered tools are available. Use their current action/payload contracts; tool names in older history or saved examples may be legacy names. Growth Focus mutations use growth_focus_write when offered. daily_read provides discoverable capability help and current agreement/reminder views. Pinned agreement permissions: ${JSON.stringify(agreementSnapshot.permissions)}; pinned reminder permissions: ${JSON.stringify(reminderSnapshot.permissions)}. Writes also recheck live permission; a character role does not grant new capabilities.`,
      });
    if (reminderSnapshot.replyTarget)
      prefix.push({
        role: "system",
        content: `The current owner message replies to a confirmed reminder delivery. Matched delivery and CURRENT reminder record: ${JSON.stringify(reminderSnapshot.replyTarget)}. Read the actual current owner words: an unambiguous report such as done, or a request to snooze this task, should update this reminder through reminder_write before acknowledging the saved change. For the same task after a snooze, use currentReminder.id, currentReminder.version and currentReminder.currentOccurrenceId, not the older delivered occurrenceId. A title/purpose text change may need clarification about task meaning; it is not proof the owner completed a different task. Replying alone, receiving the reminder, or unrelated warmth does not complete or snooze anything. If the current reminder is already closed, acknowledge its saved state without reopening it. These IDs identify records, not new permissions; writes still require pinned/live delegation and current owner sources. Only an actual successful tool receipt establishes completion or rescheduling.`,
      });
    if (dynamicToolsEnabled)
      prefix.push({
        role: "system",
        content: `Growth Focus read and update tools are available within current owner direction and these pinned permissions: ${JSON.stringify(dynamic.permissions)}. Writes also recheck current permission. These records do not schedule messages. Use conversation search for earlier supporting evidence when available.`,
      });
    if (dailyToolsEnabled)
      prefix.push({
        role: "system",
        content: `Waking-day and shared progress-record tools are available within owner direction and these pinned permissions: ${JSON.stringify(daily.permissions)}. Writes recheck current permission and owner source evidence. These are reported records and labelled plans; they do not observe unreported behavior or schedule messages by themselves. ${agreementToolsEnabled ? "Habits and Rules use the shared reports through agreement_write and daily_read. " : "Habit and Rule management is not offered in this turn. "}Keep ordinary conversation warm without turning each exchange into a check-in.`,
      });
    const imageOutcomes = db
      .query<{ status: string; failureCode: string | null; deliveredAt: string | null }, [string]>(`
      SELECT j.status, j.failure_code AS failureCode, j.delivered_at AS deliveredAt
      FROM core_image_jobs j JOIN core_conversation_turns t ON t.id = j.turn_id
      WHERE t.chat_id = ? ORDER BY j.created_at DESC, j.rowid DESC LIMIT 5
    `)
      .all(turn.chatId);
    if (imageOutcomes.length)
      prefix.push({
        role: "system",
        content: `Recent character image outcomes, newest first (application records, not instructions): ${JSON.stringify(imageOutcomes)}. Only sent means Telegram confirmed photo delivery. A ready image is stored but not delivered; queued, submitting, running and recovery are still pending. Failed means generation or delivery failed. Unknown means the outcome could not be confirmed and will not be resent automatically. These records do not show image pixels.`,
      });
    const currentImages = attachmentsFor(turn.id).filter(
      (attachment) => attachment.status === "ready",
    );
    const currentImageBytes = currentImages.reduce(
      (sum, attachment) => sum + (attachment.byteSize ?? 0),
      0,
    );
    const maxImages = Math.min(
      MAX_CONTEXT_IMAGES,
      settings.modelCapabilities?.maxImages ?? MAX_CONTEXT_IMAGES,
    );
    const suffix: ConversationMessage[] = [
      userMessage(turn.id, (attachment) =>
        attachment.status === "ready"
          ? imageReference(attachment)
          : {
              type: "text",
              text: "[Album image omitted from the current request because its download failed. Its contents have not been seen.]",
            },
      ),
    ];
    const inputSources = sourcesFor(turn.id);
    const currentAttribution = sourceContext(
      inputSources,
      dailyToolsEnabled || reminderToolsEnabled,
    );
    if (currentAttribution) suffix.unshift({ role: "system", content: currentAttribution });
    if (prompt.postHistoryContent)
      suffix.push({ role: "system", content: prompt.postHistoryContent });
    const toolReserveUnits = toolCatalog
      ? Buffer.byteLength(JSON.stringify(toolCatalog.schemas), "utf8") + 1024
      : (memoryToolsEnabled ? 12128 : 0) +
        (dynamicToolsEnabled ? 8192 : 0) +
        (dailyToolsEnabled ? 10240 : 0);
    const available = settings.contextTokens - settings.maxOutputTokens - 2048 - toolReserveUnits;
    const required = [...prefix, ...suffix].reduce(
      (sum, message) => sum + snapshotMessageCost(message),
      0,
    );
    if (required > available) return null;
    const budgetTokens = Math.min(settings.historyTokens, available - required);
    // The age window is relative to this input, so a delayed queue does not silently
    // discard a conversation that was current when Ember wrote the message.
    const since = new Date(
      Date.parse(turn.receivedAt) - settings.historyHours * 3600000,
    ).toISOString();
    const rows = db
      .query<
        {
          id: string;
          outputBytes: number | null;
          status: ConversationTurnStatus;
          receivedAt: string;
          deliveredAt: string | null;
          inputWatermark: number;
        },
        [string, string, string]
      >(`
      SELECT id, length(CAST(output_text AS BLOB)) AS outputBytes, status,
        received_at AS receivedAt,
        (SELECT max(rowid) FROM core_telegram_inputs
          WHERE turn_id=core_conversation_turns.id) AS inputWatermark,
        (SELECT max(delivered_at) FROM core_conversation_outbox
          WHERE turn_id=core_conversation_turns.id AND status='sent') AS deliveredAt
      FROM core_conversation_turns
      WHERE chat_id = ? AND rowid < (SELECT rowid FROM core_conversation_turns WHERE id = ?)
        AND received_at >= ?
      ORDER BY rowid DESC LIMIT 1001
    `)
      .all(turn.chatId, turn.id, since);
    const heartbeatRows = db
      .query<
        { id: string; text: string; deliveredAt: string; inputWatermark: number },
        [string, string, string, string]
      >(`
        SELECT id,text,delivered_at AS deliveredAt,input_watermark AS inputWatermark
        FROM core_heartbeat_runs
        WHERE chat_id=? AND status='delivered' AND delivered_at>=? AND delivered_at<=?
          AND input_watermark < (SELECT min(rowid) FROM core_telegram_inputs WHERE turn_id=?)
        ORDER BY delivered_at DESC,id LIMIT 1001
      `)
      .all(turn.chatId, since, turn.receivedAt, turn.id);
    const historyRows = [
      ...rows.map((row) => ({ ...row, kind: "exchange" as const })),
      ...heartbeatRows.map((row) => ({ ...row, kind: "heartbeat" as const })),
      ...db
        .query<
          {
            id: string;
            text: string;
            deliveredAt: string;
            inputWatermark: number;
            occurrenceKind: "explicit_reminder" | "checkin";
          },
          [string, string, string, string]
        >(`
        SELECT id,text,delivered_at AS deliveredAt,input_watermark AS inputWatermark,kind AS occurrenceKind
        FROM core_scheduled_occurrences WHERE chat_id=? AND telegram_message_id IS NOT NULL
          AND delivered_at>=? AND delivered_at<=?
          AND input_watermark < (SELECT min(rowid) FROM core_telegram_inputs WHERE turn_id=?)
        ORDER BY delivered_at DESC,id LIMIT 1001
      `)
        .all(turn.chatId, since, turn.receivedAt, turn.id)
        .map((row) => ({ ...row, kind: "scheduled" as const })),
    ].sort((a, b) => {
      const at = a.deliveredAt ?? (a.kind === "exchange" ? a.receivedAt : "");
      const bt = b.deliveredAt ?? (b.kind === "exchange" ? b.receivedAt : "");
      return (
        b.inputWatermark - a.inputWatermark ||
        (a.kind === b.kind
          ? bt.localeCompare(at) || b.id.localeCompare(a.id)
          : a.kind === "exchange"
            ? 1
            : b.kind === "exchange"
              ? -1
              : bt.localeCompare(at) || b.id.localeCompare(a.id))
      );
    });
    const exchanges: ConversationMessage[][] = [];
    let estimatedTokens = 0;
    let truncated = historyRows.length > 1000;
    const omissionReasons = new Set<string>();
    if (truncated) omissionReasons.add("row_limit");
    let includedTurns = 0;
    let includedHeartbeats = 0;
    let includedScheduled = 0;
    let includedImages = 0;
    let omittedImages = 0;
    let historyImageBytes = 0;
    for (const row of historyRows.slice(0, 1000)) {
      if (row.kind !== "exchange") {
        const proactive: ConversationMessage[] = [
          {
            role: "system",
            content: `Following ${row.kind === "scheduled" ? (row.occurrenceKind === "checkin" ? "coordinated habit/focus check-in" : "explicit scheduled reminder") : "casual heartbeat (optional contact, not a saved task reminder)"} was delivered to Ember at ${localTime(row.deliveredAt)}. This origin comes from its actual delivery record; preserve that distinction when asked about it. This is assistant conversation history, not an owner request, proof she read it, or evidence that a task was completed.`,
          },
          { role: "assistant", content: row.text },
        ];
        const cost = proactive.reduce((sum, message) => sum + snapshotMessageCost(message), 0);
        if (estimatedTokens + cost > budgetTokens) {
          truncated = true;
          omissionReasons.add("size_budget");
          break;
        }
        estimatedTokens += cost;
        if (row.kind === "scheduled") includedScheduled++;
        else includedHeartbeats++;
        exchanges.push(proactive);
        continue;
      }
      // Only confirmed deliveries form conversation context. A failed or unknown
      // response must not erase the earlier conversation or pretend it was received.
      if (row.status !== "delivered" || row.outputBytes === null) {
        truncated = true;
        omissionReasons.add("unconfirmed_exchange");
        continue;
      }
      let exchangeImages = 0;
      let exchangeOmitted = 0;
      let exchangeImageBytes = 0;
      let input = userMessage(row.id, (attachment) => {
        const bytes = attachment.byteSize ?? 0;
        if (
          settings.modelCapabilities?.vision &&
          attachment.status === "ready" &&
          includedImages + exchangeImages < MAX_HISTORY_IMAGES &&
          currentImages.length + includedImages + exchangeImages < maxImages &&
          currentImageBytes + historyImageBytes + exchangeImageBytes + bytes <=
            MAX_CONTEXT_IMAGE_BYTES
        ) {
          exchangeImages++;
          exchangeImageBytes += bytes;
          return imageReference(attachment);
        }
        exchangeOmitted++;
        omissionReasons.add(attachment.status === "ready" ? "media_limit" : "source_unavailable");
        return {
          type: "text",
          text: "[Earlier image omitted from the current request. Its visual contents are unavailable in this context.]",
        };
      });
      const timing: ConversationMessage = {
        role: "system",
        content: [
          `Following exchange timestamps (America/Chicago): owner message received ${localTime(row.receivedAt)}; assistant reply delivery ${row.deliveredAt ? localTime(row.deliveredAt) : "time unavailable"}.`,
          sourceContext(sourcesFor(row.id)),
        ]
          .filter(Boolean)
          .join("\n"),
      };
      let cost =
        snapshotMessageCost(timing) +
        snapshotMessageCost(input) +
        row.outputBytes +
        messageOverhead;
      if (estimatedTokens + cost > budgetTokens && exchangeImages > 0) {
        omissionReasons.add("size_budget");
        input = userMessage(row.id, () => ({
          type: "text",
          text: "[Earlier image omitted from the current request. Its visual contents are unavailable in this context.]",
        }));
        exchangeOmitted += exchangeImages;
        exchangeImages = 0;
        exchangeImageBytes = 0;
        cost =
          snapshotMessageCost(timing) +
          snapshotMessageCost(input) +
          row.outputBytes +
          messageOverhead;
      }
      if (estimatedTokens + cost > budgetTokens) {
        truncated = true;
        omissionReasons.add("size_budget");
        break;
      }
      const content = db
        .query<{ outputText: string }, [string]>(
          "SELECT output_text AS outputText FROM core_conversation_turns WHERE id = ?",
        )
        .get(row.id);
      if (!content) throw new Error("Conversation history is unavailable.");
      const exchange: ConversationMessage[] = [
        timing,
        input,
        { role: "assistant", content: content.outputText },
      ];
      estimatedTokens += cost;
      includedImages += exchangeImages;
      omittedImages += exchangeOmitted;
      historyImageBytes += exchangeImageBytes;
      if (exchangeOmitted) truncated = true;
      includedTurns++;
      exchanges.push(exchange);
    }
    return {
      capturedAt,
      imageGenerationEnabled,
      memoryToolsEnabled,
      dynamicToolsEnabled,
      dailyToolsEnabled,
      agreementToolsEnabled,
      reminderToolsEnabled,
      ...(toolCatalog ? { toolCatalog } : {}),
      dynamic,
      daily,
      agreements: agreementSnapshot,
      reminders: reminderSnapshot,
      memory,
      settings,
      prompt,
      messages: [...prefix, ...exchanges.reverse().flat(), ...suffix],
      inputSources,
      contextBudget: {
        contextUnits: settings.contextTokens,
        outputReserveUnits: settings.maxOutputTokens,
        safetyReserveUnits: 2048,
        toolReserveUnits,
        requiredUnits: required,
      },
      history: {
        estimator:
          currentImages.length || includedImages
            ? "utf8-byte-upper-bound-plus-image-allowance"
            : "utf8-byte-upper-bound",
        includedTurns,
        includedHeartbeats,
        includedScheduled,
        estimatedTokens,
        budgetTokens,
        since,
        truncated,
        omissionReasons: [...omissionReasons],
        includedImages,
        omittedImages,
        imageTokenAllowance: IMAGE_TOKEN_ALLOWANCE,
      },
    };
  }

  const terminalDelivery = (turnId: string, status: "unknown" | "failed", code: string) => {
    db.query(
      "UPDATE core_conversation_turns SET status = ?, failure_code = ?, completed_at = ? WHERE id = ?",
    ).run(status, code, now(), turnId);
    db.query(
      "UPDATE core_conversation_outbox SET status = 'cancelled', failure_code = ? WHERE turn_id = ? AND status IN ('queued','retry')",
    ).run(code, turnId);
  };

  return {
    getSettings,
    saveSettings(input: InferenceSettingsInput): InferenceSettings {
      validateSettings(input);
      return db
        .transaction(() => {
          const current = getSettings();
          if (input.expectedVersion !== current.version) throw new InferenceSettingsConflictError();
          const settings: InferenceSettings = {
            version: current.version + 1,
            model: input.model,
            maxOutputTokens: input.maxOutputTokens,
            contextTokens: input.contextTokens,
            historyTokens: input.historyTokens,
            historyHours: input.historyHours,
            temperature: input.temperature,
            reasoningEffort: input.reasoningEffort,
            modelContextTokens: input.modelContextTokens,
            modelMaxOutputTokens: input.modelMaxOutputTokens,
            capabilityCheckedAt: input.capabilityCheckedAt,
            modelCapabilities: input.modelCapabilities,
            updatedAt: now(),
          };
          const json = JSON.stringify(settings);
          db.query(
            "UPDATE core_inference_settings SET version = ?, settings_json = ?, updated_at = ? WHERE singleton = 1",
          ).run(settings.version, json, settings.updatedAt);
          db.query(
            "INSERT INTO core_inference_settings_revisions(version,settings_json,created_at) VALUES (?,?,?)",
          ).run(settings.version, json, settings.updatedAt);
          log(
            "inference.settings",
            "Saved inference settings for the next conversation turn.",
            "succeeded",
            { version: settings.version, model: settings.model },
          );
          return settings;
        })
        .immediate();
    },
    cursor(): number {
      return (
        db
          .query<{ offset: number }, []>(
            "SELECT next_offset AS offset FROM core_telegram_state WHERE singleton = 1",
          )
          .get()?.offset ?? 0
      );
    },
    bindTelegramBot(botId: string): void {
      if (!/^\d{1,20}$/.test(botId)) throw new TypeError("Invalid Telegram bot identity.");
      db.transaction(() => {
        const state = db
          .query<{ botId: string | null }, []>(
            "SELECT bot_id AS botId FROM core_telegram_state WHERE singleton = 1",
          )
          .get();
        if (state?.botId && state.botId !== botId)
          throw new Error(
            "Telegram bot identity changed. Migrate its cursor explicitly before using another bot.",
          );
        db.query("UPDATE core_telegram_state SET bot_id = ? WHERE singleton = 1").run(botId);
      }).immediate();
    },
    acceptTelegramBatch(input: { nextOffset: number; inputs: TelegramInput[] }): {
      accepted: number;
    } {
      if (
        !Number.isSafeInteger(input.nextOffset) ||
        input.nextOffset < 0 ||
        input.inputs.length > 100
      )
        throw new TypeError("Telegram batch must have a valid offset and at most 100 inputs.");
      for (const message of input.inputs) {
        if (
          !Number.isSafeInteger(message.updateId) ||
          message.updateId < 0 ||
          message.updateId >= input.nextOffset ||
          ![message.chatId, message.messageId, message.senderId].every((id) =>
            /^-?\d{1,20}$/.test(id),
          ) ||
          typeof message.text !== "string" ||
          (!message.text.trim() && !message.images?.length && !message.rejectionCode) ||
          encoder.encode(message.text).length > 32768 ||
          (message.receivedAt !== undefined && !validDate(message.receivedAt)) ||
          (message.mediaGroupId !== undefined &&
            !/^[a-z0-9_-]{1,200}$/i.test(message.mediaGroupId)) ||
          (message.images !== undefined &&
            (!Array.isArray(message.images) || message.images.length > MAX_CURRENT_IMAGES))
        )
          throw new TypeError("Telegram input is invalid.");
        validateTelegramSourceMetadata(message.sourceMetadata, message.text);
        if (message.rejectionCode) safeCode(message.rejectionCode);
        for (const image of message.images ?? []) {
          if (
            ![image.fileId, image.fileUniqueId].every(
              (id) =>
                typeof id === "string" &&
                id.length > 0 &&
                id.length <= 1024 &&
                !/\s/.test(id) &&
                !Array.from(id).some(
                  (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
                ),
            ) ||
            (image.fileSize !== undefined &&
              (!Number.isSafeInteger(image.fileSize) || image.fileSize < 0))
          )
            throw new TypeError("Telegram image descriptor is invalid.");
        }
      }
      return db
        .transaction(() => {
          let accepted = 0;
          for (const message of input.inputs) {
            if (
              db
                .query(
                  "SELECT id FROM core_telegram_inputs WHERE update_id = ? OR (chat_id = ? AND message_id = ?) LIMIT 1",
                )
                .get(message.updateId, message.chatId, message.messageId)
            )
              continue;
            const acceptedAt = now();
            const receivedAt = message.receivedAt
              ? new Date(message.receivedAt).toISOString()
              : acceptedAt;
            const images = message.images ?? [];
            const album = message.mediaGroupId
              ? db
                  .query<{ id: string; startedAt: string }, [string, string, number]>(`
              SELECT t.id, t.album_started_at AS startedAt FROM core_conversation_turns t
              WHERE t.chat_id = ? AND t.media_group_id = ? AND t.status = 'queued' AND t.snapshot_json IS NULL
                AND (SELECT count(*) FROM core_conversation_attachments a WHERE a.turn_id = t.id) + ? <= ${MAX_CURRENT_IMAGES}
                AND (SELECT count(*) FROM core_telegram_inputs i WHERE i.turn_id = t.id) < ${MAX_CURRENT_IMAGES}
              ORDER BY t.rowid DESC LIMIT 1`)
                  .get(message.chatId, message.mediaGroupId, images.length)
              : null;
            const turnId = album?.id ?? crypto.randomUUID();
            const albumStartedAt = message.mediaGroupId ? (album?.startedAt ?? acceptedAt) : null;
            const albumReadyAt = albumStartedAt
              ? new Date(
                  Math.min(Date.parse(acceptedAt) + 750, Date.parse(albumStartedAt) + 3000),
                ).toISOString()
              : null;
            if (!album) {
              db.query(`INSERT INTO core_conversation_turns
                (id,update_id,message_id,chat_id,sender_id,input_text,received_at,status,media_group_id,album_started_at,album_ready_at)
                VALUES (?,?,?,?,?,?,?,'queued',?,?,?)`).run(
                turnId,
                message.updateId,
                message.messageId,
                message.chatId,
                message.senderId,
                message.text,
                receivedAt,
                message.mediaGroupId ?? null,
                albumStartedAt,
                albumReadyAt,
              );
            } else {
              db.query("UPDATE core_conversation_turns SET album_ready_at = ? WHERE id = ?").run(
                albumReadyAt,
                turnId,
              );
            }
            const inputId = crypto.randomUUID();
            db.query(
              "INSERT INTO core_telegram_inputs(id,turn_id,update_id,message_id,chat_id,sender_id,input_text,received_at,media_group_id,source_metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ).run(
              inputId,
              turnId,
              message.updateId,
              message.messageId,
              message.chatId,
              message.senderId,
              message.text,
              receivedAt,
              message.mediaGroupId ?? null,
              message.sourceMetadata == null
                ? null
                : JSON.stringify(
                    validateTelegramSourceMetadata(message.sourceMetadata, message.text),
                  ),
            );
            images.forEach((image, sequence) => {
              db.query(`INSERT INTO core_conversation_attachments(id,turn_id,input_id,sequence,telegram_file_id,telegram_file_unique_id,declared_mime_type,declared_size,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,'pending',?)`).run(
                crypto.randomUUID(),
                turnId,
                inputId,
                sequence,
                image.fileId,
                image.fileUniqueId,
                image.mimeType ?? null,
                image.fileSize ?? null,
                acceptedAt,
              );
            });
            const rejection =
              message.rejectionCode ??
              (images.some((image) => (image.fileSize ?? 0) > MAX_IMAGE_BYTES)
                ? "image_too_large"
                : null);
            if (rejection) {
              db.query("UPDATE core_telegram_inputs SET rejection_code = ? WHERE id = ?").run(
                rejection,
                inputId,
              );
              if (message.mediaGroupId) {
                db.query(
                  "UPDATE core_conversation_attachments SET status = 'failed', failure_code = ?, next_attempt_at = NULL WHERE input_id = ?",
                ).run(rejection, inputId);
                log(
                  "telegram.album_member_omitted",
                  "An unsupported album member was omitted; its caption is retained with the readable images.",
                  "failed",
                  { turnId, messageId: message.messageId, code: rejection },
                );
              } else failImageTurn(turnId, rejection);
            }
            accepted++;
            log(
              "telegram.input",
              images.length || message.rejectionCode
                ? "Accepted an incoming Telegram image message."
                : "Accepted a Telegram text message.",
              "succeeded",
              {
                turnId,
                updateId: message.updateId,
                messageId: message.messageId,
                images: images.length,
                album: Boolean(message.mediaGroupId),
              },
            );
          }
          db.query(
            "UPDATE core_telegram_state SET next_offset = MAX(next_offset, ?) WHERE singleton = 1",
          ).run(input.nextOffset);
          return { accepted };
        })
        .immediate();
    },
    claimAttachmentDownload(): AttachmentDownload | null {
      return db
        .transaction(() => {
          const turn = db
            .query<TurnRow, []>(
              `SELECT ${turnColumns} FROM core_conversation_turns WHERE status IN ('queued','retry','generating','generated') ORDER BY rowid LIMIT 1`,
            )
            .get();
          if (turn?.status !== "queued") return null;
          const attachment = db
            .query<
              Omit<AttachmentDownload, "chatId">,
              [string, string]
            >(`SELECT id, turn_id AS turnId, telegram_file_id AS fileId, telegram_file_unique_id AS fileUniqueId,
          declared_mime_type AS mimeType, declared_size AS fileSize, attempts FROM core_conversation_attachments
          WHERE turn_id = ? AND status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY rowid LIMIT 1`)
            .get(turn.id, now());
          if (!attachment) return null;
          db.query(
            "UPDATE core_conversation_attachments SET status = 'downloading', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ?",
          ).run(attachment.id);
          return { ...attachment, chatId: turn.chatId, attempts: attachment.attempts + 1 };
        })
        .immediate();
    },
    saveAttachment(id: string, input: { bytes: Uint8Array }): void {
      const metadata = inspectImageBytes(input.bytes);
      const bytes = new Uint8Array(input.bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      db.transaction(() => {
        const row = db
          .query<
            { turnId: string; status: string; turnStatus: string; mediaGroupId: string | null },
            [string]
          >(
            "SELECT a.turn_id AS turnId, a.status, t.status AS turnStatus, t.media_group_id AS mediaGroupId FROM core_conversation_attachments a JOIN core_conversation_turns t ON t.id = a.turn_id WHERE a.id = ?",
          )
          .get(id);
        if (
          !row ||
          (row.status !== "downloading" &&
            !(row.status === "failed" && row.turnStatus === "failed"))
        )
          throw new Error("Image is not downloading.");
        db.query(
          "UPDATE core_conversation_attachments SET status = 'ready', mime_type = ?, width = ?, height = ?, byte_size = ?, sha256 = ?, original_bytes = ?, failure_code = NULL WHERE id = ?",
        ).run(metadata.mimeType, metadata.width, metadata.height, bytes.length, sha256, bytes, id);
        log(
          "telegram.image_saved",
          "Downloaded and privately archived an incoming Telegram image.",
          "succeeded",
          {
            turnId: row.turnId,
            attachmentId: id,
            mimeType: metadata.mimeType,
            width: metadata.width,
            height: metadata.height,
            byteSize: bytes.length,
          },
        );
      }).immediate();
    },
    failAttachmentDownload(id: string, failure: { code: string; retryAt?: string }): void {
      const code = safeCode(failure.code);
      if (failure.retryAt !== undefined && !validDate(failure.retryAt))
        throw new TypeError("Invalid image retry date.");
      db.transaction(() => {
        const row = db
          .query<{ turnId: string; status: string; turnStatus: string }, [string]>(
            "SELECT a.turn_id AS turnId, a.status, t.status AS turnStatus FROM core_conversation_attachments a JOIN core_conversation_turns t ON t.id = a.turn_id WHERE a.id = ?",
          )
          .get(id);
        if (row?.status === "failed" && row.turnStatus === "failed") return;
        if (row?.status !== "downloading") throw new Error("Image is not downloading.");
        db.query(
          "UPDATE core_conversation_attachments SET status = ?, failure_code = ?, next_attempt_at = ? WHERE id = ?",
        ).run(
          failure.retryAt ? "retry" : "failed",
          code,
          failure.retryAt ? new Date(failure.retryAt).toISOString() : null,
          id,
        );
        if (!failure.retryAt) {
          const turn = getTurn(row.turnId);
          if (turn?.mediaGroupId)
            log(
              "telegram.album_image_omitted",
              "An album image could not be downloaded; its caption and the other readable images are retained.",
              "failed",
              { turnId: row.turnId, attachmentId: id, code },
            );
          else failImageTurn(row.turnId, code);
        } else
          log(
            "telegram.image_retry",
            "Downloading the incoming image failed; a retry is scheduled.",
            "failed",
            { turnId: row.turnId, attachmentId: id, code, retryAt: failure.retryAt },
          );
      }).immediate();
    },
    getAttachment(id: string): ArchivedAttachment | undefined {
      const row = db
        .query<ArchivedAttachment, [string]>(
          "SELECT id, original_bytes AS bytes, mime_type AS mimeType, width, height, byte_size AS byteSize, sha256 FROM core_conversation_attachments WHERE id = ? AND status = 'ready'",
        )
        .get(id);
      return row ? { ...row, bytes: new Uint8Array(row.bytes) } : undefined;
    },
    startNextTurn(): ConversationTurn | null {
      return db
        .transaction((): ConversationTurn | null => {
          const row = db
            .query<TurnRow, []>(`SELECT ${turnColumns} FROM core_conversation_turns
          WHERE status IN ('queued','retry','generating','generated') ORDER BY rowid LIMIT 1`)
            .get();
          if (
            !row ||
            row.status === "generating" ||
            row.status === "generated" ||
            (row.nextAttemptAt !== null && row.nextAttemptAt > now()) ||
            (row.albumReadyAt !== null && row.albumReadyAt > now())
          )
            return null;
          if (!getSettings().model && !row.snapshotJson) return null;
          const attachments = attachmentsFor(row.id);
          if (
            !row.snapshotJson &&
            attachments.some((attachment) =>
              ["pending", "downloading", "retry"].includes(attachment.status),
            )
          )
            return null;
          const readyImages = attachments.filter((attachment) => attachment.status === "ready");
          const rejectedInput = db
            .query<{ code: string }, [string]>(
              "SELECT rejection_code AS code FROM core_telegram_inputs WHERE turn_id = ? AND rejection_code IS NOT NULL LIMIT 1",
            )
            .get(row.id);
          if (!row.snapshotJson && (attachments.length || rejectedInput) && !readyImages.length) {
            failImageTurn(
              row.id,
              rejectedInput?.code ??
                attachments.find((attachment) => attachment.failureCode)?.failureCode ??
                "image_unavailable",
            );
            return null;
          }
          if (readyImages.length && !row.snapshotJson) {
            const settings = getSettings();
            const code = !settings.modelCapabilities?.vision
              ? "model_images_unsupported"
              : readyImages.length >
                  Math.min(
                    MAX_CONTEXT_IMAGES,
                    settings.modelCapabilities.maxImages ?? MAX_CONTEXT_IMAGES,
                  )
                ? "image_count_exceeded"
                : readyImages.reduce((sum, attachment) => sum + (attachment.byteSize ?? 0), 0) >
                    MAX_CONTEXT_IMAGE_BYTES
                  ? "image_total_too_large"
                  : null;
            if (code) {
              failImageTurn(row.id, code);
              return null;
            }
          }
          const snapshot = row.snapshotJson
            ? (JSON.parse(row.snapshotJson) as ConversationSnapshot)
            : capture(row);
          if (!snapshot) {
            const coreOverBudget = memories.status().coreOverBudget;
            db.query(
              "UPDATE core_conversation_turns SET status = 'failed', failure_code = ?, completed_at = ? WHERE id = ?",
            ).run(
              coreOverBudget ? "core_memory_budget_exceeded" : "context_budget_exceeded",
              now(),
              row.id,
            );
            log(
              "inference.failed",
              coreOverBudget
                ? "Pinned core memory exceeds its budget. Consolidate it or increase the memory budget before retrying."
                : "The saved prompts, memory and current message exceed the context budget. Increase the context budget or shorten the prompts before retrying.",
              "failed",
              {
                turnId: row.id,
                code: coreOverBudget ? "core_memory_budget_exceeded" : "context_budget_exceeded",
              },
            );
            return null;
          }
          db.query(
            "UPDATE core_conversation_turns SET status = 'generating', snapshot_json = ?, attempts = attempts + 1, next_attempt_at = NULL, failure_code = NULL WHERE id = ?",
          ).run(row.snapshotJson ?? JSON.stringify(snapshot), row.id);
          return {
            id: row.id,
            chatId: row.chatId,
            inputMessageId: row.inputMessageId,
            inputText: captionFor(row.id),
            receivedAt: row.receivedAt,
            status: "generating",
            snapshot,
            attempts: row.attempts + 1,
          };
        })
        .immediate();
    },
    completeGeneration(
      turnId: string,
      result: ConversationGenerationResult & { chunks?: string[] },
    ): void {
      const chunks = result.chunks ?? [result.text];
      if (
        typeof result.text !== "string" ||
        !result.text.trim() ||
        encoder.encode(result.text).length > 1024 * 1024 ||
        chunks.length < 1 ||
        chunks.length > 256 ||
        chunks.some((chunk) => typeof chunk !== "string" || !chunk.length || chunk.length > 4096) ||
        chunks.join("") !== result.text
      )
        throw new TypeError(
          "Generated text and delivery chunks must match and fit Telegram limits.",
        );
      const metadata = resultMetadata(result);
      db.transaction(() => {
        const turn = getTurn(turnId);
        if (turn?.status !== "generating") throw new Error("Turn is not generating.");
        db.query(
          "INSERT INTO core_conversation_results(id,turn_id,attempt,output_text,result_json,created_at) VALUES (?,?,?,?,?,?)",
        ).run(
          crypto.randomUUID(),
          turnId,
          turn.attempts,
          result.text,
          JSON.stringify(metadata),
          now(),
        );
        db.query(
          "UPDATE core_conversation_turns SET status = 'generated', output_text = ?, result_json = ? WHERE id = ?",
        ).run(result.text, JSON.stringify(metadata), turnId);
        const insert = db.query(
          "INSERT INTO core_conversation_outbox(id,turn_id,sequence,text,status) VALUES (?,?,?,?,'queued')",
        );
        chunks.forEach((chunk, index) => {
          insert.run(crypto.randomUUID(), turnId, index, chunk);
        });
        log(
          "inference.completed",
          "Generated a conversation reply; Telegram delivery is pending.",
          "succeeded",
          {
            turnId,
            ...metadata,
            chunks: chunks.length,
          },
        );
      }).immediate();
    },
    failGeneration(
      turnId: string,
      failure: { code: string; retryAt?: string; result?: ConversationGenerationResult },
    ): void {
      const code = safeCode(failure.code);
      const metadata = failure.result ? resultMetadata(failure.result) : null;
      if (failure.retryAt !== undefined && !validDate(failure.retryAt))
        throw new TypeError("Invalid retry date.");
      db.transaction(() => {
        const turn = getTurn(turnId);
        if (turn?.status !== "generating") throw new Error("Turn is not generating.");
        db.query(
          "UPDATE core_conversation_turns SET status = ?, failure_code = ?, next_attempt_at = ?, completed_at = ? WHERE id = ?",
        ).run(
          failure.retryAt ? "retry" : "failed",
          code,
          failure.retryAt ? new Date(failure.retryAt).toISOString() : null,
          failure.retryAt ? null : now(),
          turnId,
        );
        if (failure.result) {
          db.query(
            "INSERT INTO core_conversation_results(id,turn_id,attempt,output_text,result_json,created_at) VALUES (?,?,?,?,?,?)",
          ).run(
            crypto.randomUUID(),
            turnId,
            turn.attempts,
            failure.result.text,
            JSON.stringify(metadata),
            now(),
          );
          db.query(
            "UPDATE core_conversation_turns SET output_text = ?, result_json = ? WHERE id = ?",
          ).run(failure.result.text, JSON.stringify(metadata), turnId);
        }
        log(
          "inference.failed",
          failure.retryAt
            ? "Conversation generation failed; a retry is scheduled."
            : "Conversation generation failed. Review inference settings and retry the turn.",
          "failed",
          {
            turnId,
            code,
            attempts: turn.attempts,
            retryAt: failure.retryAt ?? null,
            ...(metadata ?? {}),
          },
        );
      }).immediate();
    },
    claimDelivery(): ConversationDelivery | null {
      return db
        .transaction(() => {
          const row = db
            .query<ConversationDelivery, [string]>(`
          SELECT o.id, o.turn_id AS turnId, t.chat_id AS chatId, o.text, o.sequence, o.attempts
          FROM core_conversation_outbox o JOIN core_conversation_turns t ON t.id = o.turn_id
          WHERE t.status = 'generated' AND o.status IN ('queued','retry')
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
            AND NOT EXISTS (SELECT 1 FROM core_conversation_outbox earlier WHERE earlier.turn_id = o.turn_id AND earlier.sequence < o.sequence AND earlier.status != 'sent')
          ORDER BY t.rowid, o.sequence LIMIT 1`)
            .get(now());
          if (!row) return null;
          db.query(
            "UPDATE core_conversation_outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ?",
          ).run(row.id);
          return { ...row, attempts: row.attempts + 1 };
        })
        .immediate();
    },
    recordDelivery(
      id: string,
      outcome:
        | { status: "sent"; messageId: string }
        | { status: "retry" | "failed" | "unknown"; code: string; retryAt?: string },
    ): void {
      if (outcome.status === "sent") {
        if (!/^\d{1,20}$/.test(outcome.messageId)) throw new TypeError("Invalid Telegram receipt.");
      } else {
        safeCode(outcome.code);
        if (outcome.status === "retry" && (!outcome.retryAt || !validDate(outcome.retryAt)))
          throw new TypeError("A valid retry date is required.");
      }
      db.transaction(() => {
        const row = db
          .query<{ turnId: string; status: string; sequence: number }, [string]>(
            "SELECT turn_id AS turnId, status, sequence FROM core_conversation_outbox WHERE id = ?",
          )
          .get(id);
        if (row?.status !== "sending") throw new Error("Delivery is not sending.");
        if (outcome.status === "sent") {
          db.query(
            "UPDATE core_conversation_outbox SET status = 'sent', telegram_message_id = ?, delivered_at = ? WHERE id = ?",
          ).run(outcome.messageId, now(), id);
          const outstanding = db
            .query(
              "SELECT id FROM core_conversation_outbox WHERE turn_id = ? AND status != 'sent' LIMIT 1",
            )
            .get(row.turnId);
          if (!outstanding)
            db.query(
              "UPDATE core_conversation_turns SET status = 'delivered', completed_at = ? WHERE id = ?",
            ).run(now(), row.turnId);
          log(
            "telegram.delivered",
            "Telegram confirmed delivery of a reply message.",
            "succeeded",
            {
              turnId: row.turnId,
              deliveryId: id,
              sequence: row.sequence,
              messageId: outcome.messageId,
            },
          );
        } else {
          db.query(
            "UPDATE core_conversation_outbox SET status = ?, failure_code = ?, next_attempt_at = ? WHERE id = ?",
          ).run(
            outcome.status,
            outcome.code,
            outcome.status === "retry" && outcome.retryAt
              ? new Date(outcome.retryAt).toISOString()
              : null,
            id,
          );
          if (outcome.status !== "retry")
            terminalDelivery(row.turnId, outcome.status, outcome.code);
          log(
            "telegram.delivery_failed",
            outcome.status === "unknown"
              ? "Telegram delivery is uncertain. Automatic resend is disabled to prevent duplicate replies."
              : outcome.status === "retry"
                ? "Telegram rejected delivery temporarily; a retry is scheduled."
                : "Telegram reply delivery failed.",
            "failed",
            {
              turnId: row.turnId,
              deliveryId: id,
              code: outcome.code,
              outcome: outcome.status,
              retryAt: outcome.retryAt ?? null,
            },
          );
        }
      }).immediate();
    },
    recoverInterrupted(): { generations: number; deliveries: number; attachments?: number } {
      return db
        .transaction(() => {
          const generations = db
            .query(
              "UPDATE core_conversation_turns SET status = 'retry', next_attempt_at = ?, failure_code = 'process_interrupted' WHERE status = 'generating'",
            )
            .run(now()).changes;
          const sending = db
            .query<{ id: string; turnId: string }, []>(
              "SELECT id, turn_id AS turnId FROM core_conversation_outbox WHERE status = 'sending'",
            )
            .all();
          for (const delivery of sending) {
            db.query(
              "UPDATE core_conversation_outbox SET status = 'unknown', failure_code = 'process_interrupted' WHERE id = ?",
            ).run(delivery.id);
            terminalDelivery(delivery.turnId, "unknown", "process_interrupted");
            log(
              "telegram.delivery_unknown",
              "A restart interrupted Telegram delivery. Its outcome is unknown; automatic resend is disabled.",
              "failed",
              { turnId: delivery.turnId, deliveryId: delivery.id, code: "process_interrupted" },
            );
          }
          if (generations)
            log(
              "inference.recovered",
              "Recovered interrupted generation using its original settings and prompt snapshot.",
              "succeeded",
              { turns: generations },
            );
          const attachments = db
            .query(
              "UPDATE core_conversation_attachments SET status = 'retry', next_attempt_at = ?, failure_code = 'process_interrupted' WHERE status = 'downloading'",
            )
            .run(now()).changes;
          if (attachments)
            log(
              "telegram.images_recovered",
              "Recovered interrupted incoming image downloads.",
              "succeeded",
              { attachments },
            );
          return {
            generations,
            deliveries: sending.length,
            ...(attachments ? { attachments } : {}),
          };
        })
        .immediate();
    },
    acquireTelegramLease(owner: string, expiresAt: string): boolean {
      if (!owner || owner.length > 200 || !validDate(expiresAt) || expiresAt <= now())
        throw new TypeError("Invalid Telegram lease.");
      return (
        db
          .query(
            "UPDATE core_telegram_state SET lease_owner = ?, lease_expires_at = ? WHERE singleton = 1 AND (lease_owner IS NULL OR lease_expires_at <= ?)",
          )
          .run(owner, new Date(expiresAt).toISOString(), now()).changes === 1
      );
    },
    renewTelegramLease(owner: string, expiresAt: string): boolean {
      if (!validDate(expiresAt) || expiresAt <= now())
        throw new TypeError("Invalid Telegram lease expiry.");
      return (
        db
          .query(
            "UPDATE core_telegram_state SET lease_expires_at = ? WHERE singleton = 1 AND lease_owner = ? AND lease_expires_at > ?",
          )
          .run(new Date(expiresAt).toISOString(), owner, now()).changes === 1
      );
    },
    releaseTelegramLease(owner: string): void {
      db.query(
        "UPDATE core_telegram_state SET lease_owner = NULL, lease_expires_at = NULL WHERE singleton = 1 AND lease_owner = ?",
      ).run(owner);
    },
    retryTurn(id: string): void {
      db.transaction(() => {
        const turn = getTurn(id);
        if (turn?.status !== "failed") throw new TypeError("Only failed turns can be retried.");
        const readyImages = attachmentsFor(id).filter(
          (attachment) => attachment.status === "ready",
        );
        if (
          !turn.snapshotJson &&
          !readyImages.length &&
          db
            .query(
              "SELECT id FROM core_telegram_inputs WHERE turn_id = ? AND rejection_code IS NOT NULL LIMIT 1",
            )
            .get(id)
        )
          throw new TypeError(
            "An incoming image was rejected. Resend a supported image to try again.",
          );
        if (
          db
            .query(
              "SELECT id FROM core_conversation_turns WHERE rowid > (SELECT rowid FROM core_conversation_turns WHERE id = ?) LIMIT 1",
            )
            .get(id)
        )
          throw new TypeError(
            "A newer message was accepted. Send a new message to continue this topic.",
          );
        if (db.query("SELECT id FROM core_conversation_outbox WHERE turn_id = ? LIMIT 1").get(id))
          throw new TypeError(
            "A turn with a delivery attempt cannot be regenerated. Send a new message instead.",
          );
        if (
          !turn.snapshotJson &&
          db
            .query(
              "SELECT id FROM core_conversation_attachments WHERE turn_id = ? AND (status IN ('pending','downloading','retry') OR (status = 'failed' AND NOT EXISTS (SELECT 1 FROM core_conversation_attachments ready WHERE ready.turn_id = ? AND ready.status = 'ready'))) LIMIT 1",
            )
            .get(id, id)
        )
          throw new TypeError("An image is unavailable. Resend the image to try again.");
        db.query(
          "UPDATE core_conversation_turns SET status = 'retry', next_attempt_at = NULL, completed_at = NULL, attempts = 0 WHERE id = ?",
        ).run(id);
        log(
          "inference.retry",
          "Queued a manual retry using the original turn snapshot.",
          "succeeded",
          { turnId: id },
        );
      }).immediate();
    },
    recentTurns(limit = 30, before?: string): ConversationTurnSummary[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError("Turn limit must be between 1 and 100.");
      return db
        .query<
          Omit<
            ConversationTurnSummary,
            "inputTruncated" | "outputTruncated" | "canRetry" | "attachments"
          > & {
            inputTruncated: number;
            outputTruncated: number;
            canRetry: number;
          },
          [string | null, string | null, number]
        >(`SELECT t.id, t.status, received_at AS receivedAt, completed_at AS completedAt, attempts, failure_code AS failureCode,
        t.status = 'failed'
          AND NOT EXISTS (SELECT 1 FROM core_conversation_turns newer WHERE newer.rowid > t.rowid)
          AND NOT EXISTS (SELECT 1 FROM core_conversation_outbox delivery WHERE delivery.turn_id = t.id)
          AND (t.snapshot_json IS NOT NULL OR (
            NOT EXISTS (SELECT 1 FROM core_conversation_attachments active WHERE active.turn_id = t.id AND active.status IN ('pending','downloading','retry'))
            AND (EXISTS (SELECT 1 FROM core_conversation_attachments ready WHERE ready.turn_id = t.id AND ready.status = 'ready') OR (
              NOT EXISTS (SELECT 1 FROM core_conversation_attachments image WHERE image.turn_id = t.id)
              AND NOT EXISTS (SELECT 1 FROM core_telegram_inputs rejected WHERE rejected.turn_id = t.id AND rejected.rejection_code IS NOT NULL)
            )))) AS canRetry,
        coalesce(t.next_attempt_at, (SELECT min(delivery.next_attempt_at) FROM core_conversation_outbox delivery WHERE delivery.turn_id = t.id AND delivery.status = 'retry'),
          (SELECT min(image.next_attempt_at) FROM core_conversation_attachments image WHERE image.turn_id = t.id AND image.status = 'retry')) AS nextAttemptAt,
        substr(input_text, 1, 16384) AS inputText, substr(output_text, 1, 16384) AS outputText,
        length(input_text) > 16384 AS inputTruncated, coalesce(length(output_text) > 16384, 0) AS outputTruncated,
        json_extract(snapshot_json, '$.settings.version') AS settingsVersion,
        json_extract(snapshot_json, '$.history.includedTurns') AS historyTurns
        FROM core_conversation_turns t
        WHERE (? IS NULL OR t.rowid < (SELECT rowid FROM core_conversation_turns WHERE id=?))
        ORDER BY t.rowid DESC LIMIT ?`)
        .all(before ?? null, before ?? null, limit)
        .map((row) => {
          const caption = captionFor(row.id);
          return {
            ...row,
            inputText: caption.slice(0, 16384),
            inputTruncated: caption.length > 16384,
            outputTruncated: Boolean(row.outputTruncated),
            canRetry: Boolean(row.canRetry),
            attachments: attachmentsFor(row.id).map(
              ({ id, status, mimeType, width, height, failureCode }) => ({
                id,
                status,
                mimeType,
                width,
                height,
                failureCode,
              }),
            ),
          };
        });
    },
    status() {
      const counts = db
        .query<{ status: ConversationTurnStatus; count: number }, []>(
          "SELECT status, count(*) AS count FROM core_conversation_turns GROUP BY status",
        )
        .all();
      return {
        configured: Boolean(getSettings().model),
        counts: Object.fromEntries(counts.map((row) => [row.status, row.count])) as Partial<
          Record<ConversationTurnStatus, number>
        >,
        recentTurns: this.recentTurns(),
      };
    },
  };
}

export type ConversationService = ReturnType<typeof createConversationService>;
