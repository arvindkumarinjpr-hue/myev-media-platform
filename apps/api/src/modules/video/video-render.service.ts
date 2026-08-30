import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { resolveExportProfile } from "@myev/shared";
import { Prisma, type ContentItemStatus, type VideoRenderJob } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { VideoRenderJobSubmissionService } from "./video-render-job-submission.service";
import { VideoRenderInputBuilder } from "./video-render-input-builder";
import { VideoMediaService } from "./video-media.service";
import { VIDEO_ERRORS } from "./video.errors";
import { currentSceneIds, scriptVersionHash, sceneAssetFingerprint } from "./video-media-hash";
import { readPipelineState, writePipelineState } from "./video-pipeline-state";
import type { VideoPipelineState } from "./video-pipeline.types";

export interface VideoRenderActor {
  userPublicId: string;
  userInternalId: string;
}
interface RequestContext {
  ipAddress?: string;
  correlationId: string;
}

const EDITABLE_STATUSES: ContentItemStatus[] = ["DRAFT", "IN_PROGRESS"];
const LIVE_RENDER_STATUSES: VideoRenderJob["status"][] = ["QUEUED", "RUNNING"];

const LOCK_COLUMNS = `id, public_id AS "publicId", workspace_id AS "workspaceId", content_type AS "contentType", status, metadata`;
interface LockedItem {
  id: string;
  publicId: string;
  workspaceId: string;
  contentType: string;
  status: ContentItemStatus;
  metadata: unknown;
}

/**
 * Module 7 Phase 7.5 — Render stage + Quality Gate #4 (Rendering
 * Successful).
 *
 * Submission builds and FREEZES a `VideoRenderInputV1` snapshot, creates
 * a durable `VideoRenderJob` linked 1:1 to a `background_jobs` row on the
 * MEDIA queue, and moves the render stage to RUNNING. No provider/render
 * work happens here — the isolated render worker consumes the job.
 *
 * `reconcile` recomputes Gate #4 from live truth every evaluation
 * (mirrors how `VideoMediaService.reconcile` handles Gates #2/#3): a
 * COMPLETED render job satisfies Gate #4 ONLY when its output VIDEO
 * MediaAsset exists / is ACTIVE / is workspace-matched / has a verified
 * checksum, the inspected geometry matches the export profile, and the
 * frozen input-snapshot fences still equal the current script hash /
 * scene-asset fingerprint / voice audio / subtitle artifact
 * (checkpoint §14). Any drift → the render is not current, Gate #4
 * unmet, historical render asset retained (checkpoint §24).
 */
