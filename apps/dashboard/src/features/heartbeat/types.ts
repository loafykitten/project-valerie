export type HeartbeatSettings = {
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
};

export type HeartbeatStatus = {
  enabled: boolean;
  paused: boolean;
  activeNow: boolean;
  wakingDay: string;
  nextOpportunityAt: string | null;
  latestOwnerInputAt: string | null;
  deliveredToday: number;
  unansweredCount: number;
  unknownToday: number;
  sendingToday: number;
  blockingReason: string | null;
  activeRunId: string | null;
};

export type HeartbeatRuntimeStatus = {
  state: string;
  lastError: string | null;
  lastTickAt: string | null;
};

export type HeartbeatRunSummary = {
  id: string;
  status: string;
  reason: string | null;
  createdAt: string;
  finishedAt: string | null;
  deliveredAt: string | null;
};

export type HeartbeatState = {
  settings: HeartbeatSettings;
  status: HeartbeatStatus;
  runtime: HeartbeatRuntimeStatus;
  recentRuns: HeartbeatRunSummary[];
};

export type HeartbeatDraft = Pick<
  HeartbeatSettings,
  | "version"
  | "enabled"
  | "timezone"
  | "activeStart"
  | "activeEnd"
  | "minIntervalMinutes"
  | "maxIntervalMinutes"
  | "minIdleMinutes"
  | "maxPerDay"
  | "maxUnanswered"
  | "maxMessageChars"
>;

export function heartbeatDraft(settings: HeartbeatSettings): HeartbeatDraft {
  return {
    version: settings.version,
    enabled: settings.enabled,
    timezone: settings.timezone,
    activeStart: settings.activeStart,
    activeEnd: settings.activeEnd,
    minIntervalMinutes: settings.minIntervalMinutes,
    maxIntervalMinutes: settings.maxIntervalMinutes,
    minIdleMinutes: settings.minIdleMinutes,
    maxPerDay: settings.maxPerDay,
    maxUnanswered: settings.maxUnanswered,
    maxMessageChars: settings.maxMessageChars,
  };
}

export function heartbeatDraftChanged(draft: HeartbeatDraft, settings: HeartbeatSettings) {
  return (
    JSON.stringify({ ...draft, version: settings.version }) !==
    JSON.stringify(heartbeatDraft(settings))
  );
}
