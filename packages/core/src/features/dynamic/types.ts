export type DynamicAuthor = "owner" | "valerie";
export type GrowthFocusState = "active" | "paused" | "archived";
export type GrowthFocusPhase = GrowthFocusState | "scheduled";

export interface DynamicPermissions {
  manageFocus: boolean;
  logNotes: boolean;
  manageWaking?: boolean;
  manageProgress?: boolean;
  manageHabits?: boolean;
  manageRules?: boolean;
  manageReminders?: boolean;
}

export interface DynamicSettings {
  version: number;
  allowValerieManageFocus: boolean;
  allowValerieLogNotes: boolean;
  allowValerieManageWaking?: boolean;
  allowValerieManageProgress?: boolean;
  allowValerieManageHabits?: boolean;
  allowValerieManageRules?: boolean;
  allowValerieManageReminders?: boolean;
  updatedAt: string;
}

export interface DynamicSource {
  type: "conversation" | "owner_entry";
  id: string;
  observedAt: string;
  role: "user" | "owner";
}

export interface GrowthFocusFields {
  title: string;
  reason: string;
  startDate: string;
  reviewDate: string;
  practices: string[];
  indicators: string[];
}

export interface GrowthFocus extends GrowthFocusFields {
  id: string;
  version: number;
  state: GrowthFocusState;
  phase: GrowthFocusPhase;
  reviewDue: boolean;
  /** Evidence for the current descriptive content, retained across state-only edits. */
  sources: DynamicSource[];
  /** Evidence for the latest active/paused/archived decision, independently bounded. */
  stateSources: DynamicSource[];
  authoredBy: DynamicAuthor;
  createdAt: string;
  updatedAt: string;
}

export interface GrowthFocusSaveInput extends GrowthFocusFields {
  id?: string;
  expectedVersion?: number;
  sourceIds?: string[];
}

export interface DynamicMutationContext {
  actor: DynamicAuthor;
  turnId?: string;
  operationKey?: string;
  /** The permissions pinned when this model turn began; never inferred from prose. */
  permissions?: DynamicPermissions;
}

export interface DynamicProgressNote {
  id: string;
  focusId: string;
  body: string;
  kind: "owner_report" | "valerie_interpretation";
  authoredBy: DynamicAuthor;
  sources: DynamicSource[];
  createdAt: string;
  supersedesNoteId: string | null;
  superseded: boolean;
}

export interface DynamicNoteInput {
  focusId: string;
  expectedFocusVersion: number;
  body: string;
  kind: DynamicProgressNote["kind"];
  sourceIds?: string[];
  supersedesNoteId?: string;
}

export interface DynamicPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type GrowthFocusSummary = Omit<
  GrowthFocus,
  "sources" | "stateSources" | "createdAt" | "updatedAt" | "authoredBy"
>;

export interface DynamicSnapshot {
  capturedAt: string;
  settingsVersion: number;
  permissions: DynamicPermissions;
  focus: GrowthFocusSummary | null;
  content: string;
}

export class DynamicConflictError extends Error {
  constructor(message = "Growth Focus changed. Load the saved version before saving again.") {
    super(message);
    this.name = "DynamicConflictError";
  }
}

export class DynamicPermissionError extends Error {
  constructor(
    readonly scope:
      | "manageFocus"
      | "logNotes"
      | "manageWaking"
      | "manageProgress"
      | "manageHabits"
      | "manageRules"
      | "manageReminders",
  ) {
    super("The owner has not delegated this action for this turn, or has withdrawn permission.");
    this.name = "DynamicPermissionError";
  }
}

export class DynamicOperationConflictError extends DynamicConflictError {
  constructor() {
    super("This operation was already used for a different edit. No new edit was made.");
    this.name = "DynamicOperationConflictError";
  }
}

/** All messages are fixed validation guidance and contain no submitted private prose. */
export class DynamicValidationError extends TypeError {
  constructor(
    readonly field: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "DynamicValidationError";
  }
}
