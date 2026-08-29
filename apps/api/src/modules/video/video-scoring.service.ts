import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContentDimensionRegistryError,
  ContentScoringEngine,
  deserializeScoreResult,
  serializeScoreResult,
  type ContentDimensionRegistry,
  type ScoreResult,
  type ScoreResultJSON,
} from "@myev/shared";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppConfig } from "../../config/configuration";
import { CONTENT_DIMENSION_REGISTRY } from "../content-scoring/content-dimension-registry.module";
import { evaluateThreshold, type ThresholdOutcome } from "../content-scoring/scoring-threshold";
import { VIDEO_ERRORS } from "./video.errors";
import { readPipelineState } from "./video-pipeline-state";
import { VideoScoringInputBuilder, toVideoScoreItemContext, type KnowledgePackContextForScoring } from "./video-scoring-input-builder";

export interface VideoScoringActor {
  internalId: string;
}

/** `content_scores.factors` for a Video score row: the video dimension's
 * full ScoreResultJSON (unchanged shape — `deserializeScoreResult` alone
 * still round-trips it) PLUS one additive `thumbnail` key, null when no
 * Thumbnail Concept existed at scoring time. Never invented — see
 * `VideoScoringInputBuilder.buildThumbnailInput`'s own doc comment. */
interface VideoScoreFactorsJSON extends ScoreResultJSON {
  readonly thumbnail: ScoreResultJSON | null;
}

export interface VideoScoreRunResult {
  contentItemPublicId: string;
  videoResult: ScoreResult;
  thumbnailResult: ScoreResult | null;
  threshold: ThresholdOutcome;
  contentScorePublicId: string;
  calculatedAt: Date;
}

/**
 * Module 7 Phase 7.3 — the Video-specific analog of Module 6's
 * `ContentScoringService`, reusing the SAME frozen `ContentScoringEngine`
 * class, the SAME `CONTENT_DIMENSION_REGISTRY`, the SAME `content_scores`
 * (`ContentScore`) append-only table, and the SAME config-driven
 * threshold helper — "Module 7 extends the dimension registry only";
 * `ContentScoringService`/`ContentScoringController`/`ScoringInputBuilder`
 * are not imported, injected, or modified anywhere in this file.
 *
 * The ONLY genuinely new thing is the INPUT — `VideoScoringInputBuilder`
 * reads Video's own persisted-and-validated pipeline artifacts
 * (video_scripts + metadata.videoPipeline), never `content_versions.body`
 * (which stays a Phase 7.1 placeholder for a video pipeline item and
 * would silently score the wrong data if reused).
 *
 * Runs the engine up to TWICE per score request:
 *  1. VIDEO_DIMENSION_V1, resolved via `resolveForContentType("VIDEO")` —
 *     THE Overall Score + the five category scores + the Video Score.
 *  2. THUMBNAIL_DIMENSION_V1, resolved by explicit name only
 *     (`resolve("thumbnail", 1)`) — ONLY when a Thumbnail Concept
 *     artifact exists. Its own `overallScore`/`categoryScores` are
 *     computed (the engine always produces them) but deliberately
 *     DISCARDED here — only `dimension` (the Thumbnail Score) +
 *     `factors`/`recommendations` are kept. There is exactly one
 *     Overall Score per video: the first run's.
 */
@Injectable()
export class VideoScoringService {
  private readonly engine = new ContentScoringEngine();

  constructor(
    private readonly prisma: PrismaService,
    private readonly inputBuilder: VideoScoringInputBuilder,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(CONTENT_DIMENSION_REGISTRY) private readonly dimensions: ContentDimensionRegistry,
  ) {}

  async score(workspaceId: string, itemPublicId: string, actor: VideoScoringActor): Promise<VideoScoreRunResult> {
    const item = await this.loadItem(workspaceId, itemPublicId);
    const state = readPipelineState(item.metadata);
    if (!state) {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    }

    const kpContext = await this.loadKnowledgePackContext(workspaceId);

    let videoDimension;
    try {
      videoDimension = this.dimensions.resolveForContentType("VIDEO");
    } catch (err) {
      if (err instanceof ContentDimensionRegistryError) {
        throw new UnprocessableEntityException({ code: "SEO_CONTENT_TYPE_NOT_SCOREABLE", message: 'No scoring dimension is registered for content type "VIDEO".' });
      }
      throw err;
    }

    // A pipeline item's video_scripts row is created atomically with the
    // metadata.videoPipeline bag at Phase 7.1 create time — `state` being
    // non-null already implies `item.videoScript` exists; the fallback
    // below only guards a theoretical inconsistency, never fabricates SEO
    // evidence (every field stays null/empty).
    // Only ever run — and only ever score — when a Thumbnail Concept
    // artifact genuinely exists. Absent means no Thumbnail Score, never
    // a fabricated zero. Computed FIRST (Phase 7.4) so its score can feed
    // the Video dimension's "thumbnail quality" measure when a real image
    // exists.
    const thumb = state.thumbnailImage;
    const realImageReady = thumb.status === "READY" && !!thumb.imageAssetPublicId;
    const thumbnailInput = this.inputBuilder.buildThumbnailInput(state.thumbnailConcepts.artifact, kpContext, realImageReady ? { present: true, width: thumb.imageWidth ?? 0, height: thumb.imageHeight ?? 0, aspectRatioOk: this.aspectRatioOk(item.videoScript?.targetPlatform ?? "YOUTUBE_LONG", thumb.imageWidth, thumb.imageHeight) } : undefined);
    const thumbnailResult = thumbnailInput ? this.engine.score(thumbnailInput, this.dimensions.resolve("thumbnail", 1)) : null;

    const videoInput = this.inputBuilder.buildVideoInput(
      toVideoScoreItemContext(item.title, item.videoScript ?? this.emptyScript(), state),
      kpContext,
      // Only feed the Video dimension a Thumbnail Score when a REAL,
      // fresh thumbnail image exists — never for a text concept alone
      // (that keeps Phase 7.1–7.3 video scores unchanged).
      realImageReady && thumbnailResult
        ? {
            currentThumbnailScore: thumbnailResult.dimension.score,
            imageEvidence: { present: true, width: thumb.imageWidth ?? 0, height: thumb.imageHeight ?? 0, aspectRatioOk: this.aspectRatioOk(item.videoScript?.targetPlatform ?? "YOUTUBE_LONG", thumb.imageWidth, thumb.imageHeight) },
          }
        : undefined,
    );
    const videoResult = this.engine.score(videoInput, videoDimension);

    const threshold = evaluateThreshold(videoResult.overallScore, this.passThreshold());

    const factors: VideoScoreFactorsJSON = { ...serializeScoreResult(videoResult), thumbnail: thumbnailResult ? serializeScoreResult(thumbnailResult) : null };
    const contentScore = await this.prisma.contentScore.create({
      data: {
        workspaceId,
        contentItemId: item.id,
        score: videoResult.overallScore,
        factors: factors as unknown as object,
        createdById: actor.internalId,
      },
    });

    return {
      contentItemPublicId: itemPublicId,
      videoResult,
      thumbnailResult,
      threshold,
      contentScorePublicId: contentScore.publicId,
      calculatedAt: contentScore.calculatedAt,
    };
  }

