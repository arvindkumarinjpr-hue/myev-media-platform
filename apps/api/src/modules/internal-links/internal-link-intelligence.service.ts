import { Injectable } from "@nestjs/common";
import type { InternalLinkStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { InternalLinksService } from "./internal-links.service";

export const ORPHAN_REASON = "NO_ACCEPTED_INCOMING_LINKS" as const;

export interface OrphanBlogView {
  contentItemPublicId: string;
  title: string;
  urlSlug: string | null;
  contentSeriesPublicId: string | null;
  topicClusterPublicId: string | null;
  /** Always 0 by the orphan definition itself (Part D) — included for API-shape consistency/transparency, not computed independently. */
  incomingAcceptedLinkCount: number;
  outgoingAcceptedLinkCount: number;
  latestContentScore: number | null;
  updatedAt: Date;
  reason: typeof ORPHAN_REASON;
}

export interface ClusterHealthView {
  topicClusterPublicId: string;
  name: string;
  approvedBlogCount: number;
  orphanBlogCount: number;
  blogsWithZeroOutgoingAcceptedLinksCount: number;
  intraClusterAcceptedLinkCount: number;
  crossClusterAcceptedLinkCount: number;
  /** (approvedBlogCount - orphanBlogCount) / approvedBlogCount * 100, rounded. Null when approvedBlogCount is 0 (not applicable, never a misleading 0). */
  linkCoveragePercentage: number | null;
}

export interface WorkspaceLinkHealthSummary {
  eligibleApprovedBlogs: number;
  orphanBlogs: number;
  blogsWithNoOutgoingAcceptedLinks: number;
  acceptedLinks: number;
  generatedRecommendations: number;
  staleRecommendations: number;
  rejectedRecommendations: number;
  clustersEvaluated: number;
  clustersWithOrphans: number;
}

interface EligibleBlog {
  id: string;
  publicId: string;
  title: string;
  seriesId: string | null;
  updatedAt: Date;
  urlSlug: string | null;
}

/**
 * Module 8 Phase 8.5 — deterministic orphan/cluster/workspace link-health
 * intelligence, plus the reusable reconciliation capability (Part J).
 * Read-only except reconcileWorkspace(), which only ever calls Phase
 * 8.1's own markStale() — never a second persistence path, never a
 * content mutation, never a deleted row.
 *
 * A single shared eligible-blog + link-count query pass (Part I) backs
 * all three read views — orphans, cluster health, and the workspace
 * summary all reuse the SAME data, computed once per call, never
 * duplicated per-view and never one query per Blog/cluster (Part U).
 */
@Injectable()
export class InternalLinkIntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly internalLinks: InternalLinksService,
  ) {}

  async listOrphans(workspaceId: string): Promise<OrphanBlogView[]> {
    const { blogs, incomingAccepted, outgoingAccepted, latestScores, clusterByBlogId, seriesById } = await this.loadWorkspaceLinkData(workspaceId);

    return blogs
      .filter((b) => (incomingAccepted.get(b.id) ?? 0) === 0)
      .map((b) => ({
        contentItemPublicId: b.publicId,
        title: b.title,
        urlSlug: b.urlSlug,
        contentSeriesPublicId: b.seriesId ? (seriesById.get(b.seriesId) ?? null) : null,
        topicClusterPublicId: clusterByBlogId.get(b.id)?.publicId ?? null,
        incomingAcceptedLinkCount: 0,
        outgoingAcceptedLinkCount: outgoingAccepted.get(b.id) ?? 0,
        latestContentScore: latestScores.get(b.id) ?? null,
        updatedAt: b.updatedAt,
        reason: ORPHAN_REASON,
      }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.contentItemPublicId.localeCompare(b.contentItemPublicId));
  }

  async clusterHealth(workspaceId: string): Promise<ClusterHealthView[]> {
    const { blogs, incomingAccepted, outgoingAccepted, clusterByBlogId, clusters } = await this.loadWorkspaceLinkData(workspaceId);

    // ACCEPTED links whose source AND target are both in a resolvable
    // cluster — the only links intra/cross-cluster metrics can speak to
    // (Part G: "cross-cluster ... where deterministically resolvable").
    const clusteredBlogIds = new Set(clusterByBlogId.keys());
    const clusteredAcceptedLinks =
      clusteredBlogIds.size > 0
        ? await this.prisma.internalLink.findMany({
            where: { workspaceId, status: "ACCEPTED", sourceContentItemId: { in: [...clusteredBlogIds] }, targetContentItemId: { in: [...clusteredBlogIds] } },
            select: { sourceContentItemId: true, targetContentItemId: true },
          })
        : [];

    const intraCount = new Map<string, number>();
    const crossCount = new Map<string, number>();
    for (const link of clusteredAcceptedLinks) {
      const sourceCluster = clusterByBlogId.get(link.sourceContentItemId)!.id;
      const targetCluster = clusterByBlogId.get(link.targetContentItemId)!.id;
      if (sourceCluster === targetCluster) {
        intraCount.set(sourceCluster, (intraCount.get(sourceCluster) ?? 0) + 1);
      } else {
        crossCount.set(sourceCluster, (crossCount.get(sourceCluster) ?? 0) + 1);
        crossCount.set(targetCluster, (crossCount.get(targetCluster) ?? 0) + 1);
      }
    }

    const blogsByCluster = new Map<string, EligibleBlog[]>();
    for (const b of blogs) {
      const cluster = clusterByBlogId.get(b.id);
      if (!cluster) continue;
      const list = blogsByCluster.get(cluster.id) ?? [];
      list.push(b);
      blogsByCluster.set(cluster.id, list);
    }

    return clusters
      .map((cluster) => {
        const clusterBlogs = blogsByCluster.get(cluster.id) ?? [];
        const approvedBlogCount = clusterBlogs.length;
        const orphanBlogCount = clusterBlogs.filter((b) => (incomingAccepted.get(b.id) ?? 0) === 0).length;
        const blogsWithZeroOutgoingAcceptedLinksCount = clusterBlogs.filter((b) => (outgoingAccepted.get(b.id) ?? 0) === 0).length;
        return {
          topicClusterPublicId: cluster.publicId,
          name: cluster.name,
          approvedBlogCount,
          orphanBlogCount,
          blogsWithZeroOutgoingAcceptedLinksCount,
          intraClusterAcceptedLinkCount: intraCount.get(cluster.id) ?? 0,
          crossClusterAcceptedLinkCount: crossCount.get(cluster.id) ?? 0,
          linkCoveragePercentage: approvedBlogCount === 0 ? null : Math.round(((approvedBlogCount - orphanBlogCount) / approvedBlogCount) * 100),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.topicClusterPublicId.localeCompare(b.topicClusterPublicId));
  }

  async workspaceSummary(workspaceId: string): Promise<WorkspaceLinkHealthSummary> {
    const { blogs, incomingAccepted, outgoingAccepted } = await this.loadWorkspaceLinkData(workspaceId);
    const clusters = await this.clusterHealth(workspaceId);

    const statusCounts = await this.prisma.internalLink.groupBy({
      by: ["status"],
      where: { workspaceId },
      _count: { _all: true },
    });
    const countOf = (status: InternalLinkStatus) => statusCounts.find((s) => s.status === status)?._count._all ?? 0;

    return {
      eligibleApprovedBlogs: blogs.length,
      orphanBlogs: blogs.filter((b) => (incomingAccepted.get(b.id) ?? 0) === 0).length,
      blogsWithNoOutgoingAcceptedLinks: blogs.filter((b) => (outgoingAccepted.get(b.id) ?? 0) === 0).length,
      acceptedLinks: countOf("ACCEPTED"),
      generatedRecommendations: countOf("GENERATED"),
      staleRecommendations: countOf("STALE"),
      rejectedRecommendations: countOf("REJECTED"),
      clustersEvaluated: clusters.length,
      clustersWithOrphans: clusters.filter((c) => c.orphanBlogCount > 0).length,
    };
  }

  /**
   * Deterministic stale reconciliation (Part J) — identifies every live
   * (GENERATED/ACCEPTED) recommendation in the workspace whose target has
   * become ineligible (ARCHIVED, DELETED, deletedAt set, or otherwise no
   * longer APPROVED) and transitions it to STALE via Phase 8.1's own
   * markStale(). Never touches a row for any other reason — relevance-
   * score drift alone is explicitly NOT a staleness trigger (Part J).
   * History is always preserved (markStale() never deletes).
   *
   * This is the SAME logic Phase 8.4's read-time safety already applies
   * per-row on every read; this method sweeps a whole workspace
   * proactively. It complements, and does not replace, read-time safety
   * (Part M) — both remain active.
   */
  async reconcileWorkspace(workspaceId: string, staleReason = "target no longer eligible (scheduled reconciliation)"): Promise<{ staledCount: number }> {
    const live = await this.prisma.internalLink.findMany({
      where: { workspaceId, status: { in: ["GENERATED", "ACCEPTED"] } },
      select: { publicId: true, targetContentItem: { select: { status: true, deletedAt: true } } },
    });

    let staledCount = 0;
    for (const row of live) {
      const eligible = row.targetContentItem.status === "APPROVED" && row.targetContentItem.deletedAt === null;
      if (!eligible) {
        await this.internalLinks.markStale(workspaceId, row.publicId, staleReason);
        staledCount++;
      }
    }
    return { staledCount };
  }

  /**
   * The one shared query pass every read view above builds on: the
   * eligible-Blog population (Part D: BLOG, APPROVED, deletedAt null,
   * same workspace, a BlogArticle exists), grouped ACCEPTED
   * incoming/outgoing link counts, latest content scores, and resolvable
   * Topic Cluster membership via the verified ContentItem.seriesId ->
   * ContentSeries <- TopicCluster.contentSeriesId bridge — never a new
   * direct ContentItem -> TopicCluster relation. A fixed, small number of
   * queries regardless of workspace size: no per-Blog, no per-cluster
   * loop issuing its own DB round trip.
   */
  private async loadWorkspaceLinkData(workspaceId: string) {
    const blogs: EligibleBlog[] = (
      await this.prisma.contentItem.findMany({
        where: { workspaceId, contentType: "BLOG", status: "APPROVED", deletedAt: null, blogArticle: { isNot: null } },
        select: { id: true, publicId: true, title: true, seriesId: true, updatedAt: true, blogArticle: { select: { urlSlug: true } } },
      })
    ).map((b) => ({ id: b.id, publicId: b.publicId, title: b.title, seriesId: b.seriesId, updatedAt: b.updatedAt, urlSlug: b.blogArticle?.urlSlug ?? null }));

    const ids = blogs.map((b) => b.id);

    const [incomingGroups, outgoingGroups, scoreRows] = await Promise.all([
      ids.length ? this.prisma.internalLink.groupBy({ by: ["targetContentItemId"], where: { workspaceId, status: "ACCEPTED", targetContentItemId: { in: ids } }, _count: { _all: true } }) : [],
      ids.length ? this.prisma.internalLink.groupBy({ by: ["sourceContentItemId"], where: { workspaceId, status: "ACCEPTED", sourceContentItemId: { in: ids } }, _count: { _all: true } }) : [],
      ids.length ? this.prisma.contentScore.findMany({ where: { workspaceId, contentItemId: { in: ids } }, orderBy: { calculatedAt: "desc" }, distinct: ["contentItemId"], select: { contentItemId: true, score: true } }) : [],
    ]);

    const incomingAccepted = new Map(incomingGroups.map((g) => [g.targetContentItemId, g._count._all]));
    const outgoingAccepted = new Map(outgoingGroups.map((g) => [g.sourceContentItemId, g._count._all]));
    const latestScores = new Map(scoreRows.map((s) => [s.contentItemId, s.score]));

    // ALL of the workspace's Topic Clusters, not just ones with a
    // currently-approved Blog member — a cluster with zero eligible
    // Blogs is a real, testable state (Part R: "zero-content cluster"),
    // and Topic Clusters are a curated planning set, not a content
    // corpus (same bounded-query precedent as Phase 8.2's own
    // discoverViaClusters()), so loading all of them unconditionally
    // stays cheap and query-count-fixed regardless of workspace size.
    const uniqueSeriesIds = [...new Set(blogs.map((b) => b.seriesId).filter((s): s is string => s !== null))];
    const [clusters, seriesRows] = await Promise.all([
      this.prisma.topicCluster.findMany({ where: { workspaceId }, select: { id: true, publicId: true, name: true, contentSeriesId: true } }),
      uniqueSeriesIds.length ? this.prisma.contentSeries.findMany({ where: { workspaceId, id: { in: uniqueSeriesIds } }, select: { id: true, publicId: true } }) : [],
    ]);
    const seriesById = new Map(seriesRows.map((s) => [s.id, s.publicId]));
    const clusterBySeriesId = new Map(clusters.filter((c) => c.contentSeriesId !== null).map((c) => [c.contentSeriesId as string, c]));
    const clusterByBlogId = new Map<string, (typeof clusters)[number]>();
    for (const b of blogs) {
      if (b.seriesId) {
        const cluster = clusterBySeriesId.get(b.seriesId);
        if (cluster) clusterByBlogId.set(b.id, cluster);
      }
    }

    return { blogs, incomingAccepted, outgoingAccepted, latestScores, clusters, clusterByBlogId, clusterBySeriesId, seriesById };
  }
}
