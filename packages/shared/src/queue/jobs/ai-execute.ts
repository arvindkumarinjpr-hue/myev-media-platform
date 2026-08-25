import { IsUUID } from "class-validator";
import type { ProcessorManifest } from "../processor-manifest";

/**
 * Module 3 Phase 3.3 — the ONE generic, agent-agnostic durable AI
 * execution job type. Dispatches through Module 1F's existing Queue
 * Engine exactly like any other job type (ProcessorManifest/
 * QueueRegistry/BullMqWorkerManager, unmodified) — no new queue system,
 * no per-provider or per-agent job type. The payload is deliberately
 * minimal: a reference to the real business record (ai_jobs), never the
 * AI request/response/credentials themselves — those live only in
 * ai_jobs/ai_job_steps, resolved by the worker processor from this one
 * id at execution time.
 */
export class AiExecuteV1Payload {
  /** The AiJob's own public_id — never its internal id, matching every other cross-boundary reference in this system. */
  @IsUUID()
  aiJobPublicId!: string;
}

export class AiExecuteV1Result {
  @IsUUID()
  aiJobPublicId!: string;
}

export const AI_EXECUTE_V1_MANIFEST: ProcessorManifest<AiExecuteV1Payload, AiExecuteV1Result> = {
  jobType: "ai.execute.v1",
  schemaVersion: 1,
  version: 1,
  queue: "AI",
  payloadDto: AiExecuteV1Payload,
  resultDto: AiExecuteV1Result,
  idempotent: true,
  cancelable: false,
  supportsRetry: true,
  // Mirrors the frozen Retry Strategy defaults (QUEUE_AND_BACKGROUND_JOB_ENGINE_V1.0.md
  // §7): max 3 attempts, capped exponential backoff — invents no new numbers.
  defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
  // Generous relative to system.ping.v1's 5s — a real provider call
  // (even FakeProvider's own artificial scenarios) needs real HTTP-call
  // headroom the trivial internal ping never did.
  timeout: 30_000,
  maximumRuntime: 60_000,
  owningModule: "ai-agent-framework",
  description: "Generic durable AI agent execution — drives exactly one existing ai_jobs row to a terminal state via the Agent Framework pipeline.",
};
