import type { GrowthFocus } from "@valerie/core";

export type FocusDraft = {
  id: string | null;
  baseVersion: number | null;
  title: string;
  reason: string;
  startDate: string;
  reviewDate: string;
  practices: string;
  indicators: string;
};

export function focusDraft(focus: GrowthFocus | null): FocusDraft {
  return {
    id: focus?.id ?? null,
    baseVersion: focus?.version ?? null,
    title: focus?.title ?? "",
    reason: focus?.reason ?? "",
    startDate: focus?.startDate ?? "",
    reviewDate: focus?.reviewDate ?? "",
    practices: focus?.practices.join("\n") ?? "",
    indicators: focus?.indicators.join("\n") ?? "",
  };
}

export function focusFields(draft: FocusDraft) {
  const lines = (text: string) =>
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  return {
    title: draft.title.trim(),
    reason: draft.reason.trim(),
    startDate: draft.startDate,
    reviewDate: draft.reviewDate,
    practices: lines(draft.practices),
    indicators: lines(draft.indicators),
  };
}

export function focusDraftError(draft: FocusDraft): string | null {
  const fields = focusFields(draft);
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  if (!fields.title || !fields.reason) return "Add a title and a reason for this focus.";
  if (bytes(fields.title) > 120) return "Please shorten the title before saving.";
  if (bytes(fields.reason) > 800) return "Please shorten the reason before saving.";
  if (!fields.startDate || !fields.reviewDate) return "Choose a start date and a review date.";
  if (fields.reviewDate <= fields.startDate) return "Choose a review date after the start date.";
  for (const name of ["practices", "indicators"] as const) {
    if (fields[name].length > 5) return `Keep ${name} to five items or fewer.`;
    if (fields[name].some((text) => bytes(text) > 160))
      return `Please shorten the longest item in ${name} before saving.`;
  }
  return null;
}

export function focusChanged(draft: FocusDraft, base: FocusDraft): boolean {
  return JSON.stringify(focusFields(draft)) !== JSON.stringify(focusFields(base));
}

export function focusStatus(focus: GrowthFocus): {
  label: string;
  tone: "neutral" | "accent" | "warning";
} {
  if (focus.state === "archived") return { label: "Archived", tone: "neutral" };
  if (focus.state === "paused") return { label: "Paused", tone: "neutral" };
  if (focus.phase === "scheduled") return { label: "Starts soon", tone: "neutral" };
  if (focus.reviewDue) return { label: "Ready to review", tone: "warning" };
  return { label: "Active", tone: "accent" };
}

/** Calendar dates are formatted without conversion to the browser's timezone. */
export function focusDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
