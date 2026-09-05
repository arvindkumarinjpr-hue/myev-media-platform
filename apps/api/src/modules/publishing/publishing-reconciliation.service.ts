import { Injectable, NotFoundException } from "@nestjs/common";
import { assertReconciliationEligible, isReconciliationRequired } from "@myev/shared";
import { Prisma, type PublicationTarget } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { translatePublishingDomainError } from "./publishing-error-translation";
import { PUBLISHING_ERRORS } from "./publishing.errors";

interface RequestContext {
  ipAddress?: string;
}

const VALID_URL_PROTOCOLS = new Set(["http:", "https:"]);

function isValidExternalUrlShape(url: string): boolean {
  try {
    return VALID_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Module 9 Phase 9.7 (Part V/W/X) — the ONE domain service for manual
 * reconciliation of a target left in an ambiguous external-outcome
 * state by Facebook/Instagram's own Phase 9.6-documented API gaps. A
 * controller never writes `PublicationTarget` directly for either
 * action (Part X).
 *
 * Migration-checkpoint finding (see @myev/shared's
 * `isReconciliationRequired`/`assertReconciliationEligible` own doc
 * comments): no new `PublicationTargetStatus` value was needed — a
 * target stays FAILED throughout; `lastErrorCode` already truthfully
 * distinguishes "awaiting reconciliation" from an ordinary failure. This
 * service is what actually PERFORMS the two possible resolutions:
 *
 *  - markExternallyPublished(): FAILED -> PUBLISHED directly. This is a
 *    deliberate, narrow, documented exception to
 *    `assertPublicationTargetTransition`'s own frozen table (which has
 *    no FAILED -> PUBLISHED edge, by design, for every OTHER caller) —
 *    exactly the same kind of precedented exception
 *    PublishingExecutionService's own checkpoint bookkeeping already is
 *    (a documented bypass of the generic transition guard for one
 *    specific, safety-gated purpose). No provider call is ever made
 *    here — this only records what the operator verified externally.
 *
 *  - confirmNotPublished(): resolves the ambiguity by clearing it — the
 *    target's `lastErrorCode` is rewritten to a neutral, non-
 *    reconciliation code so a subsequent ordinary retry (the EXISTING,
 *    unmodified FAILED -> QUEUED transition) is no longer blocked by
 *    `assertOrdinaryRetryAllowed()`. This method itself does NOT queue a
 *    retry — Part W's own instruction ("must explicitly clear/resolve
 *    the ambiguity BEFORE requeueing") is satisfied by keeping these as
 *    two separate actions: this one only clears the block; the
 *    operator's own subsequent (now-unblocked) call to the ordinary
 *    retry endpoint is what actually queues it.
 */
@Injectable()
export class PublishingReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async markExternallyPublished(
    workspaceId: string,
    actorUserId: string,
    targetPublicId: string,
    input: { externalContentId: string; externalUrl?: string; note: string },
    context: RequestContext = {},
  ): Promise<PublicationTarget> {
    if (input.externalUrl && !isValidExternalUrlShape(input.externalUrl)) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "externalUrl must be a valid http(s) URL." });
    }
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId } });
      if (!target) {
        throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "Publication target not found." });
      }
      try {
        assertReconciliationEligible(target.status, target.lastErrorCode);
      } catch (error) {
        translatePublishingDomainError(error);
      }

      const updated = await tx.publicationTarget.update({
        where: { id: target.id },
        data: { status: "PUBLISHED", publishedAt: new Date(), externalContentId: input.externalContentId, externalUrl: input.externalUrl ?? null },
      });
      // Append-only history — the ORIGINAL ambiguous-failure PublishAttempt
      // row is left completely untouched (Part X: "immutable historical
      // PublishAttempt retained"); this is a NEW row recording the
      // reconciliation itself.
      await tx.publishAttempt.create({
        data: {
          publicationTargetId: target.id,
          fromStatus: "FAILED",
          toStatus: "PUBLISHED",
          detail: { reason: "manual_reconciliation_marked_published", externalContentId: input.externalContentId, externalUrl: input.externalUrl ?? null, note: input.note, resolvedBy: actorUserId } as Prisma.InputJsonValue,
        },
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLICATION_TARGET_STATUS_CHANGED",
        actorUserId,
        workspaceId,
        entityType: "publication_target",
        entityId: target.publicId,
        beforeState: { status: target.status, lastErrorCode: target.lastErrorCode },
        afterState: { status: "PUBLISHED", reconciliation: "marked_externally_published", externalContentId: input.externalContentId, note: input.note },
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  async confirmNotPublished(workspaceId: string, actorUserId: string, targetPublicId: string, input: { note: string }, context: RequestContext = {}): Promise<PublicationTarget> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId } });
      if (!target) {
        throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "Publication target not found." });
      }
      try {
        assertReconciliationEligible(target.status, target.lastErrorCode);
      } catch (error) {
        translatePublishingDomainError(error);
      }

      // Stays FAILED — only the blocking error code is cleared, per this
      // class's own doc comment. A neutral, non-reconciliation code so
      // isReconciliationRequired() is truthfully false afterward.
      const updated = await tx.publicationTarget.update({
        where: { id: target.id },
        data: { lastErrorCode: "PUBLISHING_RECONCILIATION_RESOLVED_NOT_PUBLISHED", lastErrorMessageSafe: "Operator confirmed this was not externally published; ordinary retry is now available." },
      });
      await tx.publishAttempt.create({
        data: {
          publicationTargetId: target.id,
          fromStatus: "FAILED",
          toStatus: "FAILED",
          detail: { reason: "manual_reconciliation_confirmed_not_published", note: input.note, resolvedBy: actorUserId } as Prisma.InputJsonValue,
        },
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLICATION_TARGET_STATUS_CHANGED",
        actorUserId,
        workspaceId,
        entityType: "publication_target",
        entityId: target.publicId,
        beforeState: { status: target.status, lastErrorCode: target.lastErrorCode },
        afterState: { status: target.status, reconciliation: "confirmed_not_published", note: input.note },
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  /** Read-only helper the query/detail service uses to decide whether to surface the "Manual verification required" UI state for a target. */
  isAwaitingReconciliation(status: string, lastErrorCode: string | null): boolean {
    return isReconciliationRequired(status as PublicationTarget["status"], lastErrorCode);
  }
}
