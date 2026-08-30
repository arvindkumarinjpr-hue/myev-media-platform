import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { KnowledgePacksModule } from "../knowledge-packs/knowledge-packs.module";
import { ContentModule } from "../content/content.module";
import { AiJobsModule } from "../ai-jobs/ai-jobs.module";
import { MediaGenerationModule } from "../media-generation/media-generation.module";
import { BackgroundJobsModule } from "../background-jobs/background-jobs.module";
import { StorageModule } from "../storage/storage.module";
import { VideoController } from "./video.controller";
import { VideoService } from "./video.service";
import { VideoPipelineService } from "./video-pipeline.service";
import { VideoMediaService } from "./video-media.service";
import { VideoScoringService } from "./video-scoring.service";
import { VideoScoringInputBuilder } from "./video-scoring-input-builder";
import { VideoRenderService } from "./video-render.service";
import { VideoRenderJobSubmissionService } from "./video-render-job-submission.service";
import { VideoRenderInputBuilder } from "./video-render-input-builder";
import { VideoQaService } from "./video-qa.service";

/**
 * Module 7 Phase 7.1–7.3 — Video Pipeline orchestration.
 *
 * Composes existing modules only (mirrors BlogModule):
 *  - KnowledgePacksModule → exact-version ACTIVE gate (ADR-004).
 *  - ContentModule        → ContentItemsService lifecycle + immutable
 *                           content_versions + ContentBodyValidator.
 *  - AiJobsModule         → AiJobSubmissionService (durable ai.execute.v1
 *                           — no new queue). The 6 text/advisory
 *                           generation stages all submit through it,
 *                           exactly like Blog.
 *
 * AuthModule import mirrors ContentModule/BlogModule: the controller's
 * SessionGuard needs JwtService; PermissionGuard/RbacModule are @Global.
 *
 * Phase 7.3 adds VideoScoringService + VideoScoringInputBuilder — the
 * Video-specific analog of Module 6's ContentScoringService /
 * ScoringInputBuilder. NOT imported: ContentScoringModule itself —
 * VideoScoringService injects `CONTENT_DIMENSION_REGISTRY` directly (its
 * owning module, ContentDimensionRegistryModule, is `@Global()`, so no
 * module import is needed here, only the token constant) and never calls
 * `ContentScoringService`/`ScoringInputBuilder` — see video-scoring.
 * service.ts's own doc comment for why Video needs its own input
 * builder rather than reusing Blog's.
 *
 * NOT imported yet (arrives with the phase that needs it):
 *  - MediaAssetsModule → Phase 7.4 (asset collection).
 */
@Module({
  imports: [AuthModule, KnowledgePacksModule, ContentModule, AiJobsModule, MediaGenerationModule, BackgroundJobsModule, StorageModule],
  controllers: [VideoController],
  providers: [
    VideoService,
    VideoPipelineService,
    VideoMediaService,
    VideoScoringService,
    VideoScoringInputBuilder,
    VideoRenderService,
    VideoRenderJobSubmissionService,
    VideoRenderInputBuilder,
    VideoQaService,
  ],
  exports: [VideoService, VideoPipelineService, VideoMediaService, VideoScoringService, VideoRenderService, VideoQaService],
})
export class VideoModule {}
