import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AiJobsModule } from "../ai-jobs/ai-jobs.module";
import { KnowledgePacksModule } from "../knowledge-packs/knowledge-packs.module";
import { ContentModule } from "../content/content.module";
import { ContentScoringModule } from "../content-scoring/content-scoring.module";
import { InternalLinksModule } from "../internal-links/internal-links.module";
import { BlogController } from "./blog.controller";
import { BlogService } from "./blog.service";
import { BlogPipelineService } from "./blog-pipeline.service";

/**
 * Module 6 Phase 6.3 — Blog Pipeline orchestration.
 *
 * Composes existing modules only:
 *  - AiJobsModule        → AiJobSubmissionService (durable ai.execute.v1 — no new queue)
 *  - KnowledgePacksModule → exact-version ACTIVE gate (ADR-004)
 *  - ContentModule       → ContentItemsService lifecycle + immutable content_versions + ContentBodyValidator
 *  - ContentScoringModule → Phase 6.1 ContentScoringService (all scoring math + persistence)
 *  - InternalLinksModule  → Module 8 Phase 8.4: BlogPipelineService injects
 *    InternalLinkDiscoveryService directly into the runInternalLinking()
 *    seam. No circular dependency: InternalLinksModule never imports
 *    BlogModule.
 *
 * AuthModule import mirrors ContentModule/ContentScoringModule: the
 * controller's SessionGuard needs JwtService; PermissionGuard/RbacModule
 * are @Global.
 */
@Module({
  imports: [AuthModule, AiJobsModule, KnowledgePacksModule, ContentModule, ContentScoringModule, InternalLinksModule],
  controllers: [BlogController],
  providers: [BlogService, BlogPipelineService],
  exports: [BlogService, BlogPipelineService],
})
export class BlogModule {}
