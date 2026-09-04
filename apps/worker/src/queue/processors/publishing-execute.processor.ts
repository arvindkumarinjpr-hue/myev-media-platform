import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { PermanentProcessorError, type ProcessorContext, type ProcessorHandler, type PublishingExecuteV1Payload, type PublishingExecuteV1Result } from "@myev/shared";
import { PublishingExecutionService } from "../../publishing/publishing-execution.service";

/**
 * Module 9 Phase 9.3 — the thin BullMQ processor for `publishing.execute.v1`.
 * No business lifecycle decision tree here (Part M) — every actual
 * decision (lifecycle guard, readiness re-check, retry classification)
 * lives in PublishingExecutionService and the shared `@myev/shared`
 * functions it calls. This class's only job: invoke the execution
 * service and translate its typed outcome into BullMqWorkerManager's own
 * resolve/retry/permanent-failure contract.
 */
@Injectable()
export class PublishingExecuteProcessor {
  constructor(
    private readonly execution: PublishingExecutionService,
    @InjectPinoLogger(PublishingExecuteProcessor.name) private readonly logger: PinoLogger,
  ) {}

  readonly handle: ProcessorHandler<PublishingExecuteV1Payload, PublishingExecuteV1Result> = async (payload: PublishingExecuteV1Payload, _context: ProcessorContext) => {
    const outcome = await this.execution.execute(payload.workspacePublicId, payload.publicationTargetPublicId);

    if (outcome.kind === "success") {
      return { publicationTargetPublicId: payload.publicationTargetPublicId };
    }

    this.logger.warn({ publicationTargetPublicId: payload.publicationTargetPublicId, errorCode: outcome.errorCode, classification: outcome.kind }, "publishing.execute.v1 attempt did not succeed");

    if (outcome.kind === "permanent") {
      // Immediate dead-letter — skips the attempts budget entirely
      // (BullMqWorkerManager's own deadLetterImmediately path), matching
      // every other PermanentProcessorError use in this codebase.
      throw new PermanentProcessorError(outcome.errorCode, outcome.message);
    }

    // Retryable: a plain Error, deliberately not PermanentProcessorError,
    // so BullMqWorkerManager's own generic transient-failure/backoff path
    // picks it up — the exact same contract AiExecuteProcessor's own
    // transient branch uses.
    throw new Error(outcome.message);
  };
}
