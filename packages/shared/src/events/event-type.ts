/**
 * Milestone 8 Architecture §26 (Freeze Event Naming Convention) — reuses
 * the identical {domain}.{action}.v{n} pattern already frozen and
 * regex-enforced for jobType (processor-manifest.ts's JOB_TYPE_PATTERN),
 * not a new convention. The one discipline specific to events: an
 * eventType names a FACT that already happened (past tense, e.g.
 * "content.published"), where a jobType names a unit of WORK (e.g.
 * "system.ping") — same regex, different tense discipline.
 */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v(\d+)$/;

export function isValidEventType(value: unknown): value is string {
  return typeof value === "string" && EVENT_TYPE_PATTERN.test(value);
}

/**
 * Derives eventVersion (Milestone 8 Architecture §22 — "what shape is
 * THIS row") from an eventType's own .v{n} suffix, rather than accepting
 * it as a second, independently-settable parameter that could drift out
 * of sync with the eventType string itself.
 */
export function parseEventContractVersion(eventType: string): number {
  const match = EVENT_TYPE_PATTERN.exec(eventType);
  if (!match) {
    throw new Error(`"${eventType}" does not match {entity}.{action}.v{n}`);
  }
  return Number(match[1]);
}
