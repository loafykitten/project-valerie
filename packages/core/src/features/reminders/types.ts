import type { DynamicAuthor, DynamicSource } from "../dynamic/types";

export const CHECKIN_SILENT_MARKER = "[[CHECKIN_SILENT]]";

export interface ReminderPermissions {
  manageReminders: boolean;
}
export interface ReminderMutationContext {
  actor: DynamicAuthor;
  turnId?: string;
  operationKey?: string;
  permissions?: ReminderPermissions;
}
export interface ReminderFields {
  title: string;
  purpose: string;
  dueAt: string;
  timezone: string;
  originalTimeIntent: string;
  expiresAt: string | null;
  /** Saved consent for a simple title-based message if usual preparation fails. */
  allowFallback: boolean;
}
export interface Reminder extends ReminderFields {
  id: string;
  version: number;
  state: "active" | "completed" | "cancelled" | "expired";
  currentOccurrenceId: string;
  sources: DynamicSource[];
  stateSources: DynamicSource[];
  authoredBy: DynamicAuthor;
  createdAt: string;
  updatedAt: string;
}
export interface ReminderSaveInput extends ReminderFields {
  id?: string;
  expectedVersion?: number;
  sourceIds?: string[];
}
export type OccurrenceKind = "explicit_reminder" | "checkin";
export type OccurrenceStatus =
  | "scheduled"
  | "generating"
  | "prepared"
  | "sending"
  | "retry"
  | "sent"
  | "silent"
  | "suppressed"
  | "failed"
  | "unknown"
  | "cancelled"
  | "expired";
export interface CheckinQuestion {
  key: string;
  title: string;
  detail: string;
  habitId?: string;
  habitVersion?: number;
  behaviorId?: string;
}
export interface CheckinContext {
  dayId: string;
  /** Captured from the current day; a changed owner plan may reopen an expired unsent evening. */
  sleepPlanEventId?: string | null;
  slots: ("morning" | "evening")[];
  questionKeys: string[];
  questions: CheckinQuestion[];
  dailyRevision: string;
  agreementRevision: string;
  settingsVersion: number;
  inputWatermark: number;
}
export interface ScheduledOccurrence {
  id: string;
  kind: OccurrenceKind;
  reminderId: string | null;
  reminderVersion: number | null;
  chatId: string | null;
  inputWatermark: number;
  dueAt: string;
  earliestAt: string;
  expiresAt: string | null;
  status: OccurrenceStatus;
  title: string;
  purpose: string;
  timezone: string;
  allowFallback: boolean;
  checkin: CheckinContext | null;
  fence: string | null;
  leaseOwner: string | null;
  snapshot: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  text: string | null;
  usedFallback: boolean;
  attempts: number;
  nextAttemptAt: string | null;
  telegramMessageId: string | null;
  deliveredAt: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduledClaim extends ScheduledOccurrence {
  fence: string;
  leaseOwner: string;
  chatId: string;
}
export interface CheckinSettings {
  version: number;
  enabled: boolean;
  morningDelayMinutes: number;
  eveningLeadMinutes: number;
  minIdleMinutes: number;
  maxMessageChars: number;
  updatedAt: string;
}
export interface CheckinCandidate {
  dayId: string;
  slots: ("morning" | "evening")[];
  questions: CheckinQuestion[];
  dailyRevision: string;
  agreementRevision: string;
  inputWatermark: number;
  dueAt: string;
  earliestAt: string;
  expiresAt: string;
  timezone: string;
}
export interface ReminderOverview {
  reminders: Reminder[];
  occurrences: ScheduledOccurrence[];
  checkinSettings: CheckinSettings;
  permissions: ReminderPermissions;
  permissionsVersion: number;
}
export class ReminderConflictError extends Error {
  constructor(message = "This reminder changed. Read its latest version before changing it.") {
    super(message);
    this.name = "ReminderConflictError";
  }
}
export class ReminderValidationError extends TypeError {
  constructor(
    readonly field: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "ReminderValidationError";
  }
}
