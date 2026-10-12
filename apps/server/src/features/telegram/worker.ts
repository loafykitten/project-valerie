import {
  type ConversationTurn,
  createActivityService,
  createContextNoticeService,
  createConversationService,
  createMessageEditService,
  HeartbeatContextError,
  type ImageJob,
  type ImageJobService,
  ImageValidationError,
  type OccurrenceKind,
  type ScheduledClaim,
  type Store,
  type TelegramInput,
} from "@valerie/core";
import { InferenceError, inferenceTimeoutMs, type TextCompletion } from "@valerie/inference";
import { delay } from "../../delay";
import { record } from "../../json";
import type { HeartbeatBinding, HeartbeatRuntimeStatus } from "../heartbeat/runtime";
import { ScheduledContextError } from "../reminders/generation";
import type { ScheduledBinding } from "../reminders/runtime";
import { captureToolCatalog } from "../tools/catalog";
import { telegramSourceMetadata } from "./provenance";
import {
  abortable,
  createTelegramTransport,
  MAX_TELEGRAM_IMAGE_BYTES,
  splitTelegramText,
  TelegramError,
  type TelegramTransport,
  type TelegramUpdate,
} from "./transport";

export interface TelegramWorkerStatus {
  state: "starting" | "running" | "reconnecting" | "failed" | "stopped";
  lastError: string | null;
  lastUpdateAt: string | null;
  heartbeat?: HeartbeatRuntimeStatus;
  scheduled?: {
    state: "starting" | "waiting" | "preparing" | "stopped" | "failed";
    lastError: string | null;
    lastTickAt: string | null;
  };
}

export interface TelegramWorker {
  stop(): Promise<void>;
  status(): TelegramWorkerStatus;
}

function validFileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function imageReference(value: unknown, mimeType?: "image/jpeg" | "image/png" | "image/webp") {
  const file = record(value);
  if (!validFileId(file.file_id) || !validFileId(file.file_unique_id)) return null;
  return {
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    ...(mimeType ? { mimeType } : {}),
    ...(positiveInteger(file.file_size) ? { fileSize: file.file_size } : {}),
    ...(positiveInteger(file.width) ? { width: file.width } : {}),
    ...(positiveInteger(file.height) ? { height: file.height } : {}),
  };
}

