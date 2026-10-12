/** A plain JSON-style object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True for Unicode control characters other than tab, carriage return and line feed. */
export function hasUnsafeControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value.replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", ""));
}
