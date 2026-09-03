import { Injectable, NotFoundException } from "@nestjs/common";
import type { InternalLinkStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { INTERNAL_LINK_ERRORS } from "./internal-link.errors";
import { summarizeEvidenceReason, type CandidateEvidence } from "./internal-link-scoring";
import { InternalLinksService } from "./internal-links.service";

export interface InternalLinkView {
  publicId: string;
  sourceContentItemPublicId: string;
  targetContentItemPublicId: string;
  targetTitle: string;
  anchorText: string;
  relevanceScore: number;
  status: InternalLinkStatus;
  evidence: unknown;
  /** Short, deterministic, human-readable summary derived from evidence — see summarizeEvidenceReason(). */
  reason: string;
  generatedAt: Date;
  reviewedAt: Date | null;
  reviewedByPublicId: string | null;
  rejectionReason: string | null;
  staleReason: string | null;
}

const LIVE_STATUSES: InternalLinkStatus[] = ["GENERATED", "ACCEPTED"];

/**
 * Module 8 Phase 8.4 — the single read path for a source's internal-link
 * recommendations, shared by the BLOG_VIEW-gated list endpoint and the
 * Module 6 Blog pipeline's own lightweight suggestion mapping. Both
 * consumers get the exact same, correctly safety-checked view rather
 * than two independent read implementations.
 *
 * Read-time safety (Phase 8.2's own deferred invalidation-on-edit debt,
 * carried forward — see the Phase 8.2 completion report's §14): a live
 * (GENERATED/ACCEPTED) row whose target has since become ineligible
 * (archived, deleted, or no longer APPROVED) is transitioned to STALE
 * right here, via Phase 8.1's own existing, safe markStale() — never
 * silently hidden, never left mislabeled as a currently-usable
 * suggestion.
 */
@Injectable()
export class InternalLinksQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly internalLinks: InternalLinksService,
  ) {}

  async listForItem(workspaceId: string, sourceContentItemPublicId: string): Promise<InternalLinkView[]> {
    const source = await this.prisma.contentItem.findFirst({ where: { workspaceId, publicId: sourceContentItemPublicId }, select: { id: true } });
    if (!source) {
      throw new NotFoundException({ code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_SOURCE_NOT_FOUND, message: "Content item not found." });
    }

    const rows = await this.prisma.internalLink.findMany({
      where: { workspaceId, sourceContentItemId: source.id },
      include: {
        targetContentItem: { select: { publicId: true, title: true, status: true, deletedAt: true } },
        reviewedBy: { select: { publicId: true } },
      },
    });

    const views: InternalLinkView[] = [];
    for (const row of rows) {
      let status = row.status;
      let staleReason = row.staleReason;
      if (LIVE_STATUSES.includes(status)) {
        const targetEligible = row.targetContentItem.status === "APPROVED" && row.targetContentItem.deletedAt === null;
        if (!targetEligible) {
          const staled = await this.internalLinks.markStale(workspaceId, row.publicId, "target no longer eligible (read-time safety check)");
          status = staled.status;
          staleReason = staled.staleReason;
        }
      }
      views.push({
        publicId: row.publicId,
        sourceContentItemPublicId,
        targetContentItemPublicId: row.targetContentItem.publicId,
        targetTitle: row.targetContentItem.title,
        anchorText: row.anchorText,
        relevanceScore: row.relevanceScore,
        status,
        evidence: row.evidence,
        reason: summarizeEvidenceReason(row.evidence as unknown as CandidateEvidence),
        generatedAt: row.generatedAt,
        reviewedAt: row.reviewedAt,
        reviewedByPublicId: row.reviewedBy?.publicId ?? null,
        rejectionReason: row.rejectionReason,
        staleReason,
      });
    }

    // Deterministic ordering: GENERATED first, then relevanceScore
    // descending, then generatedAt ascending.
    const rank = (s: InternalLinkStatus) => (s === "GENERATED" ? 0 : 1);
    views.sort((a, b) => {
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      return a.generatedAt.getTime() - b.generatedAt.getTime();
    });

    return views;
  }
}
