import { Injectable } from "@nestjs/common";
import { MEDIA_VIDEO_RENDER_V1_MANIFEST, type VideoRenderInputV1 } from "@myev/shared";
import type { Prisma, VideoRenderJob } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { BackgroundJobsService } from "../background-jobs/background-jobs.service";

/**
 * Module 7 Phase 7.5 — durable video-render job submission.
 *
 * Architectural precedent (not copy-paste authority) is
 * `MediaJobSubmissionService`: create the authoritative business row
 * (`video_render_jobs`) carrying the FROZEN `VideoRenderInputV1`
 * snapshot, durably enqueue a generic `background_jobs` row that
 * references it by public_id, then link the two. No provider/render work
 * happens here — only in the isolated MEDIA render worker.
 *
 * Unlike media-generation jobs there is NO fingerprint-dedup: every
 * `POST /render` is a deliberate new render attempt and history is
 * retained per attempt (checkpoint §24). Concurrency is guarded by the
 * caller (the render stage rejects while a prior render job is
 * QUEUED/RUNNING).
 */
export interface SubmitRenderJobInput {
  workspaceId: string;
  contentItemInternalId: string;
  targetPlatform: string;
  exportProfileId: string;
  renderInput: VideoRenderInputV1;
  scriptVersionHash: string;
  sceneAssetFingerprint: string;
  voiceAudioAssetPublicId: string;
  subtitleVttAssetPublicId: string | null;
  correlationId: string;
  actorUserInternalId: string;
}

@Injectable()
export class VideoRenderJobSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly backgroundJobs: BackgroundJobsService,
  ) {}

  async submit(input: SubmitRenderJobInput): Promise<VideoRenderJob> {
    const job = await this.prisma.videoRenderJob.create({
      data: {
        workspaceId: input.workspaceId,
        contentItemId: input.contentItemInternalId,
        targetPlatform: input.targetPlatform,
        exportProfileId: input.exportProfileId,
        renderInputSnapshot: input.renderInput as unknown as Prisma.InputJsonValue,
        renderInputVersion: input.renderInput.schemaVersion,
        scriptVersionHash: input.scriptVersionHash,
        sceneAssetFingerprint: input.sceneAssetFingerprint,
        voiceAudioAssetPublicId: input.voiceAudioAssetPublicId,
        subtitleVttAssetPublicId: input.subtitleVttAssetPublicId,
        status: "QUEUED",
        correlationId: input.correlationId,
        createdById: input.actorUserInternalId,
      },
    });

    const backgroundJob = await this.backgroundJobs.enqueue({
      workspaceId: input.workspaceId,
      jobType: MEDIA_VIDEO_RENDER_V1_MANIFEST.jobType,
      payload: { videoRenderJobPublicId: job.publicId },
      correlationId: input.correlationId,
      createdByUserId: input.actorUserInternalId,
    });

    return this.prisma.videoRenderJob.update({ where: { id: job.id }, data: { backgroundJobId: backgroundJob.id } });
  }

  async findByPublicId(workspaceId: string, publicId: string): Promise<VideoRenderJob | null> {
    return this.prisma.videoRenderJob.findFirst({ where: { workspaceId, publicId, deletedAt: null } });
  }
}