  async getLatest(workspaceId: string, itemPublicId: string): Promise<VideoScoreRunResult | null> {
    const item = await this.loadItem(workspaceId, itemPublicId);
    if (!readPipelineState(item.metadata)) {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    }

    const latest = await this.prisma.contentScore.findFirst({ where: { workspaceId, contentItemId: item.id }, orderBy: { calculatedAt: "desc" } });
    if (!latest) return null;

    const factors = latest.factors as unknown as VideoScoreFactorsJSON;
    const videoResult = deserializeScoreResult(factors);
    const thumbnailResult = factors.thumbnail ? deserializeScoreResult(factors.thumbnail) : null;

    return {
      contentItemPublicId: itemPublicId,
      videoResult,
      thumbnailResult,
      threshold: evaluateThreshold(videoResult.overallScore, this.passThreshold()),
      contentScorePublicId: latest.publicId,
      calculatedAt: latest.calculatedAt,
    };
  }

  private passThreshold(): number {
    return this.config.get("contentScoring", { infer: true }).passThreshold;
  }

  /** True when the image's aspect ratio matches the target platform's expected ratio (±8%). */
  private aspectRatioOk(targetPlatform: string, width: number | null, height: number | null): boolean {
    if (!width || !height) return false;
    const actual = width / height;
    const expected = /SHORT|REEL/i.test(targetPlatform) ? 9 / 16 : /SQUARE/i.test(targetPlatform) ? 1 : 16 / 9;
    return Math.abs(actual - expected) / expected <= 0.08;
  }

  private emptyScript(): { targetPlatform: string; metaTitle: null; metaDescription: null; tags: null; chapters: null; schemaMarkup: null } {
    return { targetPlatform: "YOUTUBE_LONG", metaTitle: null, metaDescription: null, tags: null, chapters: null, schemaMarkup: null };
  }

  private async loadItem(workspaceId: string, itemPublicId: string) {
    const item = await this.prisma.contentItem.findFirst({
      where: { publicId: itemPublicId, workspaceId, deletedAt: null },
      select: { id: true, publicId: true, contentType: true, title: true, metadata: true },
    });
    if (!item || item.contentType !== "VIDEO") {
      throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    }
    const videoScript = await this.prisma.videoScript.findFirst({
      where: { workspaceId, contentItemId: item.id, deletedAt: null },
      select: { targetPlatform: true, metaTitle: true, metaDescription: true, tags: true, chapters: true, schemaMarkup: true },
    });
    return { ...item, videoScript };
  }

  private async loadKnowledgePackContext(workspaceId: string): Promise<KnowledgePackContextForScoring> {
    const pack = await this.prisma.knowledgePack.findFirst({
      where: { workspaceId, status: "ACTIVE", deletedAt: null },
      select: { keywordSets: { select: { keywords: true } }, brandGuidelines: { select: { terminology: true } } },
    });
    if (!pack) return { active: false, keywords: [], brandTerms: [] };

    const keywords = new Set<string>();
    for (const set of pack.keywordSets) {
      const raw = set.keywords;
      if (Array.isArray(raw)) for (const k of raw) if (typeof k === "string" && k.trim()) keywords.add(k.trim());
    }
    const brandTerms = new Set<string>();
    for (const bg of pack.brandGuidelines) {
      const term = bg.terminology;
      if (term && typeof term === "object" && !Array.isArray(term)) {
        for (const [k, v] of Object.entries(term as Record<string, unknown>)) {
          if (typeof k === "string" && k.trim()) brandTerms.add(k.trim());
          if (typeof v === "string" && v.trim()) brandTerms.add(v.trim());
        }
      }
    }
    return { active: true, keywords: [...keywords], brandTerms: [...brandTerms] };
  }
}
