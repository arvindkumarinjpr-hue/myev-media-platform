import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PermanentProcessorError, type ProcessorContext, type ProcessorHandler, type PublishingDispatchV1Payload, type PublishingDispatchV1Result } from "@myev/shared";
import { PublishingDispatchService } from "../../publishing/publishing-dispatch.service";

/**
 * Module 9 Phase 9.3 — the thin BullMQ processor for
 * `publishing.dispatch.v1`, the job type a due `publishing.dispatch.v1`
 * ScheduledJob occurrence dispatches as (via SchedulerTickManager,
 * unmodified). Its only job: transition the target SCHEDULED -> QUEUED
 * and enqueue its `publishing.execute.v1` execution job — never calls a
 * provider itself (Part S). Non-retryable by manifest design (a failure
 * here almost always means the target is already in an illegal state,
 * which retrying would never fix) — any thrown error is therefore always
 * a PermanentProcessorError.
 *
 * This IS the system-actor execution path (Part T/J): no human
 * permission re-check happens here — authorization was already validated
 * when the schedule/publication was originally created, and this
 * process's own workspace-scoped Prisma queries are the only scope
 * enforcement a system-triggered dispatch needs.
 */
@Injectable()
export class PublishingDispatchProcessor {
  constructor(
    private readonly dispatch: PublishingDispatchService,
    @InjectPinoLogger(PublishingDispatchProcessor.name) private readonly logger: PinoLogger,
  ) {}

  readonly handle: ProcessorHandler<PublishingDispatchV1Payload, PublishingDispatchV1Result> = async (payload: PublishingDispatchV1Payload, _context: ProcessorContext) => {
    try {
      const outcome = await this.dispatch.dispatchScheduledTarget(payload.workspacePublicId, payload.publicationTargetPublicId);
      this.logger.info({ publicationTargetPublicId: payload.publicationTargetPublicId, dispatched: outcome.dispatched }, "publishing.dispatch.v1 handled");
      return { publicationTargetPublicId: payload.publicationTargetPublicId };
    } catch (err) {
      // Never persist a raw caught exception's own message — it may be a
      // raw Prisma/Postgres error carrying internal detail. A fixed,
      // curated string only; the real error is still logged (structured,
      // operational) for diagnosis.
      this.logger.error({ err, publicationTargetPublicId: payload.publicationTargetPublicId }, "publishing.dispatch.v1 failed");
      throw new PermanentProcessorError("PUBLISHING_DISPATCH_FAILED", "Failed to dispatch publication target.");
    }
  };
}
