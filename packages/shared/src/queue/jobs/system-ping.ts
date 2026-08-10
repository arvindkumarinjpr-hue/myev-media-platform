import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import type { ProcessorManifest } from "../processor-manifest";

/**
 * The one trivial job type Module 1F itself owns — not a business job.
 * It exists purely to prove the full pipeline end-to-end (API enqueue,
 * Redis dispatch, Worker execution, Postgres lifecycle, heartbeat,
 * structured logging) without depending on any future module's business
 * logic. No AI/Blog/Video/Publishing module may depend on this job type.
 */
export class SystemPingPayload {
  @IsOptional()
  @IsString()
  echo?: string;

  // Optional artificial delay, purely so tests have a real window to
  // request cancellation on a still-running job — system.ping otherwise
  // completes instantly, which would make the cooperative-cancellation
  // pathway impossible to exercise end-to-end.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30_000)
  delayMs?: number;

  // Optional deterministic-failure hook, same rationale as delayMs: when
  // set, the processor throws a plain (non-cancellation) error on every
  // attempt whose context.attempt is below this value, then succeeds
  // normally from that attempt onward. Exists purely so Module 1F
  // Milestone 5's retry/backoff/dead-letter tests can exercise a real
  // transient-failure-then-recovery (or exhaustion) cycle deterministically.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  failUntilAttempt?: number;

  // DEFECT-1F-006 test fixture only. Unlike delayMs (an async setTimeout
  // — the event loop stays free, so BOTH the in-process Promise.race
  // timeout AND BullMQ's own lock-renewal timer still fire normally),
  // this performs a REAL synchronous busy-wait, genuinely blocking the
  // event loop for the given duration — nothing on this process's timer
  // queue can run, including this exact job's own ProcessorTimeoutError
  // timer. This is the only way to test "a still-alive process whose
  // event loop is genuinely stalled past manifest.timeout" as opposed to
  // a merely slow async handler, which the existing engine-side timeout
  // already handles on its own without any reconciliation involved.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30_000)
  blockEventLoopMs?: number;
}

export class SystemPingResult {
  @IsString()
  echo!: string;

  @IsString()
  respondedAt!: string;
}

export const SYSTEM_PING_V1_MANIFEST: ProcessorManifest<SystemPingPayload, SystemPingResult> = {
  jobType: "system.ping.v1",
  schemaVersion: 1,
  version: 1,
  queue: "SYSTEM",
  payloadDto: SystemPingPayload,
  resultDto: SystemPingResult,
  idempotent: true,
  cancelable: true,
  supportsRetry: true,
  defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
  timeout: 5_000,
  maximumRuntime: 30_000,
  owningModule: "system-services-foundation",
  description: "Trivial internal job proving the pipeline end-to-end.",
};
