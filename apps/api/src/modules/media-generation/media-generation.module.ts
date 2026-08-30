import { Module } from "@nestjs/common";
import { BackgroundJobsModule } from "../background-jobs/background-jobs.module";
import { MediaJobSubmissionService } from "./media-job-submission.service";
import { VoiceCatalogService } from "./voice-catalog";

/**
 * Module 7 Phase 7.4 — Media Generation submission layer.
 *
 * Composes the existing Queue Engine only: `BackgroundJobsModule`
 * (Module 1F enqueue path, unmodified). No provider credentials, no
 * provider SDKs — the API only ever enqueues a `media.*` job; every
 * provider call happens in the isolated MEDIA worker processors.
 *
 * `PrismaService` is `@Global()` so `PrismaModule` is not imported here.
 */
@Module({
  imports: [BackgroundJobsModule],
  providers: [MediaJobSubmissionService, VoiceCatalogService],
  exports: [MediaJobSubmissionService, VoiceCatalogService],
})
export class MediaGenerationModule {}
