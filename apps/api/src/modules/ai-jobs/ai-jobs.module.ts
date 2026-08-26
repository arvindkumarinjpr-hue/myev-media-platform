import { Module } from "@nestjs/common";
import { AgentRegistryModule } from "../ai-agents/agent-registry.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { BackgroundJobsModule } from "../background-jobs/background-jobs.module";
import { KnowledgePacksModule } from "../knowledge-packs/knowledge-packs.module";
import { AiJobSubmissionService } from "./ai-job-submission.service";
import { AiJobsController } from "./ai-jobs.controller";

/**
 * Module 3 Phase 3.3 — the durable AI Job submission/read API. Reuses
 * AgentRegistryModule (Phase 3.2's own AGENT_REGISTRY, unmodified),
 * KnowledgePacksModule (exact-version resolution, unmodified), and
 * BackgroundJobsModule (Module 1F's own Queue Engine enqueue path,
 * unmodified) — this module adds no new infrastructure, only the
 * durable submission flow connecting them.
 */
@Module({
  imports: [AuthModule, AgentRegistryModule, KnowledgePacksModule, BackgroundJobsModule, AuditModule],
  controllers: [AiJobsController],
  providers: [AiJobSubmissionService],
  // Module 4 Phase 4.1: ResearchModule reuses this generic durable
  // submission/read service directly rather than building a second one
  // (AiJobSubmissionService's own doc comment — "every future
  // content-generation endpoint is meant to become a thin wrapper
  // around this one primitive").
  exports: [AiJobSubmissionService],
})
export class AiJobsModule {}
