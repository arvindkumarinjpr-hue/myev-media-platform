import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { JobCancelledError, type ProcessorContext, type ProcessorHandler, type SystemPingPayload, type SystemPingResult } from "@myev/shared";

@Injectable()
export class SystemPingProcessor {
  constructor(@InjectPinoLogger(SystemPingProcessor.name) private readonly logger: PinoLogger) {}

  readonly handle: ProcessorHandler<SystemPingPayload, SystemPingResult> = async (
    payload: SystemPingPayload,
    context: ProcessorContext,
  ): Promise<SystemPingResult> => {
    // Reference implementation for cooperative cancellation: a real
    // (typically longer-running) processor checks isCancelled() at its
    // own natural checkpoints and throws JobCancelledError to stop
    // cleanly. system.ping does no real work, so payload.delayMs exists
    // purely to give tests a real window in which to request cancellation
    // on a still-running job — without it, this job completes before a
    // cancel request could ever land.
    if (await context.isCancelled()) {
      throw new JobCancelledError();
    }

    if (payload.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
    }

    if (await context.isCancelled()) {
      throw new JobCancelledError();
    }

    // Deterministic-failure hook for Milestone 5's retry/backoff/dead-
    // letter tests — see SystemPingPayload.failUntilAttempt's own comment.
    if (payload.failUntilAttempt && context.attempt < payload.failUntilAttempt) {
      throw new Error("Simulated transient failure for testing.");
    }

    this.logger.info({ jobId: context.jobId, correlationId: context.correlationId, attempt: context.attempt }, "system.ping.v1 processed");
    return { echo: payload.echo ?? "pong", respondedAt: new Date().toISOString() };
  };
}
