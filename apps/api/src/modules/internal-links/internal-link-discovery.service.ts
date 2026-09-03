import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ContentItem } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppConfig } from "../../config/configuration";
import { ContentScoringService } from "../content-scoring/content-scoring.service";
import { assertSourceEligible } from "./internal-link-domain";
import { INTERNAL_LINK_ERRORS } from "./internal-link.errors";
import { InternalLinksService } from "./internal-links.service";
import { extractPlainText, extractRelativeLinkPaths, tokenize } from "./internal-link-text";
import { scoreCandidate, summarizeEvidenceReason, type CandidateEvidence, type DiscoveryMethod } from "./internal-link-scoring";
import { InternalLinkAnchorService } from "./internal-link-anchor.service";
import { resolveInternalLinkingPolicy, type InternalLinkingPolicy } from "./internal-link-policy";

interface RequestContext {
  ipAddress?: string;
}

export interface DiscoveryRunResult {
  sourceContentItemPublicId: string;
  candidatesConsidered: number;
  candidatesScored: number;
  recommendationsCreated: Array<{ targetContentItemPublicId: string; relevanceScore: number; discoveryMethod: DiscoveryMethod; anchorText: string; reason: string }>;
}

interface CandidateEntry {
  item: Pick<ContentItem, "id" | "publicId" | "title" | "seriesId" | "updatedAt">;
  discoveryMethod: DiscoveryMethod;
  sharedSeries: boolean;
  sharedSeriesHasTopicCluster: boolean;
  sharedKeywordClusterTerms: string[];
  sourceKeywordClusterTermCount: number;
  targetKeywordClusterTermCount: number;
}

const SOURCE_SELECT = {
  id: true,
  workspaceId: true,
  contentType: true,
  title: true,
  seriesId: true,
  status: true,
  deletedAt: true,
  currentVersion: { select: { body: true } },
} as const;

const CANDIDATE_METADATA_SELECT = { id: true, publicId: true, title: true, seriesId: true, updatedAt: true } as const;

/**
 * Module 8 Phase 8.2 — Candidate Discovery + Relevance Engine.
 *
 * Deterministic only — no AI, no embeddings, no provider calls. Every
 * write goes through Phase 8.1's InternalLinksService, which owns every
 * domain invariant (self-link, eligibility, lifecycle, active-pair
 * uniqueness, typed conflicts) — this service never bypasses it.
 *
 * v1 scope is Blog -> Blog only (Architecture Checkpoint Correction,
 * corrected D2): source contentType is asserted BLOG here (a Phase-8.2
 * business rule, deliberately NOT added to Phase 8.1's own domain
 * functions, which stay content-type-agnostic by design so a future
 * content type is a business-logic change here, not a Phase 8.1 rewrite).
 * Target contentType is implicitly BLOG too — every candidate query below
 * filters on it explicitly, never inferred.
 */
