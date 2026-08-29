import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { KnowledgePacksModule } from "../knowledge-packs/knowledge-packs.module";
import { ContentModule } from "../content/content.module";
import { VideoController } from "./video.controller";
import { VideoService } from "./video.service";
import { VideoPipelineService } from "./video-pipeline.service";

/**
 * Module 7 Phase 7.1 — Video Pipeline orchestration foundation.
 *
 * Composes existing modules only (mirrors BlogModule):
 *  - KnowledgePacksModule → exact-version ACTIVE gate (ADR-004).
 *  - ContentModule        → ContentItemsService lifecycle + immutable
 *                           content_versions + ContentBodyValidator.
 *
 * AuthModule import mirrors ContentModule/BlogModule: the controller's
 * SessionGuard needs JwtService; PermissionGuard/RbacModule are @Global.
 *
 * NOT imported yet (arrive with the phase that needs them):
 *  - AiJobsModule / ai-agents  → Phase 7.2 (brief/script/scene agents).
 *  - ContentScoringModule      → Phase 7.3 (VIDEO_DIMENSION_V1).
 *  - MediaAssetsModule         → Phase 7.4 (asset collection).
 */
@Module({
  imports: [AuthModule, KnowledgePacksModule, ContentModule],
  controllers: [VideoController],
  providers: [VideoService, VideoPipelineService],
  exports: [VideoService, VideoPipelineService],
})
export class VideoModule {}
