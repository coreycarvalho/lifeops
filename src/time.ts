/**
 * Calendar dates in the operator's timezone.
 *
 * Instants are stored as UTC (docs/DECISIONS.md), but a *date* is a local thing: a note
 * written at 11pm on July 31 in New York is stored as `2026-08-01T03:00:00Z`, and slicing
 * that string gives the model the wrong day — every "tomorrow" and every weekday in the note
 * then resolves one day out.
 *
 * SPEC requires all schedule math to run in the configured local timezone; this is the first
 * place that bites.
 */

/** The host's zone. What a single-user, self-hosted box means by "local" unless told otherwise. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar date an instant fell on, "YYYY-MM-DD", in `timeZone`.
 *
 * `en-CA` formats as ISO, which is why it is the locale here rather than anything to do
 * with Canada.
 */
export function localDate(instant: string | Date, timeZone: string): string {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
