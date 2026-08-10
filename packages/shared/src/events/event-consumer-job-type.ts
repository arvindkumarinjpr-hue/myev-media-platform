// The same {domain}.{action} segment pattern already frozen for
// eventType/jobType (EVENT_TYPE_PATTERN, processor-manifest.ts's
// JOB_TYPE_PATTERN) — a consumerName that violates this can never
// produce a jobType validateProcessorManifest would accept, so this
// helper fails fast at derivation rather than later, less legibly, at
// manifest-registration time.
const CONSUMER_NAME_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Milestone 8.3 FINAL ARCHITECTURE FREEZE §4 — the single source of
 * truth for the `event.{consumerName}.v{eventContractVersion}` jobType
 * shape. Every caller that needs this string (OutboxRelayManager,
 * derive-processor-manifest-from-event-consumer-manifest.ts, tests)
 * must call this function — no caller may reconstruct the template
 * independently.
 */
export function deriveEventConsumerJobType(consumerName: string, eventContractVersion: number): string {
  if (!CONSUMER_NAME_SEGMENT_PATTERN.test(consumerName)) {
    throw new Error(`consumerName "${consumerName}" must match ^[a-z][a-z0-9-]*$ to derive a valid event-consumer jobType`);
  }
  if (!Number.isInteger(eventContractVersion) || eventContractVersion < 1) {
    throw new Error(`eventContractVersion must be a positive integer, got ${eventContractVersion}`);
  }
  return `event.${consumerName}.v${eventContractVersion}`;
}