export function ownerMessageInputs(
  updates: TelegramUpdate[],
  ownerUserId: string,
  ownerChatId = ownerUserId,
): TelegramInput[] {
  return updates.flatMap((update) => {
    const message = record(update.message);
    const sender = record(message.from);
    const chat = record(message.chat);
    if (
      chat.type !== "private" ||
      String(chat.id) !== ownerChatId ||
      String(sender.id) !== ownerUserId ||
      sender.is_bot !== false ||
      typeof message.message_id !== "number" ||
      !Number.isSafeInteger(message.message_id) ||
      message.message_id < 1
    ) {
      return [];
    }
    const mediaGroupId =
      typeof message.media_group_id === "string" &&
      /^[A-Za-z0-9_-]{1,200}$/.test(message.media_group_id)
        ? message.media_group_id
        : undefined;
    let images: NonNullable<TelegramInput["images"]> = [];
    let rejectionCode: string | undefined;
    let imageMessage = false;
    if (Array.isArray(message.photo)) {
      imageMessage = true;
      const variants = message.photo
        .map((photo) => imageReference(photo, "image/jpeg"))
        .filter((photo) => photo !== null)
        .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
      const selected =
        variants.find(
          (photo) => photo.fileSize !== undefined && photo.fileSize <= MAX_TELEGRAM_IMAGE_BYTES,
        ) ??
        variants.find((photo) => photo.fileSize === undefined) ??
        variants[0];
      if (selected) images = [selected];
      else rejectionCode = "invalid_image";
    } else if (message.document) {
      const document = record(message.document);
      const mime = typeof document.mime_type === "string" ? document.mime_type.toLowerCase() : "";
      const extension =
        typeof document.file_name === "string"
          ? document.file_name.split(".").at(-1)?.toLowerCase()
          : "";
      const extensionMime = (
        { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as Record<
          string,
          string
        >
      )[extension ?? ""];
      const knownMime = mime.startsWith("image/") ? mime : extensionMime;
      imageMessage = Boolean(
        knownMime?.startsWith("image/") ||
          ["gif", "svg", "heic", "heif", "avif", "bmp", "tiff", "tif"].includes(extension ?? ""),
      );
      if (!imageMessage) {
        if (!mediaGroupId) return [];
        imageMessage = true;
        rejectionCode = "unsupported_album_media";
      } else if (!["image/jpeg", "image/png", "image/webp"].includes(knownMime ?? ""))
        rejectionCode = "unsupported_image_format";
      else {
        const selected = imageReference(
          document,
          knownMime as "image/jpeg" | "image/png" | "image/webp",
        );
        if (selected) images = [selected];
        else rejectionCode = "invalid_image";
      }
    } else if (mediaGroupId) {
      // An album member can carry the caption for its neighboring supported photos.
      // Preserve the source and an explicit omission even when this media is unsupported.
      imageMessage = true;
      rejectionCode = "unsupported_album_media";
    }
    if (images.some((file) => (file.fileSize ?? 0) > MAX_TELEGRAM_IMAGE_BYTES))
      rejectionCode = "image_too_large";
    const content = imageMessage ? (message.caption ?? "") : message.text;
    if (typeof content !== "string" || content.length > 4096 || (!imageMessage && !content.trim()))
      return [];
    return [
      {
        updateId: update.update_id,
        messageId: String(message.message_id),
        chatId: ownerChatId,
        senderId: ownerUserId,
        text: content,
        sourceMetadata: telegramSourceMetadata(message, content, imageMessage),
        ...(images.length > 0 ? { images } : {}),
        ...(rejectionCode ? { rejectionCode } : {}),
        ...(imageMessage && mediaGroupId ? { mediaGroupId } : {}),
        ...(typeof message.date === "number" &&
        Number.isSafeInteger(message.date) &&
        message.date >= 0 &&
        message.date <= 8_640_000_000_000
          ? { receivedAt: new Date(message.date * 1000).toISOString() }
          : {}),
      },
    ];
  });
}

/** Start once from the process runtime, never from a reloadable HTTP handler factory. */
export function startTelegramWorker(options: {
  store: Store;
  token: string;
  ownerUserId: string;
  ownerChatId?: string;
  generate: (
    snapshot: ConversationTurn["snapshot"],
    signal: AbortSignal,
    turnId?: string,
  ) => Promise<TextCompletion>;
  images?: {
    service: ImageJobService;
    run(signal: AbortSignal, assertActive?: () => void): Promise<void>;
  };
  generateImageFailure?: (
    snapshot: ConversationTurn["snapshot"],
    job: ImageJob,
    signal: AbortSignal,
  ) => Promise<TextCompletion>;
  heartbeats?: HeartbeatBinding;
  reminders?: ScheduledBinding;
  schedulerTickMs?: number;
  heartbeatTickMs?: number;
  transport?: TelegramTransport;
  memoryTools?: boolean;
  dynamicTools?: boolean;
  dailyTools?: boolean;
  agreementTools?: boolean;
  reminderTools?: boolean;
  contextNotices?: boolean;
  /** Shorter values are useful with fictional deterministic transports in tests. */
  idleMs?: number;
  retryBaseMs?: number;
  pollTimeoutSeconds?: number;
}): TelegramWorker {
  const ownerChatId = options.ownerChatId ?? options.ownerUserId;
  if (
    !/^[1-9]\d*$/.test(options.ownerUserId) ||
    !/^[1-9]\d*$/.test(ownerChatId) ||
    !/^[1-9]\d*:[A-Za-z0-9_-]+$/.test(options.token)
  ) {
    throw new TelegramError("configuration", true);
  }
  const idleMs = options.idleMs ?? 500;
  const retryBaseMs = options.retryBaseMs ?? 2000;
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
  const heartbeatTickMs = options.heartbeatTickMs ?? 15_000;
  const schedulerTickMs = options.schedulerTickMs ?? 500;
  if (
    !Number.isSafeInteger(idleMs) ||
    idleMs < 1 ||
    idleMs > 5000 ||
    !Number.isSafeInteger(retryBaseMs) ||
    retryBaseMs < 1 ||
    retryBaseMs > 60_000 ||
    !Number.isSafeInteger(pollTimeoutSeconds) ||
    pollTimeoutSeconds < 1 ||
    pollTimeoutSeconds > 30 ||
    !Number.isSafeInteger(heartbeatTickMs) ||
    heartbeatTickMs < 1 ||
    heartbeatTickMs > 60_000 ||
    !Number.isSafeInteger(schedulerTickMs) ||
    schedulerTickMs < 1 ||
    schedulerTickMs > 60000
  ) {
    throw new TelegramError("configuration", true);
  }
  const transport = options.transport ?? createTelegramTransport({ token: options.token });
  const conversations = createConversationService(options.store, {
    imageGeneration: Boolean(options.images),
    memoryTools: options.memoryTools ?? false,
    dynamicTools: options.dynamicTools ?? false,
    dailyTools: options.dailyTools ?? false,
    agreementTools: options.agreementTools ?? false,
    reminderTools: options.reminderTools ?? false,
    captureToolCatalog: (flags) => captureToolCatalog(options.store, flags),
  });
  const activity = createActivityService(options.store);
  const messageEdits = createMessageEditService(options.store);
  const contextNotices = options.contextNotices ? createContextNoticeService(options.store) : null;
  const controller = new AbortController();
  const { signal } = controller;
  const leaseOwner = crypto.randomUUID();
  // Longer than every Telegram request deadline; a successor treats in-flight sends as unknown.
  const leaseExpiresAt = () => new Date(Date.now() + 120_000).toISOString();
  if (!conversations.acquireTelegramLease(leaseOwner, leaseExpiresAt())) {
    throw new Error("Another Valerie Telegram worker holds the polling lease.");
  }
  let owned = true;
  const status: TelegramWorkerStatus = {
    state: "starting",
    lastError: null,
    lastUpdateAt: null,
  };
  let workIdleMs = idleMs;
  let generationIdleMs = idleMs;
  let heartbeatGeneration: AbortController | undefined;
  let checkinGeneration: { controller: AbortController; claim: ScheduledClaim } | undefined;
  const scheduledPreparing = new Set<OccurrenceKind>();
  const scheduledStatus: NonNullable<TelegramWorkerStatus["scheduled"]> = {
    state: "starting",
    lastError: null,
    lastTickAt: null,
  };
  const heartbeatStatus: HeartbeatRuntimeStatus = {
    state: "starting",
    lastError: null,
    lastTickAt: null,
  };
  let wakeWork: (() => void) | undefined;
  let wakeGeneration: (() => void) | undefined;
  let startupActivityId: string | undefined;
  function settleStartup(success: boolean) {
    if (!startupActivityId) return;
    activity.updateStatus(startupActivityId, success ? "succeeded" : "failed");
    startupActivityId = undefined;
  }
  const retryAt = (attempts: number, retryAfterSeconds?: number) =>
    new Date(
      Date.now() +
        (retryAfterSeconds === undefined
          ? Math.min(retryBaseMs * 2 ** Math.min(attempts - 1, 5), 60_000)
          : retryAfterSeconds * 1000),
    ).toISOString();

  function failWorker(code: string) {
    if (status.state !== "failed") {
      status.state = "failed";
      status.lastError = code;
      try {
        settleStartup(false);
        activity.append({
          kind: "telegram.worker",
          status: "failed",
          summary: `Telegram conversation worker stopped: ${code}.`,
        });
      } catch {
        /* A storage failure must still abort in-flight work. */
      }
    }
    controller.abort();
  }

  function renewLease() {
    if (!owned) return false;
    try {
      owned = conversations.renewTelegramLease(leaseOwner, leaseExpiresAt());
    } catch {
      owned = false;
    }
    if (!owned) failWorker("lease_lost");
    return owned;
  }

  function assertActive() {
    signal.throwIfAborted();
    if (!renewLease()) throw new TelegramError("cancelled");
  }

  async function poll() {
    let failures = 0;
    while (!signal.aborted) {
      try {
        assertActive();
        const updates = await abortable(
          transport.getUpdates({
            offset: conversations.cursor(),
            timeoutSeconds: pollTimeoutSeconds,
            signal,
          }),
          signal,
        );
        assertActive();
        // Accept input and advance the acknowledgment cursor in one transaction.
        // Ignored senders/types are acknowledged too, without retaining their content.
        const nextOffset = updates.reduce(
          (offset, update) => Math.max(offset, update.update_id + 1),
          conversations.cursor(),
        );
        const accepted = conversations.acceptTelegramBatch({
          nextOffset,
          inputs: ownerMessageInputs(updates, options.ownerUserId, ownerChatId),
        });
        failures = 0;
        settleStartup(true);
        if (status.state === "reconnecting") {
          activity.append({ kind: "telegram.poll", summary: "Telegram polling reconnected." });
        }
        status.state = "running";
        status.lastError = null;
        status.lastUpdateAt = new Date().toISOString();
        if (accepted.accepted > 0) {
          heartbeatGeneration?.abort();
          checkinGeneration?.controller.abort();
          workIdleMs = idleMs;
          wakeWork?.();
          generationIdleMs = idleMs;
          wakeGeneration?.();
        }
        // Telegram normally waits for the long-poll timeout. Bound malformed/mock fast loops.
        if (updates.length === 0) await delay(idleMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof TelegramError)) throw error;
        if (["unauthorized", "conflict", "configuration", "rejected"].includes(error.code)) {
          failWorker(error.code);
          return;
        }
        if (status.state !== "reconnecting") {
          activity.append({
            kind: "telegram.poll",
            status: "failed",
            summary: `Telegram polling interrupted: ${error.code}. Reconnecting.`,
          });
        }
        status.state = "reconnecting";
        status.lastError = error.code;
        failures += 1;
        await delay(
          Math.max(1, Date.parse(retryAt(failures, error.retryAfterSeconds)) - Date.now()),
          signal,
        );
      }
    }
  }

  async function processConversation() {
    while (!signal.aborted) {
      assertActive();
      const attachment = conversations.claimAttachmentDownload();
      if (attachment) {
        generationIdleMs = idleMs;
        if (attachment.chatId !== ownerChatId) {
          conversations.failAttachmentDownload(attachment.id, { code: "owner_mismatch" });
          continue;
        }
        if (attachment.attempts > 3) {
          conversations.failAttachmentDownload(attachment.id, {
            code: "image_download_attempts_exhausted",
          });
          continue;
        }
        try {
          assertActive();
          const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
          const bytes = await abortable(
            transport.downloadImage({
              fileId: attachment.fileId,
              signal: downloadSignal,
            }),
            downloadSignal,
          );
          assertActive();
          conversations.saveAttachment(attachment.id, { bytes });
        } catch (error) {
          if (!renewLease()) return;
          const code =
            error instanceof ImageValidationError
              ? error.code
              : error instanceof TelegramError
                ? `image_download_${error.code}`
                : "image_download_failed";
          const retryable =
            signal.aborted ||
            (error instanceof TelegramError &&
              ["network", "deadline", "cancelled", "server", "rate_limited"].includes(error.code));
          conversations.failAttachmentDownload(attachment.id, {
            code,
            ...(retryable && attachment.attempts < 3
              ? {
                  retryAt: retryAt(
                    attachment.attempts,
                    error instanceof TelegramError ? error.retryAfterSeconds : undefined,
                  ),
                }
              : {}),
          });
          if (error instanceof TelegramError && ["unauthorized", "conflict"].includes(error.code))
            failWorker(error.code);
        }
        continue;
      }
      const turn = conversations.startNextTurn();
      if (turn) {
        generationIdleMs = idleMs;
        if (turn.attempts > 3) {
          conversations.failGeneration(turn.id, { code: "attempts_exhausted" });
          continue;
        }
        if (turn.chatId !== ownerChatId) {
          conversations.failGeneration(turn.id, { code: "owner_mismatch" });
          continue;
        }
        try {
          assertActive();
          const deadline = AbortSignal.timeout(
            inferenceTimeoutMs(turn.snapshot.settings.model) + 5000,
          );
          const generationSignal = AbortSignal.any([signal, deadline]);
          const completion = await abortable(
            options.generate(turn.snapshot, generationSignal, turn.id),
            generationSignal,
          );
          if (!renewLease()) return;
          if (!completion.complete || !completion.text.trim()) {
            conversations.failGeneration(turn.id, {
              code: "incomplete_response",
              result: completion,
            });
          } else {
            conversations.completeGeneration(turn.id, {
              text: completion.text,
              chunks: splitTelegramText(completion.text),
              usage: completion.usage,
              requestId: completion.requestId,
              costUsd: completion.costUsd,
              serviceTier: completion.serviceTier,
              finishReason: completion.finishReason,
            });
          }
        } catch (error) {
          if (!renewLease()) return;
          const code = signal.aborted
            ? "cancelled"
            : error instanceof InferenceError
              ? error.code
              : error instanceof TelegramError && error.code === "cancelled"
                ? "deadline"
                : "invalid_response";
          const retryable =
            signal.aborted ||
            (error instanceof TelegramError && error.code === "cancelled") ||
            (error instanceof InferenceError && error.retryable);
          conversations.failGeneration(turn.id, {
            code,
            ...(retryable && turn.attempts < 3
              ? {
                  retryAt: retryAt(
                    turn.attempts,
                    error instanceof InferenceError ? error.retryAfterSeconds : undefined,
                  ),
                }
              : {}),
          });
        } finally {
          workIdleMs = idleMs;
          wakeWork?.();
        }
        continue;
      }
      await new Promise<void>((resolve) => {
        const idle = new AbortController();
        wakeGeneration = () => idle.abort();
        void delay(generationIdleMs, AbortSignal.any([signal, idle.signal])).then(() => {
          if (!idle.signal.aborted) generationIdleMs = Math.min(generationIdleMs * 2, 5000);
          wakeGeneration = undefined;
          resolve();
        });
      });
    }
  }

  async function processImageNotices() {
    if (!options.images) return;
    while (!signal.aborted) {
      assertActive();
      const notice = options.images?.service.claimFailureNotice();
      if (notice && options.images) {
        const images = options.images.service;
        try {
          assertActive();
          if (notice.chatId !== ownerChatId || !options.generateImageFailure)
            throw new TelegramError("configuration", true);
          const noticeSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(inferenceTimeoutMs(notice.snapshot.settings.model) + 5000),
          ]);
          const result = await abortable(
            options.generateImageFailure(notice.snapshot, notice.job, noticeSignal),
            noticeSignal,
          );
          if (!renewLease()) return;
          if (!result.complete || !result.text.trim() || result.text.length > 4096)
            images.failFailureNotice(notice.id, "incomplete_response");
          else images.completeFailureNotice(notice.id, result.text, result);
        } catch {
          if (!renewLease()) return;
          images.failFailureNotice(notice.id, "notice_generation_failed");
        } finally {
          workIdleMs = idleMs;
          wakeWork?.();
        }
        continue;
      }
      await delay(idleMs, signal);
    }
  }

  async function processScheduled(kind: OccurrenceKind) {
    const scheduled = options.reminders;
    if (!scheduled) return;
    while (!signal.aborted) {
      assertActive();
      scheduledStatus.lastTickAt = new Date().toISOString();
      if (kind === "checkin") scheduled.synchronize(ownerChatId);
      const claim = scheduled.service.claimPreparation({ chatId: ownerChatId, leaseOwner, kind });
      if (claim) {
        const interrupted = new AbortController();
        if (kind === "checkin") checkinGeneration = { controller: interrupted, claim };
        scheduledPreparing.add(kind);
        scheduledStatus.state = "preparing";
        try {
          const snapshot = scheduled.capture(claim);
          if (!scheduled.service.setSnapshot(claim, snapshot as unknown as Record<string, unknown>))
            continue;
          const generationSignal = AbortSignal.any([
            signal,
            interrupted.signal,
            AbortSignal.timeout(55000),
          ]);
          const pending = scheduled.generate(snapshot, generationSignal).then((generated) => {
            // Evidence may arrive after a fallback, cancellation or lease replacement.
            // The core journal checks the original fence without reviving the occurrence.
            scheduled.service.recordGenerationResult(claim, generated.completion);
            return generated;
          });
          const generated = await abortable(pending, generationSignal);
          if (!renewLease()) return;
          if (generated.decision === "speak")
            scheduled.service.prepare(claim, {
              text: generated.text,
              result: generated.completion,
            });
          else if (generated.decision === "silent")
            scheduled.service.silence(claim, generated.reason);
          else scheduled.service.failPreparation(claim, generated.reason, generated.completion);
          scheduledStatus.lastError = generated.decision === "rejected" ? generated.reason : null;
        } catch (error) {
          if (!renewLease()) return;
          const code =
            interrupted.signal.aborted || signal.aborted
              ? "cancelled"
              : error instanceof InferenceError || error instanceof ScheduledContextError
                ? error.code
                : "scheduled_generation_failed";
          scheduled.service.failPreparation(claim, code);
          scheduledStatus.lastError = code;
        } finally {
          if (kind === "checkin") checkinGeneration = undefined;
          scheduledPreparing.delete(kind);
          scheduledStatus.state = signal.aborted
            ? "stopped"
            : scheduledPreparing.size
              ? "preparing"
              : "waiting";
          workIdleMs = idleMs;
          wakeWork?.();
        }
      }
      if (!scheduledPreparing.size) scheduledStatus.state = "waiting";
      await delay(schedulerTickMs, signal);
    }
  }

  async function sendScheduled(kind: OccurrenceKind): Promise<boolean> {
    const scheduled = options.reminders;
    if (!scheduled) return false;
    const claim = scheduled.service.claimDelivery({ chatId: ownerChatId, leaseOwner, kind });
    if (!claim) return false;
    workIdleMs = idleMs;
    try {
      assertActive();
      if (claim.chatId !== ownerChatId || !claim.text)
        throw new TelegramError("configuration", true);
      const receipt = await abortable(
        transport.sendMessage({ chatId: ownerChatId, text: claim.text, signal }),
        signal,
      );
      // A known positive receipt is evidence even if the lease expired during the send.
      scheduled.service.recordDelivery(claim, { status: "sent", messageId: receipt.messageId });
      if (!renewLease()) return true;
    } catch (error) {
      if (!renewLease()) return true;
      const failure = error instanceof TelegramError ? error : new TelegramError("network");
      const retry = failure.definitive && failure.code === "rate_limited" && claim.attempts < 3;
      scheduled.service.recordDelivery(claim, {
        status: retry ? "retry" : failure.definitive ? "failed" : "unknown",
        code: failure.code,
        ...(retry ? { retryAt: retryAt(claim.attempts, failure.retryAfterSeconds) } : {}),
      });
      if (failure.code === "unauthorized" || failure.code === "conflict") failWorker(failure.code);
    }
    return true;
  }

  async function processWork() {
    let explicitFirst = true;
    while (!signal.aborted) {
      assertActive();
      if (checkinGeneration) {
        const current = options.reminders?.service.readOccurrence(checkinGeneration.claim.id);
        if (
          current?.status !== "generating" ||
          options.reminders?.stillCurrent?.(checkinGeneration.claim) === false
        )
          checkinGeneration.controller.abort();
      }
      if (explicitFirst && (await sendScheduled("explicit_reminder"))) {
        explicitFirst = false;
        continue;
      }
      const edit = messageEdits.claim(ownerChatId, leaseOwner);
      if (edit) {
        workIdleMs = idleMs;
        let remoteConfirmed = false;
        try {
          assertActive();
          if (!transport.editMessageText) throw new TelegramError("configuration", true);
          const receipt = await abortable(
            transport.editMessageText({
              chatId: edit.chatId,
              messageId: edit.telegramMessageId,
              text: edit.text,
              signal,
            }),
            signal,
          );
          remoteConfirmed = true;
          if (!renewLease()) return;
          messageEdits.finish(edit, { status: "applied", ...receipt });
        } catch (error) {
          if (!renewLease()) return;
          const failure = error instanceof TelegramError ? error : null;
          const code =
            failure?.code ??
            (remoteConfirmed ? "confirmation_not_saved" : "edit_processing_failed");
          messageEdits.finish(edit, {
            status: failure?.definitive ? "failed" : "unknown",
            code,
            ...(failure?.retryAfterSeconds
              ? { retryAfter: retryAt(edit.attempts, failure.retryAfterSeconds) }
              : {}),
          });
          if (["unauthorized", "conflict"].includes(code)) failWorker(code);
        }
        continue;
      }
      const delivery = conversations.claimDelivery();
      if (delivery) {
        explicitFirst = true;
        workIdleMs = idleMs;
        if (delivery.chatId !== ownerChatId) {
          conversations.recordDelivery(delivery.id, { status: "failed", code: "owner_mismatch" });
          continue;
        }
        try {
          assertActive();
          const receipt = await abortable(
            transport.sendMessage({
              chatId: delivery.chatId,
              text: delivery.text,
              signal,
            }),
            signal,
          );
          if (!renewLease()) return;
          conversations.recordDelivery(delivery.id, {
            status: "sent",
            messageId: receipt.messageId,
          });
        } catch (error) {
          if (!renewLease()) return;
          const failure = error instanceof TelegramError ? error : new TelegramError("network");
          if (failure.code === "rate_limited" && failure.definitive && delivery.attempts < 3) {
            conversations.recordDelivery(delivery.id, {
              status: "retry",
              code: failure.code,
              retryAt: retryAt(delivery.attempts, failure.retryAfterSeconds),
            });
          } else {
            conversations.recordDelivery(delivery.id, {
              status: failure.definitive ? "failed" : "unknown",
              code: failure.code,
            });
          }
          if (failure.code === "unauthorized" || failure.code === "conflict")
            failWorker(failure.code);
        } finally {
          generationIdleMs = idleMs;
          wakeGeneration?.();
        }
        continue;
      }
      const noticeDelivery = options.images?.service.claimFailureNoticeDelivery();
      if (noticeDelivery && options.images) {
        explicitFirst = true;
        const images = options.images.service;
        try {
          assertActive();
          if (noticeDelivery.chatId !== ownerChatId || !noticeDelivery.text)
            throw new TelegramError("configuration", true);
          const receipt = await abortable(
            transport.sendMessage({
              chatId: noticeDelivery.chatId,
              text: noticeDelivery.text,
              signal,
            }),
            signal,
          );
          if (!renewLease()) return;
          images.recordFailureNoticeDelivery(noticeDelivery.id, {
            status: "sent",
            messageId: receipt.messageId,
          });
        } catch (error) {
          if (!renewLease()) return;
          const failure = error instanceof TelegramError ? error : new TelegramError("network");
          images.recordFailureNoticeDelivery(noticeDelivery.id, {
            status: failure.definitive ? "failed" : "unknown",
            code: failure.code,
          });
          if (["unauthorized", "conflict"].includes(failure.code)) failWorker(failure.code);
        }
        continue;
      }
      const photo = options.images?.service.claimDelivery();
      if (photo && options.images) {
        explicitFirst = true;
        workIdleMs = idleMs;
        const images = options.images.service;
        if (photo.chatId !== ownerChatId || !transport.sendPhoto) {
          images.recordDelivery(photo.id, { status: "failed", code: "image_delivery_unavailable" });
          continue;
        }
        try {
          assertActive();
          const asset = images.getImage(photo.assetId);
          if (!asset) throw new TelegramError("configuration", true);
          const receipt = await abortable(
            transport.sendPhoto({
              chatId: photo.chatId,
              bytes: asset.bytes,
              replyToMessageId: photo.inputMessageId,
              signal,
            }),
            signal,
          );
          if (!renewLease()) return;
          images.recordDelivery(photo.id, { status: "sent", messageId: receipt.messageId });
        } catch (error) {
          if (!renewLease()) return;
          const failure = error instanceof TelegramError ? error : new TelegramError("network");
          if (failure.code === "rate_limited" && failure.definitive && photo.attempts < 3) {
            images.recordDelivery(photo.id, {
              status: "retry",
              code: failure.code,
              retryAt: retryAt(photo.attempts, failure.retryAfterSeconds),
            });
          } else {
            images.recordDelivery(photo.id, {
              status: failure.definitive ? "failed" : "unknown",
              code: failure.code,
            });
          }
          if (["unauthorized", "conflict"].includes(failure.code)) failWorker(failure.code);
        }
        continue;
      }
      if (await sendScheduled("explicit_reminder")) {
        explicitFirst = false;
        continue;
      }
      // All actual sends remain serialized; provider preparation runs independently.
      contextNotices?.reconcile(ownerChatId);
      const contextNotice = contextNotices?.claim(ownerChatId, leaseOwner);
      if (contextNotice && contextNotices) {
        workIdleMs = idleMs;
        try {
          assertActive();
          const receipt = await abortable(
            transport.sendMessage({
              chatId: ownerChatId,
              text: contextNotice.text,
              signal,
            }),
            signal,
          );
          if (!renewLease()) return;
          contextNotices.recordDelivery(contextNotice, {
            status: "sent",
            messageId: receipt.messageId,
          });
        } catch (error) {
          if (!renewLease()) return;
          const failure = error instanceof TelegramError ? error : new TelegramError("network");
          contextNotices.recordDelivery(contextNotice, {
            status:
              failure.definitive && failure.code === "rate_limited" && contextNotice.attempts < 3
                ? "retry"
                : failure.definitive
                  ? "failed"
                  : "unknown",
            code: failure.code,
            ...(failure.definitive && failure.code === "rate_limited" && contextNotice.attempts < 3
              ? { retryAt: retryAt(contextNotice.attempts, failure.retryAfterSeconds) }
              : {}),
          });
          if (["unauthorized", "conflict"].includes(failure.code)) failWorker(failure.code);
        }
        continue;
      }
      if (await sendScheduled("checkin")) continue;
      const heartbeat = options.heartbeats?.service.claimDelivery({
        chatId: ownerChatId,
        leaseOwner,
      });
      if (heartbeat && options.heartbeats) {
        try {
          assertActive();
          if (heartbeat.chatId !== ownerChatId || !heartbeat.text) {
            options.heartbeats.service.recordDelivery(heartbeat, {
              status: "failed",
              code: "owner_mismatch",
            });
            continue;
          }
          const receipt = await abortable(
            transport.sendMessage({
              chatId: ownerChatId,
              text: heartbeat.text,
              signal,
            }),
            signal,
          );
          if (!renewLease()) return;
          options.heartbeats.service.recordDelivery(heartbeat, {
            status: "delivered",
            telegramMessageId: receipt.messageId,
          });
        } catch (error) {
          if (!renewLease()) return;
          const failure = error instanceof TelegramError ? error : new TelegramError("network");
          options.heartbeats.service.recordDelivery(heartbeat, {
            status: failure.definitive ? "failed" : "unknown",
            code: failure.code,
          });
          if (failure.code === "unauthorized" || failure.code === "conflict")
            failWorker(failure.code);
        }
        continue;
      }
      await new Promise<void>((resolve) => {
        const idle = new AbortController();
        wakeWork = () => idle.abort();
        // New accepted messages wake immediately; otherwise reduce idle SQLite reads.
        // Deferred retries and manually queued work become eligible within five seconds.
        void delay(workIdleMs, AbortSignal.any([signal, idle.signal])).then(() => {
          if (!idle.signal.aborted) workIdleMs = Math.min(workIdleMs * 2, 5000);
          wakeWork = undefined;
          resolve();
        });
      });
    }
  }

  async function processHeartbeats() {
    const heartbeat = options.heartbeats;
    if (!heartbeat) return;
    while (!signal.aborted) {
      assertActive();
      heartbeatStatus.state = "waiting";
      heartbeatStatus.lastTickAt = new Date().toISOString();
      const run = heartbeat.service.claimOpportunity({ chatId: ownerChatId, leaseOwner });
      if (run) {
        const interrupted = new AbortController();
        heartbeatGeneration = interrupted;
        heartbeatStatus.state = "generating";
        try {
          const snapshot = heartbeat.capture(run);
          if (!heartbeat.service.setSnapshot(run, snapshot as unknown as Record<string, unknown>))
            continue;
          const generationSignal = AbortSignal.any([
            signal,
            interrupted.signal,
            AbortSignal.timeout(inferenceTimeoutMs(snapshot.settings.model, 90_000)),
          ]);
          const generated = await abortable(
            heartbeat.generate(snapshot, generationSignal, run.id),
            generationSignal,
          );
          if (!renewLease()) return;
          const completionResult =
            generated.decision === "speak"
              ? { ...generated.completion, text: generated.text }
              : generated.completion;
          heartbeat.service.recordGenerationResult(run, completionResult);
          if (interrupted.signal.aborted)
            heartbeat.service.suppress(run, "owner_input_changed", completionResult);
          else if (generated.decision === "speak") {
            heartbeat.service.prepare(run, completionResult);
            workIdleMs = idleMs;
            wakeWork?.();
          } else if (generated.decision === "silent") {
            heartbeat.service.silence(run, generated.reason, completionResult);
          } else heartbeat.service.fail(run, generated.reason, completionResult);
          heartbeatStatus.lastError = generated.decision === "rejected" ? "invalid_response" : null;
        } catch (error) {
          if (!renewLease()) return;
          if (interrupted.signal.aborted || signal.aborted) {
            heartbeat.service.suppress(
              run,
              interrupted.signal.aborted ? "owner_input_changed" : "shutdown",
            );
          } else {
            const code =
              error instanceof InferenceError || error instanceof HeartbeatContextError
                ? error.code
                : "generation_failed";
            heartbeat.service.fail(run, code);
            heartbeatStatus.lastError = code;
          }
        } finally {
          heartbeatGeneration = undefined;
          heartbeatStatus.state = signal.aborted ? "stopped" : "waiting";
        }
      }
      await delay(heartbeatTickMs, signal);
    }
  }

  try {
    startupActivityId = activity.append({
      kind: "telegram.worker",
      status: "pending",
      summary: "Starting Telegram text conversations and checking the bot connection.",
    }).id;
  } catch (error) {
    conversations.releaseTelegramLease(leaseOwner);
    throw error;
  }
  const renewal = setInterval(renewLease, 10_000);
  // Defer work until the caller has finished constructing the runtime.
  const guarded = (run: () => Promise<void>) =>
    Promise.resolve()
      .then(run)
      .catch(() => {
        if (!signal.aborted) failWorker("worker_failed");
      });
  const done = guarded(async () => {
    let attempts = 0;
    while (!signal.aborted) {
      try {
        assertActive();
        const identity = await abortable(transport.inspect(signal), signal);
        assertActive();
        if (identity.botId !== options.token.split(":")[0]) {
          failWorker("bot_identity_mismatch");
          return;
        }
        if (identity.webhookActive) {
          failWorker("webhook_active");
          return;
        }
        try {
          conversations.bindTelegramBot(identity.botId);
        } catch {
          failWorker("bot_identity_mismatch");
          return;
        }
        conversations.recoverInterrupted();
        messageEdits.recover(leaseOwner);
        options.images?.service.recoverInterrupted();
        options.heartbeats?.service.recoverInterrupted(leaseOwner);
        contextNotices?.recover(leaseOwner);
        options.reminders?.service.recoverInterrupted(leaseOwner);
        const imageWorker = options.images;
        await Promise.all([
          guarded(poll),
          guarded(processWork),
          guarded(processConversation),
          ...(options.images ? [guarded(processImageNotices)] : []),
          ...(imageWorker ? [guarded(() => imageWorker.run(signal, assertActive))] : []),
          ...(options.heartbeats ? [guarded(processHeartbeats)] : []),
          ...(options.reminders
            ? [
                guarded(() => processScheduled("explicit_reminder")),
                guarded(() => processScheduled("checkin")),
              ]
            : []),
        ]);
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof TelegramError)) throw error;
        if (["configuration", "unauthorized", "conflict", "rejected"].includes(error.code)) {
          failWorker(error.code);
          return;
        }
        attempts += 1;
        status.state = "reconnecting";
        status.lastError = error.code;
        await delay(
          Math.max(1, Date.parse(retryAt(attempts, error.retryAfterSeconds)) - Date.now()),
          signal,
        );
      }
    }
  }).then(() => {
    clearInterval(renewal);
    wakeWork = undefined;
    wakeGeneration = undefined;
    if (owned) {
      settleStartup(false);
      options.heartbeats?.service.recoverInterrupted(leaseOwner);
      contextNotices?.recover(leaseOwner);
      options.reminders?.service.recoverInterrupted(leaseOwner);
      conversations.releaseTelegramLease(leaseOwner);
    }
    owned = false;
    if (status.state !== "failed") status.state = "stopped";
    heartbeatStatus.state = status.state === "failed" ? "failed" : "stopped";
    scheduledStatus.state = status.state === "failed" ? "failed" : "stopped";
  });
  return {
    status: () => ({
      ...status,
      ...(options.heartbeats ? { heartbeat: { ...heartbeatStatus } } : {}),
      ...(options.reminders ? { scheduled: { ...scheduledStatus } } : {}),
    }),
    stop() {
      controller.abort();
      return done;
    },
  };
}
