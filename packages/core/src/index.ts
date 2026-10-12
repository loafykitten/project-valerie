export {
  type Activity,
  type ActivityQuery,
  type ActivityService,
  type ActivityStatus,
  createActivityService,
} from "./features/activity/service";
export {
  CharacterCardError,
  type CharacterCardFields,
  type CharacterCardPreview,
  parseCharacterCard,
} from "./features/character/parse";
export {
  type CharacterFieldMapping,
  CharacterImportConflictError,
  type CharacterImportInput,
  type CharacterImportMetadata,
  type CharacterImportResult,
  type CharacterPreservedOnly,
  type CharacterService,
  createCharacterService,
} from "./features/character/service";
export type { ContextNotice } from "./features/context-health/notices";
export { createContextNoticeService } from "./features/context-health/notices";
export { createContextHealthService } from "./features/context-health/service";
export type {
  ContextHealthReport,
  ContextRequestInput,
  ContextRequestRecord,
  ContextSignal,
  ContextSourceKind,
  ContextSourceReport,
  ContextTokenUsage,
} from "./features/context-health/types";
export type { EditableMessage, MessageEdit } from "./features/conversations/edits";
export {
  createMessageEditService,
  MessageEditConflictError,
  MessageEditNotFoundError,
} from "./features/conversations/edits";
export {
  IMAGE_TOKEN_ALLOWANCE,
  type ImageMetadata,
  type ImageMimeType,
  ImageValidationError,
  inspectImageBytes,
  MAX_CONTEXT_IMAGE_BYTES,
  MAX_CONTEXT_IMAGES,
  MAX_CURRENT_IMAGES,
  MAX_HISTORY_IMAGES,
  MAX_IMAGE_BYTES,
} from "./features/conversations/images";
export {
  readTelegramSourceMetadata,
  type TelegramSourceMetadata,
  validateTelegramSourceMetadata,
} from "./features/conversations/provenance";
export {
  type ArchivedAttachment,
  type AttachmentDownload,
  type ConversationAttachmentSummary,
  type ConversationContentPart,
  type ConversationDelivery,
  type ConversationGenerationResult,
  type ConversationMessage,
  type ConversationService,
  type ConversationSnapshot,
  type ConversationTurn,
  type ConversationTurnStatus,
  type ConversationTurnSummary,
  createConversationService,
  type InferenceModelCapabilities,
  type InferenceReasoningEffort,
  type InferenceSettings,
  InferenceSettingsConflictError,
  type InferenceSettingsInput,
  type TelegramImageInput,
  type TelegramInput,
} from "./features/conversations/service";
export { rulePhaseAt } from "./features/dynamic/agreement-time";
export { type AgreementService, createAgreementService } from "./features/dynamic/agreements";
export type {
  AgreementMutationContext,
  AgreementOverview,
  AgreementPermissions,
  AgreementQuestion,
  AgreementRecord,
  AgreementSnapshot,
  AgreementState,
  CheckinSlot,
  HabitCadence,
  HabitDefinition,
  HabitFields,
  HabitMetricCounts,
  HabitMetricPeriod,
  HabitMetrics,
  HabitOpportunity,
  HabitOutcome,
  HabitSaveInput,
  HabitVariantInput,
  HabitVariantRecord,
  RuleCondition,
  RuleDefinition,
  RuleFields,
  RuleNoteInput,
  RulePhase,
  RuleReviewNote,
  RuleSaveInput,
  RuleView,
  RuleWindow,
} from "./features/dynamic/agreements-types";
export { createDailyService, type DailyService } from "./features/dynamic/daily";
export type {
  BehaviorProgress,
  CheckinWindow,
  DailyEvent,
  DailyEventEdit,
  DailyMutationContext,
  DailyOverview,
  DailyPermissions,
  DailySnapshot,
  DailyWriteResult,
  ProgressBehavior,
  ProgressMode,
  ProgressReport,
  ProgressReportInput,
  ProgressStatus,
  ReportedTime,
  WakingDay,
  WakingReport,
  WakingReportInput,
  WakingReportKind,
  WakingState,
} from "./features/dynamic/daily-types";
export { createDynamicService, type DynamicService } from "./features/dynamic/service";
export {
  calculateCheckinWindow,
  dailyInstant,
  dailyTimezone,
  resolveDailyLocalTime,
  resolveDailyRelativeTime,
  validateReportedTime,
} from "./features/dynamic/time";
export {
  type DynamicAuthor,
  DynamicConflictError,
  type DynamicMutationContext,
  type DynamicNoteInput,
  DynamicOperationConflictError,
  type DynamicPage,
  DynamicPermissionError,
  type DynamicPermissions,
  type DynamicProgressNote,
  type DynamicSettings,
  type DynamicSnapshot,
  type DynamicSource,
  DynamicValidationError,
  type GrowthFocus,
  type GrowthFocusFields,
  type GrowthFocusPhase,
  type GrowthFocusSaveInput,
  type GrowthFocusState,
  type GrowthFocusSummary,
} from "./features/dynamic/types";
export {
  type ConfirmedHeartbeatText,
  createHeartbeatContextService,
  HEARTBEAT_SILENT_MARKER,
  HeartbeatContextError,
  type HeartbeatContextInput,
  type HeartbeatContextMessage,
  type HeartbeatSnapshot,
} from "./features/heartbeat/context";
export { createHeartbeatService, type HeartbeatService } from "./features/heartbeat/service";
export {
  type HeartbeatBlockReason,
  type HeartbeatClaim,
  type HeartbeatHistoryItem,
  type HeartbeatRun,
  type HeartbeatRunStatus,
  type HeartbeatSettings,
  HeartbeatSettingsConflictError,
  type HeartbeatSettingsInput,
  type HeartbeatStatus,
} from "./features/heartbeat/types";
export {
  createImageJobService,
  type GeneratedImage,
  type ImageDelivery,
  type ImageFailureNotice,
  type ImageFailureNoticeDelivery,
  type ImageJob,
  type ImageJobInput,
  type ImageJobService,
  type ImageJobStatus,
  type ImageToolInvocation,
} from "./features/image-generation/service";
export {
  createMemoryService,
  MemoryBudgetError,
  MemoryConflictError,
  MemoryCursorError,
  MemoryDuplicateError,
  MemorySaveValidationError,
  type MemoryService,
} from "./features/memory/service";
export type {
  ConversationEvidence,
  ConversationSearchItem,
  MemoryKind,
  MemoryPage,
  MemoryProvenance,
  MemoryRecord,
  MemorySaveInput,
  MemorySearchInput,
  MemorySearchItem,
  MemorySettings,
  MemorySnapshot,
  MemoryStatus,
  MemoryTier,
  NoteFolder,
  NoteLibraryPage,
  VaultIngestNote,
  VaultIngestScan,
} from "./features/memory/types";
export {
  defaultHeartbeatPrompt,
  defaultImageGenerationPrompt,
  defaultReminderPrompt,
} from "./features/prompts/seeds";
export {
  type CommunicationChannel,
  communicationChannels,
  createPromptService,
  MAX_PROMPT_BYTES,
  type Prompt,
  type PromptCatalog,
  PromptConflictError,
  PromptNotFoundError,
  PromptOrderConflictError,
  PromptOrderValidationError,
  type PromptRevision,
  type PromptService,
  type PromptSnapshot,
} from "./features/prompts/service";
export type { ReminderService } from "./features/reminders/service";
export { createReminderService } from "./features/reminders/service";
export type {
  CheckinCandidate,
  CheckinContext,
  CheckinQuestion,
  CheckinSettings,
  OccurrenceKind,
  OccurrenceStatus,
  Reminder,
  ReminderFields,
  ReminderMutationContext,
  ReminderOverview,
  ReminderPermissions,
  ReminderSaveInput,
  ScheduledClaim,
  ScheduledOccurrence,
} from "./features/reminders/types";
export {
  CHECKIN_SILENT_MARKER,
  ReminderConflictError,
  ReminderValidationError,
} from "./features/reminders/types";
export {
  type ConversationToolCapabilities,
  type ConversationToolCatalog,
  type ConversationToolSchema,
  validateConversationToolCatalog,
} from "./features/tools/catalog";
export { openStore, type Store } from "./store";
