import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { KnowledgePacksModule } from "../knowledge-packs/knowledge-packs.module";
import { ContentModule } from "../content/content.module";
import { AiJobsModule } from "../ai-jobs/ai-jobs.module";
import { VideoController } from "./video.controller";
import { VideoService } from "./video.service";
import { VideoPipelineService } from "./video-pipeline.service";

/**
 * Module 7 Phase 7.1/7.2 — Video Pipeline orchestration.
 *
 * Composes existing modules only (mirrors BlogModule):
 *  - KnowledgePacksModule → exact-version ACTIVE gate (ADR-004).
 *  - ContentModule        → ContentItemsService lifecycle + immutable
 *                           content_versions + ContentBodyValidator.
 *  - AiJobsModule         → AiJobSubmissionService (durable ai.execute.v1
 *                           — no new queue). Phase 7.2 adds this import;
 *                           the 6 text/advisory generation stages all
 *                           submit through it, exactly like Blog.
 *
 * AuthModule import mirrors ContentModule/BlogModule: the controller's
 * SessionGuard needs JwtService; PermissionGuard/RbacModule are @Global.
 *
 * NOT imported yet (arrive with the phase that needs them):
 *  - ContentScoringModule → Phase 7.3 (VIDEO_DIMENSION_V1).
 *  - MediaAssetsModule    → Phase 7.4 (asset collection).
 */
@Module({
  imports: [AuthModule, KnowledgePacksModule, ContentModule, AiJobsModule],
  controllers: [VideoController],
  providers: [VideoService, VideoPipelineService],
  exports: [VideoService, VideoPipelineService],
})
export class VideoModule {}
