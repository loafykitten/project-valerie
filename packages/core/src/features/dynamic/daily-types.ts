import type { DynamicAuthor, DynamicSettings, DynamicSource } from "./types";

export interface DailyPermissions {
  manageWaking: boolean;
  manageProgress: boolean;
}
export interface DailyMutationContext {
  actor: DynamicAuthor;
  turnId?: string;
  operationKey?: string;
  permissions?: DailyPermissions;
}
export interface ReportedTime {
  at: string | null;
  timezone: string;
  basis: "exact" | "relative" | "message_time" | "unknown";
  originalLocalIntent?: string;
}
export type WakingState = "awake_reported" | "main_sleep_intended" | "nap_intended" | "unknown";
export type WakingReportKind =
  | "day_start"
  | "main_wake"
  | "awake_update"
  | "main_sleep_intent"
  | "nap_intent"
  | "nap_wake"
  | "sleep_plan"
  | "uncertain";
export interface WakingDay {
  id: string;
  version: number;
  current: boolean;
  wakeTime: ReportedTime;
  /** A reported day boundary does not assert that physical sleep occurred. */
  startReport?: "main_wake" | "day_start";
  wakeEventId: string | null;
  wakeReceivedAt: string | null;
  morningEligible: boolean;
  state: WakingState;
  stateEventId: string | null;
  expectedSleepAt: string | null;
  sleepEstimateBasis: "owner_plan" | "usual_routine" | "none";
  sleepPlanEventId: string | null;
  inputWatermark: number | null;
  mergedIntoDayId: string | null;
  closedReason: "next_main_wake_reported" | "next_day_start_reported" | "merged" | null;
  createdAt: string;
  updatedAt: string;
}
export interface WakingReport {
  kind: "waking";
  report: WakingReportKind;
  expectedSleepAt?: string | null;
  sleepEstimateBasis?: WakingDay["sleepEstimateBasis"];
}
export type ProgressStatus = "done" | "partial" | "skipped" | "excused";
export type ProgressMode = "occurrence" | "total_so_far" | "status" | "plan" | "interpretation";
export interface ProgressReport {
  kind: "progress";
  behaviorId: string;
  behaviorVersion: number;
  mode: ProgressMode;
  value?: number;
  status?: ProgressStatus;
  totalThroughAt?: string;
  plannedFor?: string;
}
export interface DailyEvent {
  id: string;
  version: number;
  state: "active" | "voided";
  wakingDayId: string | null;
  evidenceKind: "owner_report" | "integration_observation" | "valerie_interpretation";
  occurred: ReportedTime;
  recordedAt: string;
  updatedAt: string;
  authoredBy: DynamicAuthor;
  sources: DynamicSource[];
  revisionSources: DynamicSource[];
  summary: string;
  stateApplied: boolean;
  inputWatermark: number | null;
  payload: WakingReport | ProgressReport | { kind: "day_merge"; fromId: string; intoId: string };
}
export interface ProgressBehavior {
  id: string;
  version: number;
  name: string;
  unit: string;
  valueKind: "count" | "status";
  aggregation: "count" | "latest_status";
  state: "active" | "archived";
  sources: DynamicSource[];
  createdAt: string;
  updatedAt: string;
}
export interface BehaviorProgress {
  behaviorId: string;
  wakingDayId: string;
  value: number | null;
  status: ProgressStatus | null;
  basis:
    | "not_reported"
    | "occurrences"
    | "reported_total"
    | "reported_total_plus_occurrences"
    | "status_report"
    | "uncertain"
    | "conflicting";
  asOf: string | null;
  reportedTotal: number | null;
  eventIds: string[];
  unresolvedEventIds: string[];
}
export interface CheckinWindow {
  dayId: string;
  dayVersion: number;
  slot: "morning" | "evening";
  sourceEventId: string;
  earliestAt: string;
  preferredAt: string;
  expiresAt: string;
  inputWatermark: number | null;
}
export interface DailyWriteResult {
  effect: "created" | "updated" | "already_recorded" | "needs_clarification";
  event: DailyEvent | null;
  day: WakingDay | null;
  reason?: string;
}
export interface WakingReportInput {
  report: WakingReportKind;
  expectedCurrentDayId: string | null;
  expectedDayVersion: number | null;
  mode: "current" | "history";
  wakingDayId?: string | null;
  occurred: ReportedTime;
  summary: string;
  sourceIds?: string[];
  evidenceQuote?: string;
  newMainPeriod?: boolean;
  expectedSleepAt?: string | null;
  sleepEstimateBasis?: WakingDay["sleepEstimateBasis"];
}
export interface ProgressReportInput {
  behaviorId: string;
  wakingDayId: string | null;
  occurred: ReportedTime;
  summary: string;
  mode: ProgressMode;
  value?: number;
  status?: ProgressStatus;
  totalThroughAt?: string;
  plannedFor?: string;
  sameEventId?: string;
  expectedEventVersion?: number;
  sourceIds?: string[];
  evidenceKind?: "owner_report" | "valerie_interpretation";
}
export interface DailyEventEdit {
  id: string;
  expectedVersion: number;
  summary?: string;
  occurred?: ReportedTime;
  wakingDayId?: string | null;
  progress?: Omit<
    ProgressReportInput,
    "behaviorId" | "wakingDayId" | "occurred" | "summary" | "sameEventId" | "expectedEventVersion"
  >;
  sourceIds?: string[];
}
export interface DailyOverview {
  settings: DynamicSettings;
  currentDay: WakingDay | null;
  days: WakingDay[];
  behaviors: ProgressBehavior[];
  events: DailyEvent[];
  progress: BehaviorProgress[];
  windows: CheckinWindow[];
}
export interface DailySnapshot {
  revision: string;
  capturedAt: string;
  settingsVersion: number;
  permissions: DailyPermissions;
  currentDay: Omit<WakingDay, "createdAt" | "updatedAt"> | null;
  progress: BehaviorProgress[];
  content: string;
}
