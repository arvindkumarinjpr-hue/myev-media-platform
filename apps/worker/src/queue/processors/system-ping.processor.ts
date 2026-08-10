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

    // DEFECT-1F-006 test fixture only, inert unless explicitly set — same
    // discipline as SIMULATE_SHUTDOWN_FAILURE/SIMULATE_TRACKER_FAILURE
    // (apps/worker/src/testing/simulated-shutdown-failure.module.ts).
    // Kills this process AFTER the QUEUED->RUNNING pickup transition has
    // already committed but BEFORE any terminal write — the exact window
    // the stale-RUNNING reconciliation test matrix needs a REAL crashed
    // process for, not a simulated one. A hard process.exit(1), not a
    // thrown error: this must terminate the process itself, not just
    // fail this one job execution.
    if (process.env.SIMULATE_PROCESS_CRASH_AFTER_PICKUP === "true") {
      process.exit(1);
    }

    if (payload.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
    }

    // DEFECT-1F-006 test fixture only — see SystemPingPayload.blockEventLoopMs's own comment for why a real synchronous busy-wait, not setTimeout, is required here.
    if (payload.blockEventLoopMs) {
      const until = Date.now() + payload.blockEventLoopMs;
      while (Date.now() < until) {
        // Intentionally synchronous — this is the point.
      }
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
