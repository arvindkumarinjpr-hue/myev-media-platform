import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma, type ContentItemStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { VIDEO_ERRORS } from "./video.errors";
import { deriveStage, isPublishReady, readPipelineState, unmetReviewGates } from "./video-pipeline-state";
import type { VideoPipelineState } from "./video-pipeline.types";

/**
 * Module 7 Phase 7.1 — Video pipeline orchestration foundation.
 *
 * Structural mirror of Module 6's `BlogPipelineService`, reduced to what
 * Phase 7.1 needs: a PURE read model (`projectReadModel`) and a list
 * projection. No stage executes yet — brief/script/scene/asset/voice/
 * subtitle/render/qa/seo actions arrive in Phases 7.2–7.5 and only ADD
 * methods here.
 *
 * Invariants carried from the Blog precedent:
 *  - workspace isolation: every query carries a `workspaceId` predicate.
 *  - explicit mutation/read boundary: `projectReadModel` performs ZERO
 *    writes (no GET-side materialization). `deriveStage` /
 *    `unmetReviewGates` are pure functions over the persisted state.
 *  - typed errors ({ code, message }).
 */
@Injectable()
export class VideoPipelineService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * PURE read model for one video pipeline item. Deterministic: calling
   * it twice with no intervening mutation returns byte-identical output
   * (the derived stage + gates are functions of the persisted state and
   * the item's own lifecycle status). Performs no writes.
   */
  async projectReadModel(workspaceId: string, itemPublicId: string): Promise<Record<string, unknown>> {
    const item = await this.prisma.contentItem.findFirst({
      where: { publicId: itemPublicId, workspaceId, deletedAt: null },
      select: { id: true, publicId: true, contentType: true, title: true, status: true, metadata: true, createdAt: true, updatedAt: true },
    });
    if (!item || item.contentType !== "VIDEO") {
      throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    }
    const state = readPipelineState(item.metadata);
    if (!state) {
      throw new UnprocessableEntityException({
        code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM,
        message: "This video content item was not started as a pipeline video.",
      });
    }

    const script = await this.prisma.videoScript.findFirst({
      where: { workspaceId, contentItemId: item.id, deletedAt: null },
      select: {
        publicId: true,
        targetPlatform: true,
        exportProfile: true,
        durationSecondsTarget: true,
        scriptBody: true,
        scenePlan: true,
        metaTitle: true,
        metaDescription: true,
      },
    });

    return this.serializeReadModel(item, state, script);
  }

  private serializeReadModel(
    item: { publicId: string; title: string; contentType: string; status: ContentItemStatus; createdAt: Date; updatedAt: Date },
    state: VideoPipelineState,
    script: {
      publicId: string;
      targetPlatform: string;
      exportProfile: string | null;
      durationSecondsTarget: number | null;
      scriptBody: string | null;
      scenePlan: Prisma.JsonValue;
      metaTitle: string | null;
      metaDescription: string | null;
    } | null,
  ): Record<string, unknown> {
    const gates = unmetReviewGates(state);
    return {
      contentItem: { publicId: item.publicId, title: item.title, contentType: item.contentType, status: item.status },
      knowledgePackVersionId: state.knowledgePackVersionId,
      videoScript: script
        ? {
            publicId: script.publicId,
            targetPlatform: script.targetPlatform,
            exportProfile: script.exportProfile,
            durationSecondsTarget: script.durationSecondsTarget,
            hasScriptBody: script.scriptBody !== null,
            hasScenePlan: script.scenePlan !== null,
            hasSeoMetadata: script.metaTitle !== null && script.metaDescription !== null,
          }
        : null,
      currentStage: deriveStage(state, item.status),
      publishReady: isPublishReady(item.status),
      stages: {
        brief: { status: state.brief.status, aiJobPublicId: state.brief.aiJobPublicId, failureReason: state.brief.failureReason },
        script: { status: state.script.status, aiJobPublicId: state.script.aiJobPublicId, approvedAt: state.script.approvedAt, failureReason: state.script.failureReason },
        scenePlan: { status: state.scenePlan.status, aiJobPublicId: state.scenePlan.aiJobPublicId, failureReason: state.scenePlan.failureReason },
        assets: { status: state.assets.status, missingScenes: state.assets.missingScenes, completedAt: state.assets.completedAt },
        voice: { status: state.voice.status, audioAssetPublicId: state.voice.audioAssetPublicId, failureReason: state.voice.failureReason },
        subtitles: { status: state.subtitles.status, subtitleAssetPublicId: state.subtitles.subtitleAssetPublicId },
        render: { status: state.render.status, renderJobPublicId: state.render.renderJobPublicId, attempt: state.render.attempt, failureReason: state.render.failureReason },
        qa: { status: state.qa.status, checks: state.qa.checks, completedAt: state.qa.completedAt },
        seo: { status: state.seo.status, aiJobPublicId: state.seo.aiJobPublicId, failureReason: state.seo.failureReason },
      },
      reviewGatesUnmet: gates,
      // Phase 7.1: submit-for-review is not wired until Phase 7.3 and the
      // shared Module 1E seal blocks the generic route, so this is always
      // false for now (no stage can be completed yet).
      canSubmitForReview: gates.length === 0 && ["DRAFT", "IN_PROGRESS"].includes(item.status),
      timestamps: { createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() },
    };
  }
}
