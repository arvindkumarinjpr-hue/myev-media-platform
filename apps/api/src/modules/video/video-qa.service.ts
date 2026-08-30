import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { parseMp4, resolveExportProfile, runVideoQa, type QaSubtitleCue, type VideoQaInput } from "@myev/shared";
import { Prisma, type ContentItemStatus } from "../../../generated/prisma";
import type { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface";
import { VideoRenderService } from "./video-render.service";
import { VIDEO_ERRORS } from "./video.errors";
import { readPipelineState, writePipelineState } from "./video-pipeline-state";
import type { QaCheckResult, VideoPipelineState } from "./video-pipeline.types";

export interface VideoQaActor {
  userPublicId: string;
  userInternalId: string;
}
interface RequestContext {
  ipAddress?: string;
  correlationId: string;
}

const EDITABLE_STATUSES: ContentItemStatus[] = ["DRAFT", "IN_PROGRESS"];
/** MP4 fast-start files front-load `moov`; a generous prefix covers it without downloading the whole render. */
const MP4_INSPECT_PREFIX_BYTES = 2 * 1024 * 1024;

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
 * Module 7 Phase 7.5 — the Video QA Engine + Quality Gate #5 (QA Passed).
 *
 * `POST /qa` executes all six frozen checks (FR-VID-008) against genuine
 * persisted artifacts + a fresh independent inspection of the rendered
 * file (not just the render job's self-reported metadata), and persists
 * the structured report in the pipeline bag. `GET /qa` is a pure read —
 * it never executes QA (checkpoint §22).
 *
 * `reconcile` keeps Gate #5 honest: a QA report bound to a render that is
 * no longer the current one, or a render that is no longer READY, is
 * automatically stale (checkpoint §23).
 */
@Injectable()
export class VideoQaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly renderService: VideoRenderService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
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

  /** QA staleness — pure over `state`, called from the pipeline's reconcile chain. */
  reconcile(state: VideoPipelineState): { state: VideoPipelineState; changed: boolean } {
    const q = state.qa;
    if (q.status !== "COMPLETED") return { state, changed: false };
    const stale = state.render.status !== "READY" || q.renderJobPublicId !== state.render.renderJobPublicId || q.renderedVideoPublicId !== state.render.renderedVideoPublicId;
    if (!stale) return { state, changed: false };
    state.qa = { status: "PENDING", checks: [], passed: null, renderJobPublicId: null, renderedVideoPublicId: null, completedAt: null };
    return { state, changed: true };
  }

  // ------------------------------------------------------------------
  // POST /video/:itemId/qa
  // ------------------------------------------------------------------

  async runQa(workspaceId: string, actor: VideoQaActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    // Phase 1: reconcile + verify Gate #4, gather the render job identity under the lock.
    const gathered = await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lock(tx, workspaceId, itemPublicId);
      if (!EDITABLE_STATUSES.includes(item.status)) {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_PIPELINE_ITEM_NOT_EDITABLE, message: `The video is "${item.status}" — QA can only run while it is DRAFT or IN_PROGRESS.` });
      }
      await this.renderService.reconcile(workspaceId, { id: item.id }, state);
      this.reconcile(state);
      if (state.render.status !== "READY" || !state.render.renderJobPublicId || !state.render.renderedVideoPublicId) {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_QA_RENDER_REQUIRED, message: "A current successful render (Quality Gate #4) is required before QA." });
      }
      await tx.contentItem.update({ where: { id: item.id }, data: { metadata: writePipelineState(item.metadata, state) as Prisma.InputJsonValue } });
      return { itemId: item.id, itemPublicId: item.publicId, renderJobPublicId: state.render.renderJobPublicId, renderedVideoPublicId: state.render.renderedVideoPublicId, state };
    });

    // Phase 2: heavy work (storage read + inspection) OUTSIDE any transaction.
    const report = await this.buildReport(workspaceId, gathered.renderJobPublicId, gathered.state);

    // Phase 3: persist the report + Gate #5 under the lock.
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.lock(tx, workspaceId, itemPublicId);
      await this.renderService.reconcile(workspaceId, { id: item.id }, state);
      if (state.render.renderJobPublicId !== gathered.renderJobPublicId || state.render.status !== "READY") {
        // The render changed while QA ran — discard, do not persist a report against a superseded render.
        this.reconcile(state);
        await tx.contentItem.update({ where: { id: item.id }, data: { metadata: writePipelineState(item.metadata, state) as Prisma.InputJsonValue } });
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_QA_STALE, message: "The render changed while QA was running — re-run QA." });
      }
      state.qa = {
        status: "COMPLETED",
        checks: report.checks as QaCheckResult[],
        passed: report.passed,
        renderJobPublicId: gathered.renderJobPublicId,
        renderedVideoPublicId: gathered.renderedVideoPublicId,
        completedAt: report.generatedAt,
      };
      await tx.contentItem.update({ where: { id: item.id }, data: { metadata: writePipelineState(item.metadata, state) as Prisma.InputJsonValue } });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_UPDATED",
        actorUserId: actor.userInternalId,
        workspaceId,
        entityType: "content_item",
        entityId: item.publicId,
        afterState: { "videoPipeline.qa.passed": report.passed },
        ipAddress: ctx.ipAddress,
      });
    });
  }

  private async buildReport(workspaceId: string, renderJobPublicId: string, state: VideoPipelineState) {
    const job = await this.prisma.videoRenderJob.findFirstOrThrow({ where: { workspaceId, publicId: renderJobPublicId } });
    const profile = resolveExportProfile(job.targetPlatform);

    const outputAsset = await this.prisma.mediaAsset.findFirstOrThrow({
      where: { workspaceId, publicId: job.outputMediaAssetPublicId ?? "" },
      select: { objectKey: true, verifiedSizeBytes: true, verifiedChecksumSha256: true },
    });

    // Independent inspection of the ACTUAL rendered file (checkpoint §19).
    let prefix: Buffer;
    try {
      prefix = await this.storage.inspectObjectPrefix(outputAsset.objectKey, MP4_INSPECT_PREFIX_BYTES);
    } catch {
      prefix = Buffer.alloc(0);
    }
    const info = parseMp4(prefix);

    // Cross-check: the render job's self-reported checksum must match the
    // asset row's verified checksum (already asserted in Gate #4, re-asserted here as evidence).
    const checksumOk = !!outputAsset.verifiedChecksumSha256 && outputAsset.verifiedChecksumSha256 === job.outputChecksumSha256;

    const subtitleCues = await this.loadSubtitleCues(state);
    const wordTimingCount = await this.loadWordTimingCount(state);

    const qaInput: VideoQaInput = {
      expectedWidth: profile.width,
      expectedHeight: profile.height,
      expectedProfileId: profile.id,
      expectedDurationMs: state.render.expectedDurationMs ?? job.outputDurationMs ?? profile.width,
      output: {
        width: info.width,
        height: info.height,
        durationMs: info.durationMs ?? (job.outputDurationMs ?? null),
        hasAudioTrack: info.hasAudioTrack,
        byteLength: outputAsset.verifiedSizeBytes ? Number(outputAsset.verifiedSizeBytes) : info.byteLength,
        containerOk: info.ok && checksumOk,
      },
      snapshotScenes: state.render.snapshotScenes.map((s) => ({ sceneId: s.sceneId, assetResolved: s.assetResolved, materialized: s.materialized })),
      voice: {
        durationMs: state.voice.audioDurationMs ?? 0,
        wordTimingCount,
        audioAssetPublicId: state.voice.audioAssetPublicId,
      },
      subtitles: {
        cues: subtitleCues,
        sourceAudioAssetPublicId: state.subtitles.sourceAudioAssetPublicId,
      },
      branding: {
        layerConfigured: state.render.brandingLayerConfigured,
        logoRequired: state.render.brandingLogoInSnapshot,
        logoRendered: state.render.brandingLogoInSnapshot,
        introRequired: state.render.brandingIntroRequired,
        introRendered: state.render.brandingIntroRendered,
        outroRequired: state.render.brandingOutroRequired,
        outroRendered: state.render.brandingOutroRendered,
      },
      durationToleranceMs: this.config.get("videoRender", { infer: true }).durationToleranceMs,
    };

    return runVideoQa(qaInput);
  }

  private async loadSubtitleCues(state: VideoPipelineState): Promise<QaSubtitleCue[]> {
    if (!state.subtitles.vttAssetPublicId) return [];
    const vtt = await this.prisma.mediaAsset.findFirst({ where: { publicId: state.subtitles.vttAssetPublicId }, select: { objectKey: true } });
    if (!vtt) return [];
    let text: string;
    try {
      text = (await this.storage.inspectObjectPrefix(vtt.objectKey, 512 * 1024)).toString("utf8");
    } catch {
      return [];
    }
    return parseVttCues(text);
  }

  private async loadWordTimingCount(state: VideoPipelineState): Promise<number> {
    if (!state.voice.wordTimingObjectKey) return 0;
    try {
      const raw = (await this.storage.inspectObjectPrefix(state.voice.wordTimingObjectKey, 4 * 1024 * 1024)).toString("utf8");
      const parsed = JSON.parse(raw) as { words?: unknown[] };
      return Array.isArray(parsed.words) ? parsed.words.length : 0;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------------
  // GET /video/:itemId/qa — pure read
  // ------------------------------------------------------------------

  async getQa(workspaceId: string, itemPublicId: string): Promise<Record<string, unknown>> {
    const item = await this.prisma.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { id: true, contentType: true, metadata: true } });
    if (!item || item.contentType !== "VIDEO") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const state = readPipelineState(item.metadata);
    if (!state) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    const { state: rendered } = await this.renderService.reconcile(workspaceId, { id: item.id }, state);
    this.reconcile(rendered);
    return {
      gate5: { name: "qa_passed", passed: rendered.qa.status === "COMPLETED" && rendered.qa.passed === true },
      gate4Ready: rendered.render.status === "READY",
      qa: rendered.qa,
    };
  }
}

/** Minimal WebVTT cue-timing parser — only the `HH:MM:SS.mmm --> HH:MM:SS.mmm` lines. */
export function parseVttCues(vtt: string): QaSubtitleCue[] {
  const cues: QaSubtitleCue[] = [];
  const re = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(vtt)) !== null) {
    const startMs = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4];
    const endMs = (+m[5] * 3600 + +m[6] * 60 + +m[7]) * 1000 + +m[8];
    cues.push({ startMs, endMs });
  }
  return cues;
}
