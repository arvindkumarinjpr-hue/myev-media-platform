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
  // Module 6 Phase 6.2 — raised from the Module 3 Phase 3.3 placeholder
  // (30_000 / 60_000) to accommodate the frozen FRD §21.1 per-job
  // timeouts for the AI jobs that now actually run through this ONE
  // generic manifest:
  //   - "Queue job timeout — Blog draft generation | 5 min | Configurable: Yes"
  //   - "Queue job timeout — SEO/Internal Linking pass  | 3 min | Configurable: Yes"
  //   - "Queue job timeout — Research | 10 min | Configurable: Yes"
  // BullMqWorkerManager races every handler against exactly this
  // `timeout` and kills it on expiry (Promise.race in
  // bullmq-worker.manager.ts) — the AGENT's own timeoutMs is only the
  // inner AIRequest/AbortController budget, so an agent can never
  // legitimately run longer than this value regardless of what it
  // declares. The prior 30s was set when RESEARCH_AGENT_V1 (25s) was the
  // only real agent; the frozen 5-min Blog draft cannot be honored under
  // it, and the task's own constraints forbid a Blog-specific job type
  // or a new processor. This is the frozen §21.1 "Configurable: Yes"
  // ceiling made real; it changes NO existing agent's behaviour
  // (Research stays at 25s, well under this). Trade-off: a crashed
  // worker's RUNNING row is now reconciled as stale after up to 5 min
  // instead of 30s — inherent to supporting genuinely long AI jobs.
  timeout: 300_000,
  maximumRuntime: 600_000,
  owningModule: "ai-agent-framework",
  description: "Generic durable AI agent execution — drives exactly one existing ai_jobs row to a terminal state via the Agent Framework pipeline.",
};
