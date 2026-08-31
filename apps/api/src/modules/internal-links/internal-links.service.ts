import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type ContentItemStatus, type InternalLink, type InternalLinkStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { assertNoSelfLink, assertSourceEligible, assertTargetEligible, assertValidRelevanceScore, assertValidTransition } from "./internal-link-domain";
import { INTERNAL_LINK_ERRORS } from "./internal-link.errors";

const ACTIVE_PAIR_UNIQUE_CONSTRAINT = "P2002";

// Mirrors SlugReservationService's own isUniqueConstraintViolation — the
// partial unique index on (workspace_id, source_content_item_id,
// target_content_item_id) WHERE status NOT IN ('STALE','REJECTED') is
// the DB-level concurrency authority (Correction §5); this is what a
// caught violation of it is mapped to, never leaked as a raw
// Prisma/Postgres error to the caller.
function isActivePairConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === ACTIVE_PAIR_UNIQUE_CONSTRAINT;
}

interface RequestContext {
  ipAddress?: string;
}

interface CreateInternalLinkInput {
  sourceContentItemPublicId: string;
  targetContentItemPublicId: string;
  anchorText: string;
  relevanceScore: number;
  evidence: Record<string, unknown>;
  engineVersion?: number;
}

interface ContentItemEligibilityRow {
  id: string;
  status: ContentItemStatus;
  deletedAt: Date | null;
}

/**
 * Module 8 Phase 8.1 — Internal Linking Engine, domain + persistence
 * foundation.
 *
 * Deliberately narrow: this service only persists a recommendation
 * already computed elsewhere (anchorText/relevanceScore/evidence are
 * plain inputs, not derived here) and enforces the domain invariants
 * that must hold regardless of how a recommendation was produced —
 * self-link rejection, source/target eligibility, relevance-score range,
 * lifecycle-transition validity, and duplicate/race safety. Candidate
 * discovery and relevance scoring (Phase 8.2) and anchor generation
 * (Phase 8.3) are NOT implemented here, and this service has no HTTP
 * controller in this phase — see the Module 8 Architecture Checkpoint
 * Correction, Phase 8.1 scope.
 *
 * `create()` never supersedes an existing live row for the same pair —
 * it is a plain insert, race-safe via the DB's own partial unique index
 * (caught and mapped to a typed conflict, see isActivePairConflict).
 * Any "regenerate" choreography (transition the old row out of the live
 * set first, then create()) belongs to Phase 8.2's discovery engine, not
 * this foundation layer.
 */
@Injectable()
export class InternalLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(workspaceId: string, actorUserId: string | null, input: CreateInternalLinkInput, context: RequestContext = {}): Promise<InternalLink> {
    assertValidRelevanceScore(input.relevanceScore);

    return this.prisma.$transaction(async (tx) => {
      const source = await this.resolveEligibilityRow(tx, workspaceId, input.sourceContentItemPublicId, INTERNAL_LINK_ERRORS.INTERNAL_LINK_SOURCE_NOT_FOUND);
      const target = await this.resolveEligibilityRow(tx, workspaceId, input.targetContentItemPublicId, INTERNAL_LINK_ERRORS.INTERNAL_LINK_TARGET_NOT_FOUND);

      assertNoSelfLink(source.id, target.id);
      assertSourceEligible(source.status, source.deletedAt);
      assertTargetEligible(target.status, target.deletedAt);

      let created: InternalLink;
      try {
        created = await tx.internalLink.create({
          data: {
            workspaceId,
            sourceContentItemId: source.id,
            targetContentItemId: target.id,
            anchorText: input.anchorText,
            relevanceScore: input.relevanceScore,
            evidence: input.evidence as Prisma.InputJsonValue,
            engineVersion: input.engineVersion ?? 1,
          },
        });
      } catch (error) {
        if (isActivePairConflict(error)) {
          throw new ConflictException({
            code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_ACTIVE_RECOMMENDATION_EXISTS,
            message: "An active (GENERATED or ACCEPTED) internal-link recommendation already exists for this source/target pair.",
          });
        }
        throw error;
      }

      await this.audit.recordWithinTransaction(tx, {
        action: "INTERNAL_LINK_CREATED",
        actorUserId,
        workspaceId,
        entityType: "internal_link",
        entityId: created.publicId,
        afterState: { status: created.status, sourceContentItemPublicId: input.sourceContentItemPublicId, targetContentItemPublicId: input.targetContentItemPublicId },
        ipAddress: context.ipAddress,
      });

      return created;
    });
  }

  async accept(workspaceId: string, internalLinkPublicId: string, actorUserId: string, context: RequestContext = {}): Promise<InternalLink> {
    return this.transition(workspaceId, internalLinkPublicId, "ACCEPTED", actorUserId, context, {});
  }

  async reject(workspaceId: string, internalLinkPublicId: string, actorUserId: string, rejectionReason: string, context: RequestContext = {}): Promise<InternalLink> {
    return this.transition(workspaceId, internalLinkPublicId, "REJECTED", actorUserId, context, { rejectionReason });
  }

  /**
   * System-triggered invalidation (D14) — source/target edited, target
   * archived/deleted, etc. Deliberately no `actorUserId`/reviewedBy: this
   * is not a human review action (accept/reject are), so reviewedById/
   * reviewedAt are left untouched.
   */
  async markStale(workspaceId: string, internalLinkPublicId: string, staleReason: string, context: RequestContext = {}): Promise<InternalLink> {
    return this.transition(workspaceId, internalLinkPublicId, "STALE", null, context, { staleReason });
  }

  async findOne(workspaceId: string, internalLinkPublicId: string): Promise<InternalLink> {
    const row = await this.prisma.internalLink.findFirst({ where: { workspaceId, publicId: internalLinkPublicId } });
    if (!row) {
      throw new NotFoundException({ code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_NOT_FOUND, message: "Internal-link recommendation not found." });
    }
    return row;
  }

  private async transition(
    workspaceId: string,
    internalLinkPublicId: string,
    to: InternalLinkStatus,
    actorUserId: string | null,
    context: RequestContext,
    fields: { rejectionReason?: string; staleReason?: string },
  ): Promise<InternalLink> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.internalLink.findFirst({ where: { workspaceId, publicId: internalLinkPublicId } });
      if (!current) {
        throw new NotFoundException({ code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_NOT_FOUND, message: "Internal-link recommendation not found." });
      }
      assertValidTransition(current.status, to);

      const isHumanReview = to === "ACCEPTED" || to === "REJECTED";
      const updated = await tx.internalLink.update({
        where: { id: current.id },
        data: {
          status: to,
          ...(isHumanReview ? { reviewedById: actorUserId, reviewedAt: new Date() } : {}),
          ...(fields.rejectionReason !== undefined ? { rejectionReason: fields.rejectionReason } : {}),
          ...(fields.staleReason !== undefined ? { staleReason: fields.staleReason } : {}),
        },
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "INTERNAL_LINK_STATUS_CHANGED",
        actorUserId,
        workspaceId,
        entityType: "internal_link",
        entityId: updated.publicId,
        afterState: { fromStatus: current.status, toStatus: to },
        ipAddress: context.ipAddress,
      });

      return updated;
    });
  }

  private async resolveEligibilityRow(tx: Prisma.TransactionClient, workspaceId: string, contentItemPublicId: string, notFoundCode: string): Promise<ContentItemEligibilityRow> {
    const row = await tx.contentItem.findFirst({
      where: { workspaceId, publicId: contentItemPublicId },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!row) {
      throw new NotFoundException({ code: notFoundCode, message: "Content item not found." });
    }
    return row;
  }
}
