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
