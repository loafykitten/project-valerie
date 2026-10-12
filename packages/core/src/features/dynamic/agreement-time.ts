import type { RuleDefinition, RulePhase, RuleWindow } from "./agreements-types";
import { dailyInstant, dailyTimezone, resolveDailyLocalTime } from "./time";

const boundaries = new Map<string, string>();
function boundary(date: string, clock: string, timezone: string): string {
  const key = `${timezone}:${date}T${clock}`,
    cached = boundaries.get(key);
  if (cached) return cached;
  const at = resolveDailyLocalTime(`${date}T${clock}`, timezone).at;
  if (boundaries.size >= 1024) boundaries.clear();
  boundaries.set(key, at);
  return at;
}
function calendarShift(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function agreementLocalDate(
  at: string,
  timezone: string,
): { date: string; weekday: number; clock: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: dailyTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(dailyInstant(at)));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday")),
    clock: `${part("hour")}:${part("minute")}`,
  };
}
export function agreementWeekdays(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 7 ||
    value.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
    new Set(value).size !== value.length
  )
    throw new TypeError("Choose distinct weekdays from Sunday (0) through Saturday (6).");
  return [...value].sort((a, b) => a - b);
}
export function validateRuleWindow(input: RuleWindow | null): RuleWindow | null {
  if (input === null) return null;
  if (
    !input ||
    typeof input !== "object" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.end)
  )
    throw new TypeError("Use local HH:mm times for a rule window, or no window.");
  return { start: input.start, end: input.end, weekdays: agreementWeekdays(input.weekdays) };
}
export function rulePhaseAt(rule: RuleDefinition, at: string): RulePhase {
  const instant = dailyInstant(at);
  if (rule.state !== "active") return rule.state;
  if (instant < rule.effectiveAt) return "scheduled";
  if (rule.expiresAt && instant >= rule.expiresAt) return "expired";
  if (!rule.window) return "active";
  const { date, weekday } = agreementLocalDate(instant, rule.timezone),
    { start, end, weekdays } = rule.window;
  if (start === end) return weekdays.includes(weekday) ? "active" : "outside_window";
  const anchors =
    start < end
      ? [{ date, weekday }]
      : [
          { date, weekday },
          { date: calendarShift(date, -1), weekday: (weekday + 6) % 7 },
        ];
  // Resolve first-occurrence UTC boundaries so a repeated local hour cannot
  // suspend or restart a window that has already begun.
  for (const anchor of anchors) {
    if (!weekdays.includes(anchor.weekday)) continue;
    const from = boundary(anchor.date, start, rule.timezone),
      until = boundary(
        start < end ? anchor.date : calendarShift(anchor.date, 1),
        end,
        rule.timezone,
      );
    if (instant >= from && instant < until) return "active";
  }
  return "outside_window";
}
export function metricPeriodKey(date: string | null, period: "day" | "week" | "month"): string {
  if (!date) return "unknown";
  if (period === "day") return date;
  if (period === "month") return date.slice(0, 7);
  const value = new Date(`${date}T12:00:00.000Z`),
    sinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - sinceMonday);
  return value.toISOString().slice(0, 10);
}
