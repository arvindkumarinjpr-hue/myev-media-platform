import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContentDimensionRegistryError,
  ContentScoringEngine,
  deserializeScoreResult,
  serializeScoreResult,
  serializeSeoBreakdown,
  type ContentDimensionRegistry,
  type ScoreResult,
  type ScoreResultJSON,
} from "@myev/shared";
import type { ContentScore, SeoReport } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppConfig } from "../../config/configuration";
import { CONTENT_DIMENSION_REGISTRY } from "./content-dimension-registry.module";
import { ScoringInputBuilder, type KnowledgePackContextForScoring } from "./scoring-input-builder";
import { evaluateThreshold, type ThresholdOutcome } from "./scoring-threshold";

export interface ScoringActor {
  /** internal users.id — for the created_by FK. */
  internalId: string;
}

export interface ScoreRunResult {
  contentItemPublicId: string;
  result: ScoreResult;
  threshold: ThresholdOutcome;
  contentScorePublicId: string;
  seoReportPublicId: string;
  calculatedAt: Date;
}

export interface LatestScoreResult {
  contentItemPublicId: string;
  result: ScoreResult;
  threshold: ThresholdOutcome;
  contentScorePublicId: string;
  seoReportPublicId: string | null;
  calculatedAt: Date;
}

/**
 * Module 6 Phase 6.1 — the generic, content-type-agnostic API surface
 * over the shared Content Scoring Engine.
 *
 * Every read is workspace-scoped structurally (a `workspaceId` predicate
 * on every query, never left to the caller). The content-type-specific
 * scoring logic lives entirely in the resolved `ContentDimension`; this
 * service resolves it from the injected registry by the item's
 * `contentType` and never branches on the type itself.
 *
 * Phase 6.1 is fully DETERMINISTIC — no AI provider call. A Knowledge
 * Pack is OPTIONAL context (keywords + brand terms sharpen the score);
 * its absence lowers keyword/brand factors with an explanatory reason,
 * never an error. The ADR-004 "active KP required" gate belongs at the
 * Blog-pipeline level a later phase adds, not on a raw score request.
 */
@Injectable()
export class ContentScoringService {
  private readonly engine = new ContentScoringEngine();

  constructor(
    private readonly prisma: PrismaService,
    private readonly inputBuilder: ScoringInputBuilder,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(CONTENT_DIMENSION_REGISTRY) private readonly dimensions: ContentDimensionRegistry,
  ) {}

  async score(workspaceId: string, contentItemPublicId: string, actor: ScoringActor): Promise<ScoreRunResult> {
    const item = await this.loadContentItem(workspaceId, contentItemPublicId);

    let dimension;
    try {
      dimension = this.dimensions.resolveForContentType(item.contentType);
    } catch (err) {
      if (err instanceof ContentDimensionRegistryError) {
        throw new UnprocessableEntityException({
          code: "SEO_CONTENT_TYPE_NOT_SCOREABLE",
          message: `No scoring dimension is registered for content type "${item.contentType}".`,
        });
      }
      throw err;
    }

    const kpContext = await this.loadKnowledgePackContext(workspaceId);
    const scoringInput = this.inputBuilder.build(
      { contentType: item.contentType, title: item.title, currentVersionBody: item.currentVersion?.body ?? {} },
      kpContext,
    );

    const result = this.engine.score(scoringInput, dimension);
    const threshold = evaluateThreshold(result.overallScore, this.passThreshold());

    const { contentScore, seoReport } = await this.prisma.$transaction(async (tx) => {
      const cs = await tx.contentScore.create({
        data: {
          workspaceId,
          contentItemId: item.id,
          score: result.overallScore,
          factors: serializeScoreResult(result) as unknown as object,
          createdById: actor.internalId,
        },
      });
      const sr = await tx.seoReport.create({
        data: {
          workspaceId,
          contentItemId: item.id,
          seoScore: result.categoryScores.SEO,
          breakdown: serializeSeoBreakdown(result) as unknown as object,
          createdById: actor.internalId,
          calculatedAt: cs.calculatedAt,
        },
      });
      return { contentScore: cs, seoReport: sr };
    });

    return {
      contentItemPublicId,
      result,
      threshold,
      contentScorePublicId: contentScore.publicId,
      seoReportPublicId: seoReport.publicId,
      calculatedAt: contentScore.calculatedAt,
    };
  }

  async getLatest(workspaceId: string, contentItemPublicId: string): Promise<LatestScoreResult | null> {
    const item = await this.loadContentItem(workspaceId, contentItemPublicId);

    const latest: ContentScore | null = await this.prisma.contentScore.findFirst({
      where: { workspaceId, contentItemId: item.id },
      orderBy: { calculatedAt: "desc" },
    });
    if (!latest) return null;

    const seo: SeoReport | null = await this.prisma.seoReport.findFirst({
      where: { workspaceId, contentItemId: item.id, calculatedAt: latest.calculatedAt },
      orderBy: { calculatedAt: "desc" },
    });

    const result = this.deserialize(latest.factors);
    return {
      contentItemPublicId,
      result,
      threshold: evaluateThreshold(result.overallScore, this.passThreshold()),
      contentScorePublicId: latest.publicId,
      seoReportPublicId: seo?.publicId ?? null,
      calculatedAt: latest.calculatedAt,
    };
  }

  private passThreshold(): number {
    return this.config.get("contentScoring", { infer: true }).passThreshold;
  }

  private deserialize(factors: unknown): ScoreResult {
    // Persisted rows are written by serializeScoreResult; round-tripping
    // through the shared deserializer keeps a single source of truth for
    // the JSON shape.
    return deserializeScoreResult(factors as ScoreResultJSON);
  }

  private async loadContentItem(workspaceId: string, contentItemPublicId: string) {
    // Enumeration-safe: identical NotFound for "no such item" and "exists
    // in another workspace" — the codebase-wide convention.
    const item = await this.prisma.contentItem.findFirst({
      where: { publicId: contentItemPublicId, workspaceId, deletedAt: null },
      select: {
        id: true,
        publicId: true,
        contentType: true,
        title: true,
        currentVersion: { select: { body: true } },
      },
    });
    if (!item) {
      throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    }
    return item;
  }

  private async loadKnowledgePackContext(workspaceId: string): Promise<KnowledgePackContextForScoring> {
    const pack = await this.prisma.knowledgePack.findFirst({
      where: { workspaceId, status: "ACTIVE", deletedAt: null },
      select: {
        keywordSets: { select: { keywords: true } },
        brandGuidelines: { select: { terminology: true } },
      },
    });
    if (!pack) return { active: false, keywords: [], brandTerms: [] };

    const keywords = new Set<string>();
    for (const set of pack.keywordSets) {
      const raw = set.keywords;
      if (Array.isArray(raw)) {
        for (const k of raw) if (typeof k === "string" && k.trim()) keywords.add(k.trim());
      }
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
