import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { VideoScenePlannerAgentOutput, VideoScriptAgentOutput } from "@myev/shared";
import { Prisma, type ContentItemStatus, type MediaJob } from "../../../generated/prisma";
import type { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { MediaJobSubmissionService } from "../media-generation/media-job-submission.service";
import { VoiceCatalogService } from "../media-generation/voice-catalog";
import { VIDEO_ERRORS } from "./video.errors";
import { currentSceneIds, narrationText, scriptVersionHash } from "./video-media-hash";
import { readPipelineState, writePipelineState } from "./video-pipeline-state";
import type { AssetSceneRef, MediaStageStatus, VideoPipelineState } from "./video-pipeline.types";

export interface VideoMediaActor {
  userPublicId: string;
  userInternalId: string;
}
interface RequestContext {
  ipAddress?: string;
  correlationId: string;
}

const EDITABLE_STATUSES: ContentItemStatus[] = ["DRAFT", "IN_PROGRESS"];
const LIVE_ASSET_STATUS = "ACTIVE" as const;

const LOCK_COLUMNS = `id, public_id AS "publicId", workspace_id AS "workspaceId", content_type AS "contentType", title, status, metadata`;
interface LockedItem {
  id: string;
  publicId: string;
  workspaceId: string;
  contentType: string;
  title: string;
  status: ContentItemStatus;
  metadata: unknown;
}

interface MediaAssetLite {
  publicId: string;
  assetGroupId: string;
  versionNumber: number;
  assetType: string;
  status: string;
  workspaceId: string;
  metadata: unknown;
  verifiedSizeBytes: bigint | null;
}

/**
 * Module 7 Phase 7.4 — Video media stages: per-scene asset resolution +
 * Gate #2, voice generation + Gate #3, deterministic subtitle generation,
 * and thumbnail-concept selection + real thumbnail image generation.
 *
 * NO provider calls here — every generation step enqueues a `media.*`
 * job via `MediaJobSubmissionService`; the isolated MEDIA worker
 * processors do the work and persist the resulting `MediaAsset`. This
 * service only orchestrates state + gates, and RECONCILES the stage
 * statuses from live `media_jobs` + `media_assets` truth (mirroring how
 * `VideoPipelineService.finalizeStages` reconciles AI stages from live
 * `ai_jobs`). A COMPLETED media job never satisfies a gate on its own —
 * the persisted ACTIVE MediaAsset is the authority.
 */
@Injectable()
export class VideoMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mediaJobs: MediaJobSubmissionService,
    private readonly voiceCatalog: VoiceCatalogService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ------------------------------------------------------------------
  // Loading + locking
  // ------------------------------------------------------------------

  private async lockItem(tx: Prisma.TransactionClient, workspaceId: string, itemPublicId: string): Promise<{ item: LockedItem; state: VideoPipelineState }> {
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
      throw new ConflictException({ code: VIDEO_ERRORS.VIDEO_PIPELINE_ITEM_NOT_EDITABLE, message: `The video is "${item.status}" — media stages can only run while it is DRAFT or IN_PROGRESS.` });
    }
  }

  private async persist(tx: Prisma.TransactionClient, item: LockedItem, state: VideoPipelineState, actor: VideoMediaActor, ctx: RequestContext, afterState: Record<string, unknown>): Promise<void> {
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

  private scriptArtifact(state: VideoPipelineState): VideoScriptAgentOutput | null {
    return state.script.artifact;
  }
  private scenePlanArtifact(state: VideoPipelineState): VideoScenePlannerAgentOutput | null {
    return state.scenePlan.artifact;
  }

  private async loadMediaAssets(workspaceId: string, contentItemId: string): Promise<Map<string, MediaAssetLite[]>> {
    const rows = await this.prisma.mediaAsset.findMany({
      where: { workspaceId, contentItemId, deletedAt: null },
      select: { publicId: true, assetGroupId: true, versionNumber: true, assetType: true, status: true, workspaceId: true, metadata: true, verifiedSizeBytes: true },
    });
    const byGroup = new Map<string, MediaAssetLite[]>();
    for (const r of rows) {
      const list = byGroup.get(r.assetGroupId) ?? [];
      list.push(r);
      byGroup.set(r.assetGroupId, list);
    }
    return byGroup;
  }

  private currentActiveVersion(group: MediaAssetLite[] | undefined): MediaAssetLite | null {
    if (!group || group.length === 0) return null;
    const active = group.filter((a) => a.status === LIVE_ASSET_STATUS).sort((a, b) => b.versionNumber - a.versionNumber);
    return active[0] ?? null;
  }

  private async loadMediaJobs(workspaceId: string, contentItemId: string, publicIds: string[]): Promise<Map<string, MediaJob>> {
    if (publicIds.length === 0) return new Map();
    const rows = await this.prisma.mediaJob.findMany({ where: { workspaceId, contentItemId, publicId: { in: publicIds }, deletedAt: null } });
    return new Map(rows.map((r) => [r.publicId, r]));
  }

  // ------------------------------------------------------------------
  // Reconcile — recompute assets/voice/subtitles/thumbnailImage from
  // live media_jobs + media_assets. Pure over its loaded inputs.
  // ------------------------------------------------------------------

  async reconcile(workspaceId: string, item: { id: string }, state: VideoPipelineState): Promise<{ state: VideoPipelineState; changed: boolean }> {
    const before = JSON.stringify({ a: state.assets, v: state.voice, s: state.subtitles, t: state.thumbnailImage });
    const assetsByGroup = await this.loadMediaAssets(workspaceId, item.id);

    const pendingJobIds = [
      ...state.assets.scenes.map((s) => s.mediaJobPublicId),
      state.voice.mediaJobPublicId,
      state.subtitles.mediaJobPublicId,
      state.thumbnailImage.mediaJobPublicId,
    ].filter((id): id is string => !!id);
    const jobs = await this.loadMediaJobs(workspaceId, item.id, pendingJobIds);

    this.reconcileAssets(state, assetsByGroup, jobs);
    this.reconcileVoice(state, assetsByGroup, jobs);
    this.reconcileSubtitles(state, assetsByGroup, jobs);
    this.reconcileThumbnailImage(state, assetsByGroup, jobs);

    const after = JSON.stringify({ a: state.assets, v: state.voice, s: state.subtitles, t: state.thumbnailImage });
    return { state, changed: before !== after };
  }

  private jobOutput(job: MediaJob | undefined): Record<string, unknown> | null {
    if (!job || job.status !== "COMPLETED" || !job.outputPayload || typeof job.outputPayload !== "object") return null;
    return job.outputPayload as Record<string, unknown>;
  }

  private reconcileAssets(state: VideoPipelineState, assetsByGroup: Map<string, MediaAssetLite[]>, jobs: Map<string, MediaJob>): void {
    const sceneIds = currentSceneIds(this.scenePlanArtifact(state));

    // Advance any pending per-scene generation jobs.
    for (const scene of state.assets.scenes) {
      if (!scene.mediaJobPublicId) continue;
      const job = jobs.get(scene.mediaJobPublicId);
      if (!job) continue;
      if (job.status === "FAILED" || job.status === "TIMED_OUT") {
        scene.failureReason = job.errorCode ?? `media job ${job.status}`;
        scene.mediaJobPublicId = null;
        continue;
      }
      const out = this.jobOutput(job);
      if (!out) continue;
      const assetPublicId = typeof out.mediaAssetPublicId === "string" ? out.mediaAssetPublicId : null;
      const assetGroupId = typeof out.mediaAssetGroupId === "string" ? out.mediaAssetGroupId : null;
      if (assetGroupId && this.currentActiveVersion(assetsByGroup.get(assetGroupId))) {
        const active = this.currentActiveVersion(assetsByGroup.get(assetGroupId))!;
        scene.mediaAssetGroupId = assetGroupId;
        scene.mediaAssetPublicId = active.publicId;
        scene.source = "ai_generated";
        scene.failureReason = null;
        scene.mediaJobPublicId = null;
      } else if (assetPublicId) {
        scene.failureReason = "generated asset is not ACTIVE";
        scene.mediaJobPublicId = null;
      }
    }

    // Rebuild `scenes` to exactly match the CURRENT ScenePlan — obsolete
    // scene ids drop out (their assets can never satisfy the gate);
    // brand-new ids get empty slots.
    const prev = new Map(state.assets.scenes.map((s) => [s.sceneId, s]));
    const rebuilt: AssetSceneRef[] = sceneIds.map((sceneId) => {
      const existing = prev.get(sceneId);
      if (existing && existing.mediaAssetGroupId) {
        // Re-verify the recorded asset is still the current ACTIVE version.
        const active = this.currentActiveVersion(assetsByGroup.get(existing.mediaAssetGroupId));
        if (active) {
          return { ...existing, mediaAssetPublicId: active.publicId, failureReason: null };
        }
        return { sceneId, mediaAssetGroupId: null, mediaAssetPublicId: null, source: null, mediaJobPublicId: existing.mediaJobPublicId, failureReason: "attached asset is no longer ACTIVE" };
      }
      return existing ?? { sceneId, mediaAssetGroupId: null, mediaAssetPublicId: null, source: null, mediaJobPublicId: null, failureReason: null };
    });

    state.assets.scenes = rebuilt;
    state.assets.missingScenes = rebuilt.filter((s) => !s.mediaAssetGroupId).map((s) => s.sceneId);
    const anyPending = rebuilt.some((s) => s.mediaJobPublicId);
    let status: MediaStageStatus;
    if (sceneIds.length === 0) status = "PENDING";
    else if (state.assets.missingScenes.length === 0) status = "READY";
    else if (anyPending) status = "RUNNING";
    else status = "PENDING";
    state.assets.status = status;
    state.assets.completedAt = status === "READY" ? (state.assets.completedAt ?? new Date().toISOString()) : null;
  }

  private reconcileVoice(state: VideoPipelineState, assetsByGroup: Map<string, MediaAssetLite[]>, jobs: Map<string, MediaJob>): void {
    const v = state.voice;
    const currentHash = scriptVersionHash(this.scriptArtifact(state));

    if (v.mediaJobPublicId && v.status !== "READY") {
      const job = jobs.get(v.mediaJobPublicId);
      if (job && (job.status === "FAILED" || job.status === "TIMED_OUT")) {
        v.status = "FAILED";
        v.failureReason = job?.errorCode ?? `media job ${job.status}`;
        v.mediaJobPublicId = null;
      } else {
        const out = this.jobOutput(job);
        if (out) {
          const audioPublicId = typeof out.audioAssetPublicId === "string" ? out.audioAssetPublicId : null;
          const asset = audioPublicId ? this.findByPublicId(assetsByGroup, audioPublicId) : null;
          const durationMs = typeof out.durationMs === "number" ? out.durationMs : null;
          const timingKey = typeof out.wordTimingObjectKey === "string" ? out.wordTimingObjectKey : null;
          if (asset && asset.status === LIVE_ASSET_STATUS && durationMs && durationMs > 0 && timingKey) {
            v.audioAssetPublicId = asset.publicId;
            v.wordTimingObjectKey = timingKey;
            v.audioDurationMs = durationMs;
            v.scriptVersionHash = typeof out.scriptVersionHash === "string" ? out.scriptVersionHash : currentHash;
            v.voiceProfileId = typeof out.voiceProfileId === "string" ? out.voiceProfileId : v.voiceProfileId;
            v.status = "READY";
            v.failureReason = null;
            v.mediaJobPublicId = null;
          } else if (out.audioAssetPublicId) {
            v.status = "FAILED";
            v.failureReason = "voice artifact incomplete (missing audio, duration, or word timings)";
            v.mediaJobPublicId = null;
          }
        }
      }
    }

    if (v.status === "READY") {
      const asset = v.audioAssetPublicId ? this.findByPublicId(assetsByGroup, v.audioAssetPublicId) : null;
      if (!asset || asset.status !== LIVE_ASSET_STATUS) {
        v.status = "PENDING";
        v.failureReason = "audio asset is no longer ACTIVE";
      } else if (v.scriptVersionHash && currentHash && v.scriptVersionHash !== currentHash) {
        v.status = "PENDING";
        v.failureReason = "script changed since voice generation — regenerate voice";
      }
    }
  }

  private reconcileSubtitles(state: VideoPipelineState, assetsByGroup: Map<string, MediaAssetLite[]>, jobs: Map<string, MediaJob>): void {
    const s = state.subtitles;
    if (s.mediaJobPublicId && s.status !== "READY") {
      const job = jobs.get(s.mediaJobPublicId);
      if (job && (job.status === "FAILED" || job.status === "TIMED_OUT")) {
        s.status = "FAILED";
        s.failureReason = job?.errorCode ?? `media job ${job.status}`;
        s.mediaJobPublicId = null;
      } else {
        const out = this.jobOutput(job);
        if (out) {
          const srt = typeof out.srtAssetPublicId === "string" ? out.srtAssetPublicId : null;
          const vtt = typeof out.vttAssetPublicId === "string" ? out.vttAssetPublicId : null;
          const srtAsset = srt ? this.findByPublicId(assetsByGroup, srt) : null;
          const vttAsset = vtt ? this.findByPublicId(assetsByGroup, vtt) : null;
          if (srtAsset?.status === LIVE_ASSET_STATUS && vttAsset?.status === LIVE_ASSET_STATUS) {
            s.srtAssetPublicId = srt;
            s.vttAssetPublicId = vtt;
            s.sourceAudioAssetPublicId = typeof out.sourceAudioAssetPublicId === "string" ? out.sourceAudioAssetPublicId : state.voice.audioAssetPublicId;
            s.cueCount = typeof out.cueCount === "number" ? out.cueCount : null;
            s.status = "READY";
            s.failureReason = null;
            s.mediaJobPublicId = null;
          } else if (out.srtAssetPublicId) {
            s.status = "FAILED";
            s.failureReason = "subtitle assets are not ACTIVE";
            s.mediaJobPublicId = null;
          }
        }
      }
    }
    if (s.status === "READY" && s.sourceAudioAssetPublicId && s.sourceAudioAssetPublicId !== state.voice.audioAssetPublicId) {
      s.status = "PENDING";
      s.failureReason = "voice was regenerated — rebuild subtitles";
    }
  }

  private reconcileThumbnailImage(state: VideoPipelineState, assetsByGroup: Map<string, MediaAssetLite[]>, jobs: Map<string, MediaJob>): void {
    const t = state.thumbnailImage;
    if (t.mediaJobPublicId && t.status !== "READY") {
      const job = jobs.get(t.mediaJobPublicId);
      if (job && (job.status === "FAILED" || job.status === "TIMED_OUT")) {
        t.status = "FAILED";
        t.failureReason = job?.errorCode ?? `media job ${job.status}`;
        t.mediaJobPublicId = null;
      } else {
        const out = this.jobOutput(job);
        if (out) {
          const groupId = typeof out.mediaAssetGroupId === "string" ? out.mediaAssetGroupId : null;
          const active = groupId ? this.currentActiveVersion(assetsByGroup.get(groupId)) : null;
          if (active) {
            t.imageAssetGroupId = groupId;
            t.imageAssetPublicId = active.publicId;
            t.imageWidth = typeof out.width === "number" ? out.width : null;
            t.imageHeight = typeof out.height === "number" ? out.height : null;
            t.status = "READY";
            t.failureReason = null;
            t.mediaJobPublicId = null;
          } else if (out.mediaAssetPublicId) {
            t.status = "FAILED";
            t.failureReason = "generated thumbnail image is not ACTIVE";
            t.mediaJobPublicId = null;
          }
        }
      }
    }
    if (t.status === "READY" && t.imageAssetGroupId && !this.currentActiveVersion(assetsByGroup.get(t.imageAssetGroupId))) {
      t.status = "PENDING";
      t.failureReason = "thumbnail image asset is no longer ACTIVE";
    }
  }

  private findByPublicId(assetsByGroup: Map<string, MediaAssetLite[]>, publicId: string): MediaAssetLite | null {
    for (const list of assetsByGroup.values()) {
      const hit = list.find((a) => a.publicId === publicId);
      if (hit) return hit;
    }
    return null;
  }

  /** Public voice catalog view — provider-neutral ids only, no Azure voice names. */
  listVoices(): Array<{ voiceProfileId: string; language: string; displayName: string; styles: string[] }> {
    return this.voiceCatalog.list().map(({ voiceProfileId, language, displayName, styles }) => ({ voiceProfileId, language, displayName, styles }));
  }

  private thumbnailAspectFor(targetPlatform: string): "16:9" | "9:16" | "1:1" | "4:5" {
    const overrideRaw = this.config.get("videoMedia", { infer: true }).imageAspectByPlatform;
    if (overrideRaw) {
      try {
        const map = JSON.parse(overrideRaw) as Record<string, string>;
        const v = map[targetPlatform];
        if (v === "16:9" || v === "9:16" || v === "1:1" || v === "4:5") return v;
      } catch {
        /* fall through to defaults */
      }
    }
    if (/SHORT|REEL/i.test(targetPlatform)) return "9:16";
    if (/SQUARE/i.test(targetPlatform)) return "1:1";
    return "16:9";
  }

  // ------------------------------------------------------------------
  // Asset stage — per-scene resolution + Gate #2
  // ------------------------------------------------------------------

  async listAssets(workspaceId: string, itemPublicId: string): Promise<Record<string, unknown>> {
    const item = await this.prisma.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { id: true, contentType: true, metadata: true } });
    if (!item || item.contentType !== "VIDEO") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const state = readPipelineState(item.metadata);
    if (!state) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    const locked: LockedItem = { id: item.id, publicId: itemPublicId, workspaceId, contentType: "VIDEO", title: "", status: "DRAFT", metadata: item.metadata };
    const { state: reconciled } = await this.reconcile(workspaceId, locked, state);
    const plan = this.scenePlanArtifact(reconciled);
    const scenesByPlan = new Map((plan?.scenes ?? []).map((s) => [s.sceneId, s]));
    return {
      gate2: { name: "assets_available", passed: reconciled.assets.status === "READY", missingScenes: reconciled.assets.missingScenes },
      status: reconciled.assets.status,
      scenes: reconciled.assets.scenes.map((sc) => ({
        sceneId: sc.sceneId,
        sceneTitle: scenesByPlan.get(sc.sceneId)?.visualInstruction?.slice(0, 80) ?? null,
        resolved: !!sc.mediaAssetGroupId,
        source: sc.source,
        mediaAssetPublicId: sc.mediaAssetPublicId,
        pendingJob: sc.mediaJobPublicId,
        failureReason: sc.failureReason,
      })),
    };
  }

  async generateSceneImage(workspaceId: string, actor: VideoMediaActor, itemPublicId: string, sceneId: string, ctx: RequestContext): Promise<void> {
    const { plan } = await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lockItem(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: reconciled } = await this.reconcile(workspaceId, item, state);
      const planArtifact = this.scenePlanArtifact(reconciled);
      if (!planArtifact || reconciled.scenePlan.status !== "READY") {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCENE_PLAN_REQUIRED, message: "A generated scene plan is required before scene-asset generation." });
      }
      const scene = planArtifact.scenes.find((s) => s.sceneId === sceneId);
      if (!scene) throw new NotFoundException({ code: VIDEO_ERRORS.VIDEO_SCENE_NOT_FOUND, message: `Scene "${sceneId}" is not in the current scene plan.` });
      const entry = reconciled.assets.scenes.find((s) => s.sceneId === sceneId);
      if (entry?.mediaJobPublicId) {
        throw new ConflictException({ code: VIDEO_ERRORS.VIDEO_MEDIA_STAGE_ALREADY_RUNNING, message: `Scene "${sceneId}" already has an image generation in progress.` });
      }
      // Claim: mark this scene as generating (placeholder job id set in phase 3).
      const target = reconciled.assets.scenes.find((s) => s.sceneId === sceneId);
      if (target) {
        target.mediaJobPublicId = "pending";
        target.failureReason = null;
      }
      reconciled.assets.status = "RUNNING";
      await this.persist(tx, item, reconciled, actor, ctx, { [`videoPipeline.assets.${sceneId}.status`]: "RUNNING" });
      return { plan: planArtifact };
    });

    const scene = plan.scenes.find((s) => s.sceneId === sceneId)!;
    const brief = null; // brand/style context is derived from the scene + platform only in V1
    void brief;
    const prompt = [
      scene.visualInstruction,
      scene.bRollSuggestion ? `B-roll: ${scene.bRollSuggestion}` : "",
      `Asset needs: ${scene.assetRequirements.map((a) => `${a.kind} — ${a.description}`).join("; ")}`,
    ]
      .filter(Boolean)
      .join("\n");

    await this.submitAndLink(workspaceId, actor, itemPublicId, ctx, {
      operation: "IMAGE_GENERATE",
      fingerprintParts: ["scene", sceneId, scene.visualInstruction, plan.scenePlanVersion],
      inputPayload: {
        purpose: "scene",
        sceneId,
        prompt,
        aspectRatio: this.thumbnailAspectFor(plan.targetPlatform),
        assetType: "IMAGE",
        existingAssetGroupId: null,
      },
      onLink: (state, jobPublicId) => {
        const target = state.assets.scenes.find((s) => s.sceneId === sceneId);
        if (target) target.mediaJobPublicId = jobPublicId;
      },
      onFail: (state, reason) => {
        const target = state.assets.scenes.find((s) => s.sceneId === sceneId);
        if (target) {
          target.mediaJobPublicId = null;
          target.failureReason = reason;
        }
      },
    });
  }

  async attachSceneAsset(workspaceId: string, actor: VideoMediaActor, itemPublicId: string, sceneId: string, mediaAssetPublicId: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lockItem(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: reconciled } = await this.reconcile(workspaceId, item, state);
      const planArtifact = this.scenePlanArtifact(reconciled);
      if (!planArtifact) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCENE_PLAN_REQUIRED, message: "A generated scene plan is required first." });
      if (!planArtifact.scenes.some((s) => s.sceneId === sceneId)) {
        throw new NotFoundException({ code: VIDEO_ERRORS.VIDEO_SCENE_NOT_FOUND, message: `Scene "${sceneId}" is not in the current scene plan.` });
      }
      const asset = await tx.mediaAsset.findFirst({
        where: { publicId: mediaAssetPublicId, deletedAt: null },
        select: { publicId: true, assetGroupId: true, assetType: true, status: true, workspaceId: true, contentItemId: true, projectId: true },
      });
      if (!asset || asset.workspaceId !== workspaceId) {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_MEDIA_ASSET_NOT_ELIGIBLE, message: "Media asset not found in this workspace." });
      }
      if (asset.status !== LIVE_ASSET_STATUS) {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_MEDIA_ASSET_NOT_ELIGIBLE, message: `Media asset is "${asset.status}", not ACTIVE.` });
      }
      if (asset.assetType !== "IMAGE" && asset.assetType !== "VIDEO") {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_MEDIA_ASSET_NOT_ELIGIBLE, message: `Scene assets must be IMAGE or VIDEO — got "${asset.assetType}".` });
      }
      // uploaded (belongs to this item) vs brand (workspace-level, not tied to an item).
      const source: "uploaded" | "brand" = asset.contentItemId === item.id ? "uploaded" : "brand";
      const target = reconciled.assets.scenes.find((s) => s.sceneId === sceneId);
      if (target) {
        target.mediaAssetGroupId = asset.assetGroupId;
        target.mediaAssetPublicId = asset.publicId;
        target.source = source;
        target.mediaJobPublicId = null;
        target.failureReason = null;
      }
      const { state: rereconciled } = await this.reconcile(workspaceId, item, reconciled);
      await this.persist(tx, item, rereconciled, actor, ctx, { [`videoPipeline.assets.${sceneId}.source`]: source });
    });
  }

  // ------------------------------------------------------------------
  // Voice stage + Gate #3
  // ------------------------------------------------------------------

  async generateVoice(workspaceId: string, actor: VideoMediaActor, itemPublicId: string, voiceProfileId: string, style: string | undefined, ctx: RequestContext): Promise<void> {
    const profile = this.voiceCatalog.resolve(voiceProfileId);
    if (!profile) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_VOICE_PROFILE_UNKNOWN, message: `Voice profile "${voiceProfileId}" is not in the catalog.` });

    const { text, hash } = await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lockItem(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: reconciled } = await this.reconcile(workspaceId, item, state);
      if (reconciled.script.status !== "APPROVED") {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_APPROVED, message: "The script must be approved (Quality Gate #1) before voice generation." });
      }
      if (reconciled.voice.mediaJobPublicId) {
        throw new ConflictException({ code: VIDEO_ERRORS.VIDEO_MEDIA_STAGE_ALREADY_RUNNING, message: "Voice generation is already in progress." });
      }
      const script = this.scriptArtifact(reconciled);
      const narration = narrationText(script);
      if (!narration) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_READY, message: "The approved script has no narration text." });
      const currentHash = scriptVersionHash(script);
      reconciled.voice = {
        ...reconciled.voice,
        status: "RUNNING",
        voiceProfileId,
        mediaJobPublicId: "pending",
        failureReason: null,
        audioAssetPublicId: null,
        wordTimingObjectKey: null,
        scriptVersionHash: null,
        audioDurationMs: null,
      };
      // Regenerating voice invalidates existing subtitles.
      if (reconciled.subtitles.status !== "PENDING") {
        reconciled.subtitles = { status: "PENDING", srtAssetPublicId: null, vttAssetPublicId: null, sourceAudioAssetPublicId: null, cueCount: null, mediaJobPublicId: null, failureReason: "voice regenerating" };
      }
      await this.persist(tx, item, reconciled, actor, ctx, { "videoPipeline.voice.status": "RUNNING" });
      return { text: narration, hash: currentHash };
    });

    await this.submitAndLink(workspaceId, actor, itemPublicId, ctx, {
      operation: "TTS",
      fingerprintParts: ["voice", voiceProfileId, profile.language, hash],
      inputPayload: {
        text,
        voiceProfileId,
        providerVoiceId: profile.providerVoiceId,
        language: profile.language,
        style: style ?? "neutral",
        outputFormat: "mp3",
        scriptVersionHash: hash,
      },
      onLink: (state, jobPublicId) => {
        state.voice.mediaJobPublicId = jobPublicId;
      },
      onFail: (state, reason) => {
        state.voice.mediaJobPublicId = null;
        state.voice.status = "FAILED";
        state.voice.failureReason = reason;
      },
    });
  }

  // ------------------------------------------------------------------
  // Subtitle stage — deterministic
  // ------------------------------------------------------------------

  async generateSubtitles(workspaceId: string, actor: VideoMediaActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    const { audioPublicId } = await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lockItem(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: reconciled } = await this.reconcile(workspaceId, item, state);
      if (reconciled.voice.status !== "READY" || !reconciled.voice.audioAssetPublicId) {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_VOICE_ARTIFACT_REQUIRED, message: "A valid current voice artifact (Gate #3) is required before subtitle generation." });
      }
      if (reconciled.subtitles.mediaJobPublicId) {
        throw new ConflictException({ code: VIDEO_ERRORS.VIDEO_MEDIA_STAGE_ALREADY_RUNNING, message: "Subtitle generation is already in progress." });
      }
      reconciled.subtitles = {
        ...reconciled.subtitles,
        status: "RUNNING",
        mediaJobPublicId: "pending",
        failureReason: null,
        srtAssetPublicId: null,
        vttAssetPublicId: null,
      };
      await this.persist(tx, item, reconciled, actor, ctx, { "videoPipeline.subtitles.status": "RUNNING" });
      return { audioPublicId: reconciled.voice.audioAssetPublicId };
    });

    const scriptText = narrationText(this.scriptArtifact((await this.loadStateOnly(workspaceId, itemPublicId))!));

    await this.submitAndLink(workspaceId, actor, itemPublicId, ctx, {
      operation: "SUBTITLE_GENERATE",
      fingerprintParts: ["subtitle", audioPublicId],
      inputPayload: {
        audioAssetPublicId: audioPublicId,
        scriptText,
      },
      onLink: (state, jobPublicId) => {
        state.subtitles.mediaJobPublicId = jobPublicId;
      },
      onFail: (state, reason) => {
        state.subtitles.mediaJobPublicId = null;
        state.subtitles.status = "FAILED";
        state.subtitles.failureReason = reason;
      },
    });
  }

  // ------------------------------------------------------------------
  // Thumbnail concept selection + real image generation
  // ------------------------------------------------------------------

  async selectThumbnailConcept(workspaceId: string, actor: VideoMediaActor, itemPublicId: string, conceptIndex: number, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lockItem(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: reconciled } = await this.reconcile(workspaceId, item, state);
      const concepts = reconciled.thumbnailConcepts.artifact?.concepts ?? [];
      if (reconciled.thumbnailConcepts.status !== "READY" || concepts.length === 0) {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_THUMBNAIL_CONCEPTS_REQUIRED, message: "Generate thumbnail concepts before selecting one." });
      }
      if (!Number.isInteger(conceptIndex) || conceptIndex < 0 || conceptIndex >= concepts.length) {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_THUMBNAIL_CONCEPT_INDEX_INVALID, message: `conceptIndex must be between 0 and ${concepts.length - 1}.` });
      }
      const changed = reconciled.thumbnailImage.selectedConceptIndex !== conceptIndex;
      reconciled.thumbnailImage = {
        status: "PENDING",
        selectedConceptIndex: conceptIndex,
        imageAssetPublicId: changed ? null : reconciled.thumbnailImage.imageAssetPublicId,
        imageAssetGroupId: changed ? null : reconciled.thumbnailImage.imageAssetGroupId,
        imageWidth: changed ? null : reconciled.thumbnailImage.imageWidth,
        imageHeight: changed ? null : reconciled.thumbnailImage.imageHeight,
        mediaJobPublicId: null,
        failureReason: null,
      };
      await this.persist(tx, item, reconciled, actor, ctx, { "videoPipeline.thumbnailImage.selectedConceptIndex": conceptIndex });
    });
  }

  async generateThumbnailImage(workspaceId: string, actor: VideoMediaActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    const { prompt, aspect, conceptIndex, existingGroup } = await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lockItem(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: reconciled } = await this.reconcile(workspaceId, item, state);
      const concepts = reconciled.thumbnailConcepts.artifact?.concepts ?? [];
      const idx = reconciled.thumbnailImage.selectedConceptIndex;
      if (idx === null || idx < 0 || idx >= concepts.length) {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_THUMBNAIL_CONCEPT_NOT_SELECTED, message: "Select a thumbnail concept before generating an image." });
      }
      if (reconciled.thumbnailImage.mediaJobPublicId) {
        throw new ConflictException({ code: VIDEO_ERRORS.VIDEO_MEDIA_STAGE_ALREADY_RUNNING, message: "Thumbnail image generation is already in progress." });
      }
      const concept = concepts[idx];
      const script = await tx.videoScript.findFirst({ where: { workspaceId, contentItemId: item.id, deletedAt: null }, select: { targetPlatform: true, metaTitle: true } });
      const platform = script?.targetPlatform ?? "YOUTUBE_LONG";
      const composed = [
        `Thumbnail concept: ${concept.title}`,
        `Visual direction: ${concept.visualDirection}`,
        `Composition: ${concept.composition}`,
        concept.overlayText ? `Overlay text (render legibly): "${concept.overlayText}"` : "",
        script?.metaTitle ? `Video title context: ${script.metaTitle}` : `Video: ${item.title}`,
        `Target platform: ${platform}`,
      ]
        .filter(Boolean)
        .join("\n");
      const existingGroup = reconciled.thumbnailImage.imageAssetGroupId;
      reconciled.thumbnailImage = { ...reconciled.thumbnailImage, status: "RUNNING", mediaJobPublicId: "pending", failureReason: null };
      await this.persist(tx, item, reconciled, actor, ctx, { "videoPipeline.thumbnailImage.status": "RUNNING" });
      return { prompt: composed, aspect: this.thumbnailAspectFor(platform), conceptIndex: idx, existingGroup };
    });

    await this.submitAndLink(workspaceId, actor, itemPublicId, ctx, {
      operation: "IMAGE_GENERATE",
      fingerprintParts: ["thumbnail", conceptIndex, prompt.slice(0, 64)],
      inputPayload: { purpose: "thumbnail", prompt, aspectRatio: aspect, assetType: "IMAGE", existingAssetGroupId: existingGroup },
      onLink: (state, jobPublicId) => {
        state.thumbnailImage.mediaJobPublicId = jobPublicId;
      },
      onFail: (state, reason) => {
        state.thumbnailImage.mediaJobPublicId = null;
        state.thumbnailImage.status = "FAILED";
        state.thumbnailImage.failureReason = reason;
      },
    });
  }

  // ------------------------------------------------------------------
  // Shared two-phase submit
  // ------------------------------------------------------------------

  private async loadStateOnly(workspaceId: string, itemPublicId: string): Promise<VideoPipelineState | null> {
    const item = await this.prisma.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { metadata: true } });
    return item ? readPipelineState(item.metadata) : null;
  }

  private async submitAndLink(
    workspaceId: string,
    actor: VideoMediaActor,
    itemPublicId: string,
    ctx: RequestContext,
    opts: {
      operation: "IMAGE_GENERATE" | "TTS" | "SUBTITLE_GENERATE";
      fingerprintParts: Array<string | number | null | undefined>;
      inputPayload: Record<string, unknown>;
      onLink: (state: VideoPipelineState, jobPublicId: string) => void;
      onFail: (state: VideoPipelineState, reason: string) => void;
    },
  ): Promise<void> {
    const itemRow = await this.prisma.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { id: true } });
    if (!itemRow) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });

    let jobPublicId: string | null = null;
    let submitError: string | null = null;
    try {
      const { job } = await this.mediaJobs.submit({
        workspaceId,
        contentItemInternalId: itemRow.id,
        operation: opts.operation,
        inputPayload: opts.inputPayload,
        fingerprint: MediaJobSubmissionService.fingerprint(opts.operation, opts.fingerprintParts),
        correlationId: ctx.correlationId,
        actorUserInternalId: actor.userInternalId,
      });
      jobPublicId = job.publicId;
    } catch (err) {
      submitError = err instanceof Error ? err.message : "media job submission failed";
    }

    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lockItem(tx, workspaceId, itemPublicId);
      if (jobPublicId) opts.onLink(state, jobPublicId);
      else opts.onFail(state, submitError ?? "media job submission failed");
      await this.persist(tx, item, state, actor, ctx, { [`videoPipeline.${opts.operation}.jobPublicId`]: jobPublicId });
    });

    if (submitError) {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_STAGE_AI_OUTPUT_INVALID, message: `Could not start ${opts.operation}: ${submitError}` });
    }
  }
}
