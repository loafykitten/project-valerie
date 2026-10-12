import type { ConversationGenerationResult } from "../conversations/service";

export interface HeartbeatSettings {
  version: number;
  enabled: boolean;
  timezone: string;
  activeStart: string;
  activeEnd: string;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  minIdleMinutes: number;
  maxPerDay: number;
  maxUnanswered: number;
  maxMessageChars: number;
  paused: boolean;
  pausedUntil: string | null;
  updatedAt: string;
}

export type HeartbeatSettingsInput = Omit<HeartbeatSettings, "version" | "updatedAt"> & {
  expectedVersion: number;
};

export type HeartbeatRunStatus =
  | "generating"
  | "prepared"
  | "sending"
  | "delivered"
  | "unknown"
  | "failed"
  | "silent"
  | "suppressed";

export type HeartbeatBlockReason =
  | "disabled"
  | "paused"
  | "no_owner_chat"
  | "no_owner_input"
  | "quiet_hours"
  | "conversation_pending"
  | "recent_conversation"
  | "minimum_interval"
  | "daily_limit"
  | "unanswered_limit"
  | "active_run"
  | "settings_changed"
  | "owner_input_changed";

export interface HeartbeatClaim {
  id: string;
  fence: string;
  leaseOwner: string;
}

export interface HeartbeatRun extends HeartbeatClaim {
  chatId: string;
  status: HeartbeatRunStatus;
  settings: HeartbeatSettings;
  inputWatermark: number;
  wakingDay: string;
  snapshot: Record<string, unknown> | null;
  text: string | null;
  result: ConversationGenerationResult | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  deliveryStartedAt: string | null;
  deliveredAt: string | null;
  telegramMessageId: string | null;
}

export interface HeartbeatStatus {
  enabled: boolean;
  paused: boolean;
  activeNow: boolean;
  wakingDay: string;
  nextOpportunityAt: string | null;
  latestOwnerInputAt: string | null;
  deliveredToday: number;
  unknownToday: number;
  sendingToday: number;
  unansweredCount: number;
  blockingReason: HeartbeatBlockReason | null;
  activeRunId: string | null;
}

export interface HeartbeatHistoryItem {
  id: string;
  text: string;
  deliveredAt: string;
}

export class HeartbeatSettingsConflictError extends Error {
  constructor() {
    super("Heartbeat settings changed. Reload before saving.");
    this.name = "HeartbeatSettingsConflictError";
  }
}
