import type { HeartbeatState } from "./types";

export function heartbeatTime(value: string | null, timezone: string): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return "Time unavailable";
  }
}

const reasonDescriptions: Record<string, string> = {
  disabled: "Heartbeats are switched off.",
  paused: "Heartbeats are paused.",
  quiet_hours: "Outside the hours you chose for heartbeats.",
  waiting: "Waiting for the next opportunity to consider a message.",
  not_due: "Waiting for the next opportunity to consider a message.",
  idle: "Giving your recent conversation some space.",
  recent_activity: "Giving your recent conversation some space.",
  conversation_active: "A conversation reply is still being handled.",
  busy: "A conversation reply is still being handled.",
  daily_limit: "Today's heartbeat allowance has been reached.",
  unanswered_limit: "The limit for heartbeats without a reply has been reached.",
  no_conversation: "Waiting for an owner conversation in Telegram.",
  no_owner_chat: "Waiting for a configured private Telegram chat.",
  no_owner_input: "Waiting for an owner conversation in Telegram.",
  conversation_pending: "A conversation reply is still being handled.",
  recent_conversation: "Giving your recent conversation some space.",
  minimum_interval: "Giving the last heartbeat some space before another opportunity.",
  active_run: "Valerie is considering the current opportunity.",
  settings_changed: "Heartbeat settings changed before this message could be sent.",
  owner_input_changed: "You sent a message before this heartbeat could be sent.",
  owner_replied: "You sent a message before this heartbeat could be sent.",
  new_input: "You sent a message before this heartbeat could be sent.",
  unknown_delivery:
    "A Telegram delivery could not be confirmed. It will not be sent again automatically.",
  telegram_unavailable: "Telegram is unavailable. Heartbeats cannot be delivered.",
  lease_lost: "This attempt stopped when another worker took over.",
  expired: "This opportunity passed before a message could be sent.",
  stale: "This opportunity passed before a message could be sent.",
  missed_opportunity:
    "This opportunity passed while the service was unavailable. It was not sent late.",
  opportunity_expired: "This opportunity passed before a message could be sent.",
  interrupted_delivery:
    "Delivery was interrupted before the result was confirmed. This message will not be resent automatically.",
  interrupted_generation: "This attempt stopped when the service restarted.",
};

export function heartbeatReason(reason: string | null): string {
  return reason ? (reasonDescriptions[reason] ?? "This opportunity was skipped.") : "";
}

export function heartbeatStatusPresentation(state: HeartbeatState): {
  title: string;
  description: string;
  tone: "neutral" | "accent" | "success" | "warning";
} {
  const { settings, status, runtime } = state;
  if (!settings.enabled)
    return { title: "Off", description: "Enable heartbeats when you're ready.", tone: "neutral" };
  if (status.paused)
    return {
      title: "Paused",
      description: settings.pausedUntil
        ? `Paused until ${heartbeatTime(settings.pausedUntil, settings.timezone)}.`
        : "Paused until you resume them.",
      tone: "neutral",
    };
  if (!["waiting", "generating"].includes(runtime.state))
    return {
      title: "Unavailable",
      description: "Heartbeat delivery is not running. Check the Telegram and service status.",
      tone: "warning",
    };
  if (status.blockingReason === "unknown_delivery")
    return {
      title: "Delivery uncertain",
      description: heartbeatReason(status.blockingReason),
      tone: "warning",
    };
  if (status.blockingReason === "quiet_hours")
    return {
      title: "Quiet hours",
      description: "Outside your chosen hours. The next opportunity will respect them.",
      tone: "neutral",
    };
  if (status.activeRunId || runtime.state === "generating")
    return {
      title: "Considering a message",
      description: "Valerie may send something short or choose to stay quiet.",
      tone: "accent",
    };
  if (status.blockingReason && !["waiting", "not_due"].includes(status.blockingReason))
    return {
      title: "Waiting",
      description: heartbeatReason(status.blockingReason),
      tone: "neutral",
    };
  return {
    title: "On",
    description: "Valerie can consider a message when the next opportunity comes.",
    tone: "success",
  };
}

export function heartbeatRunPresentation(status: string): {
  label: string;
  description: string;
  tone: "neutral" | "accent" | "success" | "warning";
} {
  switch (status) {
    case "sent":
    case "delivered":
      return { label: "Sent", description: "Telegram confirmed delivery.", tone: "success" };
    case "silent":
      return {
        label: "Stayed quiet",
        description: "Valerie chose not to send a message this time.",
        tone: "neutral",
      };
    case "suppressed":
      return {
        label: "Skipped",
        description: "A timing or conversation limit stopped this attempt.",
        tone: "neutral",
      };
    case "failed":
      return { label: "Failed", description: "This attempt did not complete.", tone: "warning" };
    case "unknown":
      return {
        label: "Delivery uncertain",
        description:
          "Telegram delivery was not confirmed. This message will not be resent automatically.",
        tone: "warning",
      };
    case "sending":
      return {
        label: "Sending",
        description: "Waiting for Telegram's delivery result.",
        tone: "accent",
      };
    case "queued":
    case "prepared":
      return {
        label: "Waiting to send",
        description: "The message will be checked again before sending.",
        tone: "neutral",
      };
    default:
      return {
        label: "In progress",
        description: "Valerie is considering this opportunity.",
        tone: "accent",
      };
  }
}
