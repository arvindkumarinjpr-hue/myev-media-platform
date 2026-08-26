import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AiJobsModule } from "../ai-jobs/ai-jobs.module";
import { KnowledgePacksModule } from "../knowledge-packs/knowledge-packs.module";
import { HttpResearchSourceProvider } from "./http-research-source-provider.service";
import { RESEARCH_SOURCE_PROVIDER } from "./research-source-provider.interface";
import { ResearchController } from "./research.controller";
import { ResearchService } from "./research.service";

/**
 * Module 4 Phase 4.1 — the first real business-agent module. Reuses
 * AiJobsModule's own AiJobSubmissionService (Module 3's generic durable
 * primitive, unmodified) and KnowledgePacksModule (Module 2, exact-
 * version resolution, unmodified) — this module adds only the Research-
 * specific submission wrapper (source reachability + agent identifier
 * fixed to "research-agent") and its own thin read/list surface.
 *
 * RESEARCH_SOURCE_PROVIDER defaults to the real HTTP implementation —
 * never registered as the Fake one in production. E2E tests override it
 * via NestJS's own overrideProvider (the identical pattern
 * AiProviderRegistryModule/AgentRegistryModule already established),
 * never via a NODE_ENV branch here.
 */
@Module({
  imports: [AuthModule, AiJobsModule, KnowledgePacksModule],
  controllers: [ResearchController],
  providers: [ResearchService, { provide: RESEARCH_SOURCE_PROVIDER, useClass: HttpResearchSourceProvider }],
})
export class ResearchModule {}
