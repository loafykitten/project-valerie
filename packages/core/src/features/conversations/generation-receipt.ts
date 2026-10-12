import type { ConversationGenerationResult } from "./service";

/** Validate the provider receipt fields stored with a conversation or heartbeat generation. */
export function validateGenerationReceipt(result: ConversationGenerationResult): void {
  if (
    result.usage &&
    Object.values(result.usage).some(
      (value) =>
        value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0),
    )
  )
    throw new TypeError("Usage counts must be nonnegative integers.");
  if (
    result.costUsd !== undefined &&
    result.costUsd !== null &&
    (!Number.isFinite(result.costUsd) || result.costUsd < 0)
  )
    throw new TypeError("Invalid inference cost.");
  if (
    result.requestId !== undefined &&
    result.requestId !== null &&
    !/^[a-z0-9_.:/-]{1,200}$/i.test(result.requestId)
  )
    throw new TypeError("Invalid provider request identifier.");
  if (result.finishReason !== undefined && !/^[a-z0-9_.-]{1,100}$/i.test(result.finishReason))
    throw new TypeError("Invalid finish reason.");
}
