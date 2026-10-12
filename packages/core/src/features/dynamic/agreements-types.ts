import type { BehaviorProgress, DailyEvent, ProgressStatus, ReportedTime } from "./daily-types";
import type { DynamicAuthor, DynamicSettings, DynamicSource } from "./types";

export type AgreementState = "active" | "paused" | "archived";
export type CheckinSlot = "morning" | "evening";
export interface AgreementPermissions {
  manageHabits: boolean;
  manageRules: boolean;
  manageReminders?: boolean;
}
export interface AgreementMutationContext {
  actor: DynamicAuthor;
  turnId?: string;
  operationKey?: string;
  permissions?: AgreementPermissions;
}
export interface AgreementRecord {
  id: string;
  version: number;
  state: AgreementState;
  sources: DynamicSource[];
  stateSources: DynamicSource[];
  authoredBy: DynamicAuthor;
  createdAt: string;
  updatedAt: string;
}
export type HabitCadence = { kind: "every_waking_day" } | { kind: "weekdays"; weekdays: number[] };
export interface HabitFields {
  name: string;
  reason: string;
  behaviorId: string;
  fullPractice: string;
  smallerPractice: string | null;
  cadence: HabitCadence;
  slots: CheckinSlot[];
  effectiveAt: string;
  threshold: number | null;
}
export interface HabitDefinition extends AgreementRecord, HabitFields {}
export interface HabitSaveInput extends HabitFields {
  id?: string;
  expectedVersion?: number;
  sourceIds?: string[];
}
export type HabitOutcome =
  | "done"
  | "smaller_done"
  | "partial"
  | "skipped"
  | "excused"
  | "not_reported"
  | "uncertain"
  | "not_applicable";
export interface HabitOpportunity {
  id: string;
  version: number;
  habitId: string;
  wakingDayId: string;
  definitionVersion: number;
  definition: HabitDefinition;
  establishedAt: string;
  applicable: boolean | null;
  applicabilityReason: string;
  localStartDate: string | null;
  outcome: HabitOutcome;
  variant: "full" | "smaller" | null;
  progress: BehaviorProgress;
  eventIds: string[];
  variantRecordId: string | null;
  reported: boolean;
}
export interface HabitVariantRecord {
  id: string;
  version: number;
  state: "active" | "voided";
  opportunityId: string;
  habitId: string;
  wakingDayId: string;
  definitionVersion: number;
  eventId: string;
  eventVersion: number;
  eventMeaningHash: string;
  variant: "full" | "smaller";
  sources: DynamicSource[];
  revisionSources: DynamicSource[];
  authoredBy: DynamicAuthor;
  createdAt: string;
  updatedAt: string;
}
export interface HabitVariantInput {
  habitId: string;
  wakingDayId: string;
  definitionVersion: number;
  eventId: string;
  expectedEventVersion: number;
  variant: "full" | "smaller";
  sourceIds?: string[];
  id?: string;
  expectedVersion?: number;
}
export interface RuleWindow {
  start: string;
  end: string;
  weekdays: number[];
}
export type RuleCondition =
  | { behaviorId: string; comparison: "at_least" | "at_most" | "equals"; value: number }
  | { behaviorId: string; comparison: "status_is"; status: ProgressStatus };
export interface RuleFields {
  name: string;
  meaning: string;
  reason: string;
  scope: string;
  effectiveAt: string;
  expiresAt: string | null;
  timezone: string;
  window: RuleWindow | null;
  exceptions: string[];
  condition: RuleCondition | null;
}
export interface RuleDefinition extends AgreementRecord, RuleFields {}
export interface RuleSaveInput extends RuleFields {
  id?: string;
  expectedVersion?: number;
  sourceIds?: string[];
}
export type RulePhase = AgreementState | "scheduled" | "expired" | "outside_window";
export interface RuleView {
  rule: RuleDefinition;
  phase: RulePhase;
  applicable: boolean;
  conditionResult:
    | "met"
    | "not_met"
    | "not_reported"
    | "uncertain"
    | "not_applicable"
    | "not_configured";
  progress: BehaviorProgress | null;
}
export interface RuleReviewNote {
  id: string;
  ruleId: string;
  ruleVersion: number;
  wakingDayId: string | null;
  summary: string;
  kind: "owner_report" | "valerie_interpretation";
  disposition: "understood" | "excepted" | "uncertain";
  occurred: ReportedTime;
  applicableAtReport: boolean | null;
  sources: DynamicSource[];
  authoredBy: DynamicAuthor;
  createdAt: string;
}
export interface RuleNoteInput {
  ruleId: string;
  ruleVersion: number;
  wakingDayId: string | null;
  summary: string;
  kind: RuleReviewNote["kind"];
  disposition: RuleReviewNote["disposition"];
  occurred: ReportedTime;
  sourceIds?: string[];
}
export interface AgreementQuestion {
  key: string;
  habitId: string;
  definitionVersion: number;
  wakingDayId: string;
  name: string;
  prompt: string;
  outcome: HabitOutcome;
  slots: CheckinSlot[];
}
export interface HabitMetricCounts {
  opportunities: number;
  applicable: number;
  reported: number;
  coverage: number | null;
  outcomes: Record<HabitOutcome, number>;
}
export interface HabitMetricPeriod extends HabitMetricCounts {
  key: string;
  habitId: string;
  localStartDate: string | null;
}
export interface HabitMetrics {
  period: "day" | "week" | "month";
  counts: HabitMetricCounts;
  range: {
    dayLimit: number;
    wakingDays: number;
    fromLocalDate: string | null;
    toLocalDate: string | null;
  };
  habits: { habitId: string; name: string; counts: HabitMetricCounts }[];
  periods: HabitMetricPeriod[];
  unassignedReports: number;
  uncertainTimingReports: number;
  recentObstacles: DailyEvent[];
}
export interface AgreementSnapshot {
  capturedAt: string;
  revision: string;
  settingsVersion: number;
  permissions: AgreementPermissions;
  rules: RuleView[];
  habits: { id: string; version: number; name: string; state: AgreementState }[];
  content: string;
}
export interface AgreementOverview {
  settings: DynamicSettings;
  habits: HabitDefinition[];
  rules: RuleView[];
  opportunities: HabitOpportunity[];
  metrics: HabitMetrics;
}