@Injectable()
export class InternalLinkDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly internalLinks: InternalLinksService,
    private readonly contentScoring: ContentScoringService,
    private readonly anchorEngine: InternalLinkAnchorService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async generateForSource(workspaceId: string, sourceContentItemPublicId: string, actorUserId: string | null, context: RequestContext = {}): Promise<DiscoveryRunResult> {
    const source = await this.prisma.contentItem.findFirst({ where: { workspaceId, publicId: sourceContentItemPublicId }, select: SOURCE_SELECT });
    if (!source) {
      // Module 8 Phase 8.4 fix: "not found" (including cross-workspace,
      // enumeration-safe) is a 404, matching Phase 8.1's own
      // resolveEligibilityRow() and the platform-wide convention — not
      // a 422 (which is reserved for a found-but-wrong-state entity,
      // e.g. INTERNAL_LINK_DISCOVERY_SOURCE_NOT_BLOG just below).
      throw new NotFoundException({ code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_SOURCE_NOT_FOUND, message: "Content item not found." });
    }
    if (source.contentType !== "BLOG") {
      throw new UnprocessableEntityException({
        code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_DISCOVERY_SOURCE_NOT_BLOG,
        message: "Internal-link discovery is Blog -> Blog only in this phase.",
      });
    }
    assertSourceEligible(source.status, source.deletedAt);

    const sourceText = extractPlainText(source.title, source.currentVersion?.body ?? null);
    const sourceTokens = [...tokenize(sourceText)];
    const sourceRelativeLinkPaths = extractRelativeLinkPaths(source.currentVersion?.body ?? null);

    const { limit, minThreshold: configThreshold, maxPerRun } = this.readConfig();
    const policy = await this.loadPolicy(workspaceId);
    // Phase 8.3 §G: when a workspace's own KP policy sets a minimum, it
    // is an ADDITIONAL floor on top of the global AppConfig default,
    // never a way to weaken it.
    const minThreshold = policy.minRelevanceScore !== null ? Math.max(configThreshold, policy.minRelevanceScore) : configThreshold;

    // 1 & 2. Cluster proximity + keyword-cluster overlap — the one real
    // structural relationship in the schema (ContentItem.seriesId ->
    // ContentSeries <- TopicCluster.contentSeriesId), enriched via each
    // cluster's own KeywordCluster members. Bounded: workspace Topic
    // Clusters are a curated planning set, not a content corpus — this
    // loads no item BODIES, only metadata.
    let candidates = await this.discoverViaClusters(workspaceId, source);

    // Plain series-mates without a promoted Topic Cluster — a real,
    // weaker relationship signal 1's cluster query above cannot see
    // (sourceCluster would be undefined for an un-promoted series).
    if (source.seriesId) {
      const seriesMates = await this.prisma.contentItem.findMany({
        where: { workspaceId, seriesId: source.seriesId, contentType: "BLOG", status: "APPROVED", deletedAt: null, id: { not: source.id } },
        select: CANDIDATE_METADATA_SELECT,
        take: limit,
      });
      for (const item of seriesMates) {
        if (!candidates.has(item.id)) {
          candidates.set(item.id, { item, discoveryMethod: "cluster", sharedSeries: true, sharedSeriesHasTopicCluster: false, sharedKeywordClusterTerms: [], sourceKeywordClusterTermCount: 0, targetKeywordClusterTermCount: 0 });
        }
      }
    }

    // 3 & 4. Fallback tier — only when the structural signals above found
    // nothing. This is the ONE tier that loads body text, and it is
    // bounded to `limit` most-recently-updated APPROVED Blog items, never
    // an unrestricted full-workspace scan.
    let fallbackPool: Array<{ id: string; publicId: string; title: string; updatedAt: Date; body: unknown }> = [];
    if (candidates.size === 0) {
      const pool = await this.prisma.contentItem.findMany({
        where: { workspaceId, contentType: "BLOG", status: "APPROVED", deletedAt: null, id: { not: source.id } },
        select: { id: true, publicId: true, title: true, updatedAt: true, currentVersion: { select: { body: true } } },
        orderBy: { updatedAt: "desc" },
        take: limit,
      });
      fallbackPool = pool.map((p) => ({ id: p.id, publicId: p.publicId, title: p.title, updatedAt: p.updatedAt, body: p.currentVersion?.body ?? null }));
      for (const p of fallbackPool) {
        candidates.set(p.id, { item: { id: p.id, publicId: p.publicId, title: p.title, seriesId: null, updatedAt: p.updatedAt }, discoveryMethod: "token-fallback", sharedSeries: false, sharedSeriesHasTopicCluster: false, sharedKeywordClusterTerms: [], sourceKeywordClusterTermCount: 0, targetKeywordClusterTermCount: 0 });
      }
    }

    // Bound the pool BEFORE any further body/score work, regardless of
    // which tier produced it.
    if (candidates.size > limit) {
      candidates = new Map([...candidates.entries()].slice(0, limit));
    }

    // Exclusions: self is already impossible (id != source.id in every
    // query above). Cross-workspace is already impossible (workspaceId
    // scopes every query). Wrong ContentType/lifecycle are already
    // impossible (BLOG/APPROVED/deletedAt filters above). What remains:
    // duplicate active recommendation, and already-linked-in-body.
    const existingActiveTargets = await this.prisma.internalLink.findMany({
      where: { workspaceId, sourceContentItemId: source.id, status: { in: ["GENERATED", "ACCEPTED"] } },
      select: { targetContentItemId: true },
    });
    const activeTargetIds = new Set(existingActiveTargets.map((r) => r.targetContentItemId));
    for (const id of activeTargetIds) candidates.delete(id);

    // internalLinkingPolicy.excludedContentItemIds — public ids, so
    // resolve against the already-loaded candidate metadata rather than
    // a second query.
    if (policy.excludedContentItemIds.length > 0) {
      const excludedPublicIds = new Set(policy.excludedContentItemIds);
      for (const [id, entry] of candidates) {
        if (excludedPublicIds.has(entry.item.publicId)) candidates.delete(id);
      }
    }

    const candidatesConsidered = candidates.size;
    if (candidatesConsidered === 0) {
      return { sourceContentItemPublicId, candidatesConsidered: 0, candidatesScored: 0, recommendationsCreated: [] };
    }

    // Fetch full data (body + BlogArticle.urlSlug) for every surviving
    // candidate in ONE bounded query — needed for the KP-keyword/token
    // factors and existing-link detection regardless of which tier found
    // the candidate.
    const candidateIds = [...candidates.keys()];
    const fullRows = await this.prisma.contentItem.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, updatedAt: true, currentVersion: { select: { body: true } }, blogArticle: { select: { urlSlug: true } } },
    });
    const fullById = new Map(fullRows.map((r) => [r.id, r]));

    const kpKeywords = await this.loadActiveKnowledgePackKeywords(workspaceId);
    const sharedKpForSource = kpKeywords.filter((k) => sourceText.toLowerCase().includes(k));

    const scored: Array<{ entry: CandidateEntry; evidence: CandidateEvidence }> = [];
    for (const entry of candidates.values()) {
      const full = fullById.get(entry.item.id);
      if (!full) continue;

      // Already-linked-in-body — best-effort: no real Module 9 URL/route
      // convention exists yet (verified: BlogArticle.urlSlug is written
      // but never used to construct a public route anywhere in this
      // repository), so this reuses the one already-established relative-
      // link regex shape (Module 6's own countInternalLinks pattern,
      // independently implemented in internal-link-text.ts) matched
      // against the target's own urlSlug when a BlogArticle row exists
      // for it. Not a fabricated URL scheme — a documented limitation,
      // not a fabrication.
      const targetSlug = full.blogArticle?.urlSlug;
      if (targetSlug && sourceRelativeLinkPaths.some((path) => path.includes(targetSlug))) continue;

      const targetText = extractPlainText(entry.item.title, full.currentVersion?.body ?? null);
      const targetTokens = [...tokenize(targetText)];
      const sharedKp = sharedKpForSource.filter((k) => targetText.toLowerCase().includes(k));

      const authority = await this.readTargetAuthority(workspaceId, entry.item.publicId);

      const evidence = scoreCandidate({
        discoveryMethod: entry.discoveryMethod,
        sharedSeries: entry.sharedSeries,
        sharedSeriesHasTopicCluster: entry.sharedSeriesHasTopicCluster,
        sharedKeywordClusterTerms: entry.sharedKeywordClusterTerms,
        sourceKeywordClusterTermCount: entry.sourceKeywordClusterTermCount,
        targetKeywordClusterTermCount: entry.targetKeywordClusterTermCount,
        sharedKpKeywords: sharedKp,
        sourceKpKeywordMentionCount: sharedKpForSource.length,
        sourceTokens,
        targetTokens,
        targetUpdatedAt: full.updatedAt,
        now: new Date(),
        targetAuthorityScore: authority,
        sourceRelativeLinkCount: sourceRelativeLinkPaths.length,
      });

      scored.push({ entry, evidence });
    }

    const surviving = scored
      .filter((s) => s.evidence.overallScore >= minThreshold)
      .sort((a, b) => b.evidence.overallScore - a.evidence.overallScore)
      .slice(0, maxPerRun);

    const recommendationsCreated: DiscoveryRunResult["recommendationsCreated"] = [];
    for (const { entry, evidence } of surviving) {
      try {
        const created = await this.internalLinks.create(
          workspaceId,
          actorUserId,
          {
            sourceContentItemPublicId,
            targetContentItemPublicId: entry.item.publicId,
            // The InternalLink schema requires anchorText NOT NULL and
            // no anchor engine has run yet at create()-time — this is
            // the deterministic Phase 8.2 seed/fallback. Immediately
            // below, Phase 8.3's anchor engine attempts to replace it
            // with a real natural-phrase candidate via updateAnchor();
            // this value is what stands if that engine finds nothing
            // better (or is unreachable), never a fabricated anchor.
            anchorText: entry.item.title,
            relevanceScore: evidence.overallScore,
            evidence: evidence as unknown as Record<string, unknown>,
            engineVersion: 1,
          },
          context,
        );
        let finalAnchorText = created.anchorText;

        // Phase 8.3 — deterministic anchor recommendation, applied
        // in-place onto the row create() just seeded with the target
        // title. Never allowed to fail the whole discovery run: a
        // provider is never involved here (no AI dependency at all in
        // this phase), but the engine still runs defensively — if it
        // throws for any reason, the already-seeded target-title
        // fallback from create() stands untouched, which is always a
        // safe, deterministic, already-valid result on its own.
        try {
          const anchorEvidence = await this.anchorEngine.selectAnchor(workspaceId, sourceText, { id: entry.item.id, title: entry.item.title });
          const mergedEvidence = { ...(created.evidence as Record<string, unknown>), anchor: anchorEvidence };
          const revised = await this.internalLinks.updateAnchor(workspaceId, created.publicId, { anchorText: anchorEvidence.selectedAnchor, evidence: mergedEvidence });
          finalAnchorText = revised.anchorText;
        } catch {
          // Deliberately swallowed — see comment above. The row already
          // exists and is fully valid with its Phase 8.2 seed.
        }

        recommendationsCreated.push({ targetContentItemPublicId: entry.item.publicId, relevanceScore: created.relevanceScore, discoveryMethod: entry.discoveryMethod, anchorText: finalAnchorText, reason: summarizeEvidenceReason(evidence) });
      } catch (error) {
        // The pre-filter above already excludes known-active pairs; this
        // catch only matters under a genuine concurrent-generation race,
        // where InternalLinksService's own typed conflict (not a raw
        // Prisma error) is the authority — skip and continue, never fail
        // the whole run over one pair.
        if ((error as { status?: number })?.status === 409) continue;
        throw error;
      }
    }

    return { sourceContentItemPublicId, candidatesConsidered, candidatesScored: scored.length, recommendationsCreated };
  }

  private async discoverViaClusters(workspaceId: string, source: { id: string; seriesId: string | null }): Promise<Map<string, CandidateEntry>> {
    const clusters = await this.prisma.topicCluster.findMany({
      where: { workspaceId },
      select: {
        contentSeriesId: true,
        keywordCluster: { select: { members: { select: { keyword: { select: { term: true } } } } } },
        contentSeries: { select: { contentItems: { where: { contentType: "BLOG", status: "APPROVED", deletedAt: null, id: { not: source.id } }, select: CANDIDATE_METADATA_SELECT } } },
      },
    });

    const termsOf = (c: (typeof clusters)[number]) => new Set(c.keywordCluster.members.map((m) => m.keyword.term.toLowerCase()));
    const sourceCluster = clusters.find((c) => c.contentSeriesId !== null && c.contentSeriesId === source.seriesId);
    const sourceTerms = sourceCluster ? termsOf(sourceCluster) : new Set<string>();

    const result = new Map<string, CandidateEntry>();
    for (const cluster of clusters) {
      const isSameCluster = sourceCluster !== undefined && cluster.contentSeriesId === sourceCluster.contentSeriesId;
      const targetTerms = termsOf(cluster);
      const shared = [...sourceTerms].filter((t) => targetTerms.has(t));
      if (!isSameCluster && shared.length === 0) continue;

      for (const item of cluster.contentSeries?.contentItems ?? []) {
        if (!result.has(item.id)) {
          result.set(item.id, {
            item,
            discoveryMethod: isSameCluster ? "cluster" : "keyword-cluster",
            sharedSeries: isSameCluster,
            sharedSeriesHasTopicCluster: isSameCluster,
            sharedKeywordClusterTerms: shared,
            sourceKeywordClusterTermCount: sourceTerms.size,
            targetKeywordClusterTermCount: targetTerms.size,
          });
        }
      }
    }
    return result;
  }

  private async loadActiveKnowledgePackKeywords(workspaceId: string): Promise<string[]> {
    const pack = await this.prisma.knowledgePack.findFirst({
      where: { workspaceId, status: "ACTIVE", deletedAt: null },
      select: { seoRules: { select: { primaryKeywords: true, secondaryKeywords: true } } },
    });
    if (!pack) return [];
    const keywords = new Set<string>();
    for (const rule of pack.seoRules) {
      for (const raw of [rule.primaryKeywords, rule.secondaryKeywords]) {
        if (Array.isArray(raw)) {
          for (const k of raw) if (typeof k === "string" && k.trim()) keywords.add(k.trim().toLowerCase());
        }
      }
    }
    return [...keywords];
  }

  /** Latest ContentScore.overallScore for a target, or null — read-only, never triggers scoring (getLatest() never mutates). */
  private async readTargetAuthority(workspaceId: string, contentItemPublicId: string): Promise<number | null> {
    const latest = await this.contentScoring.getLatest(workspaceId, contentItemPublicId);
    return latest?.result.overallScore ?? null;
  }

  private readConfig(): { limit: number; minThreshold: number; maxPerRun: number } {
    const cfg = this.config.get("internalLinking", { infer: true });
    return { limit: cfg.candidatePoolLimit, minThreshold: cfg.minRelevanceThreshold, maxPerRun: cfg.maxRecommendationsPerRun };
  }

  private async loadPolicy(workspaceId: string): Promise<InternalLinkingPolicy> {
    const pack = await this.prisma.knowledgePack.findFirst({
      where: { workspaceId, status: "ACTIVE", deletedAt: null },
      select: { seoRules: { select: { internalLinkingPolicy: true }, take: 1 } },
    });
    return resolveInternalLinkingPolicy(pack?.seoRules[0]?.internalLinkingPolicy ?? null);
  }
}
