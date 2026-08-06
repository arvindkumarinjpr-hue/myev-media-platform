/**
 * The signal a processor throws after observing `context.isCancelled()`
 * return true and choosing to stop. Distinct from an ordinary thrown
 * error: the Worker engine recognizes this specific type and maps it to
 * the frozen terminal state `status=FAILED, errorCode='JOB_CANCELLED_BY_USER',
 * cancelledAt` (see BackgroundJob's model comment, schema.prisma) instead
 * of a generic failure. A processor that never checks isCancelled() simply
 * never throws this — cancellation remains cooperative, never forced.
 */
export class JobCancelledError extends Error {
  constructor(message = "Job execution was cancelled.") {
    super(message);
    this.name = "JobCancelledError";
  }
}
