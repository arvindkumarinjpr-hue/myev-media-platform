import { CronExpressionParser } from "cron-parser";

/**
 * Module 1F Milestone 7 Engineering Plan (Revision 3) §8: the single
 * cron/timezone evaluation path shared by Create validation, Update
 * validation, Preview, and SchedulerTickManager's own runtime dispatch —
 * never a second, parallel implementation. `cron-parser` is a direct
 * dependency of this package (not relied upon transitively via bullmq),
 * per the plan's explicit instruction.
 */

export class InvalidCronExpressionError extends Error {
  constructor(expression: string, cause: unknown) {
    super(`"${expression}" is not a valid cron expression: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "InvalidCronExpressionError";
  }
}

export class InvalidScheduleTimezoneError extends Error {
  constructor(timezone: string) {
    super(`"${timezone}" is not a recognized IANA timezone`);
    this.name = "InvalidScheduleTimezoneError";
  }
}

// Intl.supportedValuesOf('timeZone') does not include "UTC" itself (an
// alias, not a zone name in the IANA database) — accepted explicitly per
// the plan's own instruction ("recognized IANA zones plus UTC").
let cachedIanaZones: ReadonlySet<string> | undefined;
function ianaZones(): ReadonlySet<string> {
  if (!cachedIanaZones) {
    cachedIanaZones = new Set(Intl.supportedValuesOf("timeZone"));
  }
  return cachedIanaZones;
}

/** Throws InvalidScheduleTimezoneError on anything not UTC or a recognized IANA zone name. */
export function validateTimezone(timezone: string): void {
  if (timezone === "UTC") return;
  if (!ianaZones().has(timezone)) {
    throw new InvalidScheduleTimezoneError(timezone);
  }
}

/**
 * Throws InvalidCronExpressionError if the expression cannot be parsed or
 * cannot produce at least one future occurrence. Does not validate
 * `timezone` — call validateTimezone separately (kept as two distinct
 * checks so each fails with its own specific, correctly-attributed error
 * code at the API boundary).
 */
export function validateCronExpression(cronExpression: string): void {
  // cron-parser does not itself reject an empty/blank string as invalid
  // (found via this module's own test suite) — checked explicitly first.
  if (!cronExpression?.trim()) {
    throw new InvalidCronExpressionError(cronExpression, new Error("cron expression is required"));
  }
  try {
    const parsed = CronExpressionParser.parse(cronExpression, { currentDate: new Date() });
    parsed.next();
  } catch (error) {
    throw new InvalidCronExpressionError(cronExpression, error);
  }
}

/**
 * The single self-healing computation described in the plan's §9 (Misfire
 * Behavior, locked): always the next valid occurrence of
 * (cronExpression, timezone) STRICTLY AFTER `referenceInstant` — never
 * derived by incrementing any previously-stored value. Callers always
 * pass the current instant (sourced from Postgres `now()` at the scan's
 * own claim time, or `new Date()` at API write time) as
 * `referenceInstant`, never a stale `nextRunAt`.
 */
export function computeNextOccurrence(cronExpression: string, timezone: string, referenceInstant: Date): Date {
  // cron-parser does NOT default to UTC when `tz` is omitted — it defaults
  // to the running process's own local timezone. `timezone` must always be
  // passed explicitly, "UTC" included, never omitted — omitting it here
  // was a real bug this module's own test suite caught (see git history):
  // it silently used the container/process's local offset instead of UTC.
  const parsed = CronExpressionParser.parse(cronExpression, { tz: timezone, currentDate: referenceInstant });
  return parsed.next().toDate();
}

/**
 * Preview support (Revision 3 §10/§7) — the next `count` occurrences,
 * strictly after `referenceInstant`, using the identical evaluation path
 * as computeNextOccurrence (this function is implemented in terms of it,
 * not a separate code path).
 */
export function computeNextOccurrences(cronExpression: string, timezone: string, referenceInstant: Date, count: number): Date[] {
  const occurrences: Date[] = [];
  let cursor = referenceInstant;
  for (let i = 0; i < count; i++) {
    const next = computeNextOccurrence(cronExpression, timezone, cursor);
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}
