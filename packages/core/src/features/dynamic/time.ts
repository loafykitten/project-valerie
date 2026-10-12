import type { CheckinWindow, ReportedTime, WakingDay } from "./daily-types";
import { DynamicValidationError } from "./types";

export function dailyTimezone(timezone: string): string {
  if (typeof timezone !== "string" || timezone.length > 100)
    throw new TypeError("Provide an IANA timezone.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new TypeError("Provide a valid IANA timezone.");
  }
  return timezone;
}
export function dailyInstant(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new TypeError("Provide a timestamp with a UTC offset.");
  const local = value.replace(/(?:Z|[+-]\d\d:\d\d)$/, "");
  const normalized = local.length === 16 ? `${local}:00` : local.split(".")[0];
  if (new Date(`${local}Z`).toISOString().slice(0, 19) !== normalized)
    throw new TypeError("Provide a real calendar date and time.");
  return new Date(value).toISOString();
}
export function validateReportedTime(input: ReportedTime, latestAllowedAt?: string): ReportedTime {
  if (
    !input ||
    typeof input !== "object" ||
    !["exact", "relative", "message_time", "unknown"].includes(input.basis)
  )
    throw new TypeError("Provide the reporting time and its basis.");
  const timezone = dailyTimezone(input.timezone);
  if ((input.at === null) !== (input.basis === "unknown"))
    throw new TypeError("Unknown timing uses at:null and basis:unknown.");
  const at = input.at === null ? null : dailyInstant(input.at);
  if (at && latestAllowedAt && at > dailyInstant(latestAllowedAt))
    throw new DynamicValidationError(
      "occurred",
      "future_fact",
      "Future intentions are plans, not completed events. Use unknown timing when uncertain.",
    );
  if (
    input.originalLocalIntent !== undefined &&
    (typeof input.originalLocalIntent !== "string" ||
      Buffer.byteLength(input.originalLocalIntent) > 240)
  )
    throw new TypeError("Keep the original time phrase short.");
  return {
    at,
    timezone,
    basis: input.basis,
    ...(input.originalLocalIntent === undefined
      ? {}
      : { originalLocalIntent: input.originalLocalIntent }),
  };
}
function formatter(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: dailyTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
function formatted(at: Date, fmt: Intl.DateTimeFormat): string {
  const parts = fmt.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
export function resolveDailyLocalTime(
  localDateTime: string,
  timezone: string,
  occurrence: "first" | "second" = "first",
) {
  if (
    typeof localDateTime !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(localDateTime) ||
    !Number.isFinite(Date.parse(`${localDateTime}:00Z`)) ||
    new Date(`${localDateTime}:00Z`).toISOString().slice(0, 16) !== localDateTime
  )
    throw new TypeError("Use a real local date and time, YYYY-MM-DDTHH:mm.");
  if (!["first", "second"].includes(occurrence))
    throw new TypeError("Choose the first or second occurrence.");
  const fmt = formatter(timezone),
    nominal = Date.parse(`${localDateTime}:00Z`),
    matches: number[] = [];
  let next: { at: number; local: string } | undefined;
  // A bounded minute scan handles historical offset changes, including half-hour
  // DST, without assuming a 24-hour local day or inventing an offset.
  for (let at = nominal - 18 * 3600000; at <= nominal + 18 * 3600000; at += 60000) {
    const local = formatted(new Date(at), fmt);
    if (local === localDateTime) matches.push(at);
    if (
      local.slice(0, 10) === localDateTime.slice(0, 10) &&
      local > localDateTime &&
      (!next || local < next.local)
    )
      next = { at, local };
  }
  const selected = matches.length
    ? matches[occurrence === "second" && matches.length > 1 ? 1 : 0]
    : next?.at;
  if (selected === undefined)
    throw new TypeError("This local date has no resolvable time in that timezone.");
  const resolvedLocal = formatted(new Date(selected), fmt);
  return {
    at: new Date(selected).toISOString(),
    localDateTime: resolvedLocal,
    timezone,
    offsetMinutes: (Date.parse(`${resolvedLocal}:00Z`) - selected) / 60000,
    adjustment:
      matches.length > 1
        ? ("repeated" as const)
        : matches.length
          ? ("none" as const)
          : ("gap_forward" as const),
    occurrence: matches.length > 1 ? occurrence : ("first" as const),
  };
}
export function resolveDailyRelativeTime(
  referenceAt: string,
  minutes: number,
  timezone: string,
): ReportedTime {
  if (!Number.isFinite(minutes) || Math.abs(minutes) > 525600)
    throw new TypeError("Provide a bounded elapsed offset in minutes.");
  return {
    at: new Date(Date.parse(dailyInstant(referenceAt)) + minutes * 60000).toISOString(),
    timezone: dailyTimezone(timezone),
    basis: "relative",
  };
}
export function calculateCheckinWindow(
  day: WakingDay,
  slot: "morning" | "evening",
  input: { now?: Date; inputWatermark?: number | null } = {},
): CheckinWindow | null {
  if (!day.current || day.mergedIntoDayId || day.state !== "awake_reported") return null;
  let earliest: number, preferred: number, expires: number, sourceEventId: string;
  if (slot === "morning") {
    if (!day.morningEligible || !day.wakeReceivedAt || !day.wakeEventId) return null;
    const received = Date.parse(day.wakeReceivedAt);
    earliest = preferred = received + 30 * 60000;
    expires = received + 4 * 3600000;
    sourceEventId = day.wakeEventId;
  } else {
    if (!day.expectedSleepAt || !day.sleepPlanEventId) return null;
    expires = Date.parse(day.expectedSleepAt);
    earliest = expires - 4 * 3600000;
    preferred = expires - 2 * 3600000;
    sourceEventId = day.sleepPlanEventId;
  }
  if ((input.now ?? new Date()).getTime() >= expires) return null;
  return {
    dayId: day.id,
    dayVersion: day.version,
    slot,
    sourceEventId,
    earliestAt: new Date(earliest).toISOString(),
    preferredAt: new Date(preferred).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    inputWatermark: input.inputWatermark === undefined ? day.inputWatermark : input.inputWatermark,
  };
}