@Injectable()
export class VideoRenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly submission: VideoRenderJobSubmissionService,
    private readonly inputBuilder: VideoRenderInputBuilder,
    private readonly videoMedia: VideoMediaService,
  ) {}

  private async lock(tx: Prisma.TransactionClient, workspaceId: string, itemPublicId: string): Promise<{ item: LockedItem; state: VideoPipelineState }> {
    const found = await tx.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { id: true, contentType: true } });
    if (!found || found.contentType !== "VIDEO") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const [row] = await tx.$queryRaw<LockedItem[]>`SELECT ${Prisma.raw(LOCK_COLUMNS)} FROM content_items WHERE id = ${found.id}::uuid FOR UPDATE`;
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const state = readPipelineState(row.metadata);
    if (!state) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    return { item: row, state };
  }

  private assertEditable(item: LockedItem): void {
    if (!EDITABLE_STATUSES.includes(item.status)) {
      throw new ConflictException({ code: VIDEO_ERRORS.VIDEO_PIPELINE_ITEM_NOT_EDITABLE, message: `The video is "${item.status}" — rendering can only be started while it is DRAFT or IN_PROGRESS.` });
    }
  }

  private async persist(tx: Prisma.TransactionClient, item: LockedItem, state: VideoPipelineState, actor: VideoRenderActor, ctx: RequestContext, afterState: Record<string, unknown>): Promise<void> {
    await tx.contentItem.update({ where: { id: item.id }, data: { metadata: writePipelineState(item.metadata, state) as Prisma.InputJsonValue } });
    await this.audit.recordWithinTransaction(tx, {
      action: "CONTENT_ITEM_UPDATED",
      actorUserId: actor.userInternalId,
      workspaceId: item.workspaceId,
      entityType: "content_item",
      entityId: item.publicId,
      afterState,
      ipAddress: ctx.ipAddress,
    });
  }

  private async targetPlatform(workspaceId: string, contentItemId: string): Promise<string> {
    const row = await this.prisma.videoScript.findFirstOrThrow({ where: { workspaceId, contentItemId, deletedAt: null }, select: { targetPlatform: true } });
    return row.targetPlatform;
  }

  // ------------------------------------------------------------------
  // Submit render (POST /video/:itemId/render)
  // ------------------------------------------------------------------

  async submitRender(workspaceId: string, actor: VideoRenderActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    const built = await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lock(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      await this.videoMedia.reconcile(workspaceId, { id: item.id }, state);
      await this.reconcileWithin(tx, item, state);

      // Concurrency guard — one live render at a time.
      if (state.render.renderJobPublicId) {
        const current = await tx.videoRenderJob.findFirst({ where: { workspaceId, publicId: state.render.renderJobPublicId }, select: { status: true } });
        if (current && LIVE_RENDER_STATUSES.includes(current.status)) {
          throw new ConflictException({ code: VIDEO_ERRORS.VIDEO_RENDER_ALREADY_RUNNING, message: "A render is already in progress for this video." });
        }
      }

      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { publicId: true } });
      const targetPlatform = await this.targetPlatform(workspaceId, item.id);
      const result = await this.inputBuilder.build({
        workspacePublicId: workspace.publicId,
        workspaceId,
        contentItemId: item.id,
        contentItemPublicId: item.publicId,
        targetPlatform,
        state,
        correlationId: ctx.correlationId,
      });
      if (!result.ok || !result.input || !result.fences) {
        throw new UnprocessableEntityException({
          code: result.errors.some((e) => e.startsWith("scene ") || e.includes("timeline") || e.includes("schema")) ? VIDEO_ERRORS.VIDEO_RENDER_INPUT_INVALID : VIDEO_ERRORS.VIDEO_RENDER_PREREQUISITES_UNMET,
          message: `Cannot render: ${result.errors.join("; ")}`,
        });
      }

      // Claim the stage (attempt++ per FR-VID-007 resume-not-restart budget).
      state.render = {
        ...state.render,
        status: "RUNNING",
        attempt: state.render.attempt + 1,
        renderJobPublicId: "pending",
        renderedVideoPublicId: null,
        renderedVideoAssetGroupId: null,
        exportProfileId: result.exportProfileId,
        expectedDurationMs: result.expectedDurationMs,
        outputWidth: null,
        outputHeight: null,
        outputDurationMs: null,
        outputChecksumSha256: null,
        outputByteSize: null,
        scriptVersionHash: result.fences.scriptVersionHash,
        sceneAssetFingerprint: result.fences.sceneAssetFingerprint,
        voiceAudioAssetPublicId: result.fences.voiceAudioAssetPublicId,
        subtitleVttAssetPublicId: result.fences.subtitleVttAssetPublicId,
        snapshotScenes: result.snapshotScenes,
        brandingLayerConfigured: result.branding.layerConfigured,
        brandingLogoInSnapshot: false,
        brandingIntroRequired: result.branding.introRequired,
        brandingIntroRendered: false,
        brandingOutroRequired: result.branding.outroRequired,
        brandingOutroRendered: false,
        completedAt: null,
        failureReason: null,
      };
      // A new render invalidates any prior QA (checkpoint §23).
      state.qa = { status: "PENDING", checks: [], passed: null, renderJobPublicId: null, renderedVideoPublicId: null, completedAt: null };
      await this.persist(tx, item, state, actor, ctx, { "videoPipeline.render.status": "RUNNING", "videoPipeline.render.attempt": state.render.attempt });
      return { input: result.input, fences: result.fences, targetPlatform, exportProfileId: result.exportProfileId!, contentItemId: item.id };
    });

    let renderJob: VideoRenderJob | null = null;
    let submitError: string | null = null;
    try {
      renderJob = await this.submission.submit({
        workspaceId,
        contentItemInternalId: built.contentItemId,
        targetPlatform: built.targetPlatform,
        exportProfileId: built.exportProfileId,
        renderInput: built.input,
        scriptVersionHash: built.fences.scriptVersionHash,
        sceneAssetFingerprint: built.fences.sceneAssetFingerprint,
        voiceAudioAssetPublicId: built.fences.voiceAudioAssetPublicId,
        subtitleVttAssetPublicId: built.fences.subtitleVttAssetPublicId,
        correlationId: ctx.correlationId,
        actorUserInternalId: actor.userInternalId,
      });
    } catch (err) {
      submitError = err instanceof Error ? err.message : "render job submission failed";
    }

    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lock(tx, workspaceId, itemPublicId);
      if (renderJob) {
        state.render = { ...state.render, renderJobPublicId: renderJob.publicId, status: "RUNNING", failureReason: null };
        await tx.videoScript.updateMany({ where: { workspaceId, contentItemId: item.id }, data: { renderJobId: renderJob.id } });
      } else {
        state.render = { ...state.render, renderJobPublicId: null, status: "FAILED", failureReason: submitError ?? "render job submission failed" };
      }
      await this.persist(tx, item, state, actor, ctx, { "videoPipeline.render.renderJobPublicId": renderJob?.publicId ?? null });
    });

    if (submitError) {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_RENDER_PREREQUISITES_UNMET, message: `Could not start render: ${submitError}` });
    }
  }

  // ------------------------------------------------------------------
  // Gate #4 reconcile
  // ------------------------------------------------------------------

  async reconcile(workspaceId: string, item: { id: string }, state: VideoPipelineState, options?: { skipMedia?: boolean }): Promise<{ state: VideoPipelineState; changed: boolean }> {
    const before = JSON.stringify(state.render);
    if (!options?.skipMedia) await this.videoMedia.reconcile(workspaceId, { id: item.id }, state);
    await this.reconcileWithin(this.prisma, item, state);
    return { state, changed: before !== JSON.stringify(state.render) };
  }

  private async reconcileWithin(db: Prisma.TransactionClient | PrismaService, _item: { id: string }, state: VideoPipelineState): Promise<void> {
    const r = state.render;
    if (!r.renderJobPublicId || r.renderJobPublicId === "pending") {
      // Nothing submitted yet (or mid two-phase submit) — leave the stage
      // status as the claim step set it.
      return;
    }

    const job = await db.videoRenderJob.findFirst({ where: { publicId: r.renderJobPublicId } });
    if (!job || job.deletedAt) {
      state.render = { ...r, status: "PENDING", failureReason: "render job not found", renderJobPublicId: null };
      return;
    }

    if (job.status === "QUEUED" || job.status === "RUNNING") {
      state.render = { ...r, status: "RUNNING", failureReason: null };
      return;
    }

    if (job.status === "FAILED" || job.status === "TIMED_OUT") {
      state.render = { ...r, status: "FAILED", failureReason: job.errorCode ?? `render job ${job.status}` };
      return;
    }

    // COMPLETED — Gate #4 currentness (checkpoint §14).
    const currentHash = scriptVersionHash(state.script.artifact);
    const currentSceneIdList = currentSceneIds(state.scenePlan.artifact);
    const currentPairs: Array<[string, string | null]> = currentSceneIdList.map((sceneId) => {
      const scene = state.assets.scenes.find((s) => s.sceneId === sceneId);
      return [sceneId, scene?.mediaAssetPublicId ?? null];
    });
    const currentFingerprint = sceneAssetFingerprint(currentPairs);

    const drift: string[] = [];
    if (job.scriptVersionHash !== currentHash) drift.push("script");
    if (job.sceneAssetFingerprint !== currentFingerprint) drift.push("scene assets");
    if (job.voiceAudioAssetPublicId !== state.voice.audioAssetPublicId) drift.push("voice audio");
    if ((job.subtitleVttAssetPublicId ?? null) !== (state.subtitles.vttAssetPublicId ?? null)) drift.push("subtitles");
    if (state.script.status !== "APPROVED") drift.push("script approval");
    if (state.assets.status !== "READY") drift.push("assets gate");
    if (state.voice.status !== "READY") drift.push("voice gate");
    if (state.subtitles.status !== "READY") drift.push("subtitle gate");

    const outputAsset = job.outputMediaAssetPublicId
      ? await db.mediaAsset.findFirst({
          where: { publicId: job.outputMediaAssetPublicId },
          select: { status: true, assetType: true, workspaceId: true, verifiedChecksumSha256: true, assetGroupId: true, publicId: true },
        })
      : null;

    const assetOk =
      !!outputAsset &&
      outputAsset.status === "ACTIVE" &&
      outputAsset.assetType === "VIDEO" &&
      outputAsset.workspaceId === job.workspaceId &&
      !!outputAsset.verifiedChecksumSha256 &&
      outputAsset.verifiedChecksumSha256 === job.outputChecksumSha256;

    let profileOk = false;
    try {
      const profile = resolveExportProfile(job.targetPlatform);
      profileOk = job.outputWidth === profile.width && job.outputHeight === profile.height;
    } catch {
      profileOk = false;
    }

    if (!assetOk) {
      state.render = { ...r, status: "FAILED", failureReason: "render completed but the output VIDEO asset is missing, not ACTIVE, or its checksum does not verify", renderedVideoPublicId: null };
      return;
    }
    if (!profileOk) {
      state.render = { ...r, status: "FAILED", failureReason: "rendered output does not match the required export profile geometry" };
      return;
    }
    if (drift.length > 0) {
      state.render = {
        ...r,
        status: "PENDING",
        failureReason: `${drift.join(", ")} changed since this render — re-render to satisfy Gate #4`,
        renderedVideoPublicId: outputAsset!.publicId,
        renderedVideoAssetGroupId: outputAsset!.assetGroupId,
      };
      return;
    }

    state.render = {
      ...r,
      status: "READY",
      failureReason: null,
      renderedVideoPublicId: outputAsset!.publicId,
      renderedVideoAssetGroupId: outputAsset!.assetGroupId,
      exportProfileId: job.exportProfileId,
      expectedDurationMs: r.expectedDurationMs ?? job.outputDurationMs,
      outputWidth: job.outputWidth,
      outputHeight: job.outputHeight,
      outputDurationMs: job.outputDurationMs,
      outputChecksumSha256: job.outputChecksumSha256,
      outputByteSize: job.outputByteSize ? Number(job.outputByteSize) : null,
      brandingLogoInSnapshot: r.brandingLogoInSnapshot,
      brandingIntroRendered: r.brandingIntroRequired ? true : r.brandingIntroRendered,
      brandingOutroRendered: r.brandingOutroRequired ? true : r.brandingOutroRendered,
      completedAt: job.completedAt ? job.completedAt.toISOString() : new Date().toISOString(),
      snapshotScenes: r.snapshotScenes.map((s) => ({ ...s, materialized: true })),
    };
  }

  // ------------------------------------------------------------------
  // Read model (GET /video/:itemId/render)
  // ------------------------------------------------------------------

  async getRender(workspaceId: string, itemPublicId: string): Promise<Record<string, unknown>> {
    const item = await this.prisma.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { id: true, contentType: true, metadata: true } });
    if (!item || item.contentType !== "VIDEO") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const state = readPipelineState(item.metadata);
    if (!state) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    const { state: reconciled } = await this.reconcile(workspaceId, { id: item.id }, state);
    const jobs = await this.prisma.videoRenderJob.findMany({
      where: { workspaceId, contentItemId: item.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { publicId: true, status: true, attempt: true, exportProfileId: true, outputMediaAssetPublicId: true, outputWidth: true, outputHeight: true, outputDurationMs: true, renderEngine: true, errorCode: true, createdAt: true, completedAt: true },
    });
    let profile: Record<string, unknown> | null = null;
    try {
      const p = resolveExportProfile(reconciled.render.exportProfileId ?? "");
      profile = { id: p.id, width: p.width, height: p.height, fps: p.fps, aspectRatio: p.aspectRatio, container: p.container };
    } catch {
      profile = null;
    }
    return {
      gate4: { name: "rendering_successful", passed: reconciled.render.status === "READY", failureReason: reconciled.render.failureReason },
      render: reconciled.render,
      exportProfile: profile,
      history: jobs,
    };
  }
}
