import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { KnowledgePacksModule } from "../knowledge-packs/knowledge-packs.module";
import { AgentExecutorService } from "./agent-executor.service";
import { AgentRegistryModule } from "./agent-registry.module";
import { AiProviderRegistryModule } from "./ai-provider-registry.module";

/**
 * Module 3 Phase 3.2 — AI Agent Framework core.
 *
 * No HTTP controller here: the frozen API contract (API Spec §20/22)
 * has `POST /ai-jobs` return `202 Accepted` with `status: "QUEUED"`, to
 * be polled — an async contract that presumes durable dispatch through
 * Module 1F's Queue Engine. Building that durably requires either
 * extending BullMqWorkerManager to support a persistence target other
 * than `background_jobs` per queue category, or a second, parallel
 * dispatch manager — both real architecture decisions (DB Design §5.12
 * explicitly reserves `background_jobs`/`job_history` for non-AI,
 * non-publishing maintenance only; ADR-005 resolved `ai_jobs` as its own
 * authoritative store, not a `background_jobs` row) that deserve their
 * own dedicated design pass rather than an improvised choice buried in
 * this phase. AgentExecutorService is exactly the "synchronous internal
 * execution primitive, kept internal and clearly separated from the
 * durable public workflow" this phase's own spec anticipates for exactly
 * this situation — real, callable, and fully ai_jobs/ai_job_steps-backed
 * today; the future durable-async caller reuses it unchanged once that
 * dispatch-integration decision is made.
 */
@Module({
  imports: [AiProviderRegistryModule, AgentRegistryModule, KnowledgePacksModule, AuditModule],
  providers: [AgentExecutorService],
  exports: [AgentExecutorService],
})
export class AiAgentsModule {}
