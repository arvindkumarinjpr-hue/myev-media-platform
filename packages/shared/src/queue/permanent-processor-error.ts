/**
 * Milestone 8.3 FINAL ARCHITECTURE FREEZE §5/§7 — a generic queue-engine
 * capability, deliberately containing zero event-consumer-specific
 * knowledge (named PermanentProcessorError, not PermanentConsumerError,
 * for exactly this reason). The signal a processor throws when it has
 * determined a failure is permanent — no attempt count will ever fix
 * it — analogous to JobCancelledError but routed to immediate
 * dead-lettering instead of the normal retry-or-exhaust decision.
 *
 * errorMessageSafe must never contain credentials, raw stack traces, or
 * infrastructure details, by the same discipline BackgroundJob's own
 * errorMessageSafe column already documents ("Always curated text —
 * never a raw stack trace").
 *
 * Not yet wired into BullMqWorkerManager — that integration is Phase 2.
 */
export class PermanentProcessorError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly errorMessageSafe: string,
  ) {
    super(errorMessageSafe);
    this.name = "PermanentProcessorError";
  }
}
