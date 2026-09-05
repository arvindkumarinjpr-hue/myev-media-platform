import { Injectable, NotFoundException } from "@nestjs/common";
import { assertOrdinaryRetryAllowed, assertPublicationTargetTransition } from "@myev/shared";
import type { BackgroundJob, PublicationTarget } from "../../../generated/prisma";
import { BackgroundJobsService } from "../background-jobs/background-jobs.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { translatePublishingDomainError } from "./publishing-error-translation";
import { PUBLISHING_ERRORS } from "./publishing.errors";

interface RequestContext {
  ipAddress?: string;
}

/**
 * Module 9 Phase 9.3 — the service-level manual dispatch primitive
 * (Part H/P). No public HTTP endpoint exists yet (PUBLISH_EXECUTE will
 * gate a future user-facing "Publish now" API — a later phase); this is
 * the internal service a future controller calls directly, exercised
 * here by its own test suite in the meantime.
 *
 * `dispatchTarget()` transitions a PENDING or FAILED target to QUEUED
 * (via the shared domain guard — never a hand-rolled status check) and
 * creates its durable `publishing.execute.v1` BackgroundJob by calling
 * BackgroundJobsService.enqueue() directly, reusing its own battle-
 * tested idempotency-cache/fingerprint/replay logic rather than
 * re-implementing a simplified copy of it (the accepted trade-off
 * documented below). A double-dispatch cannot create a duplicate live
 * job for two independent reasons: (1) the second call's own
 * `assertPublicationTargetTransition(target.status, "QUEUED")` fails
 * once the first call has already moved the target to QUEUED
 * (QUEUED -> QUEUED is not a legal transition — Phase 9.1's frozen
 * table), and (2) even under a genuine race, BackgroundJob's own
 * (workspaceId, idempotencyKey) partial unique index is the final,
 * DB-enforced backstop `enqueue()` itself already relies on (Part K).
 *
 * Known limitation, matching AiJobSubmissionService.submit()'s own
 * documented trade-off exactly: the PublicationTarget transition
 * (committed here) and the BackgroundJob creation (`enqueue()`'s own,
 * separate transaction) are NOT one atomic unit — a crash between them
 * leaves a QUEUED target with no BackgroundJob. Chosen deliberately over
 * hand-rolling the BackgroundJob/BackgroundJobHistory rows inline (which
 * would achieve tighter atomicity but duplicate `enqueue()`'s own
 * meaningfully complex, already-correct idempotency/fingerprint/replay
 * logic) — reuse over duplication, consistent with this phase's own
 * "share business rules, duplicate only mechanical fetches" boundary.
 * A future hardening pass should reconcile stuck QUEUED targets with no
 * BackgroundJob, the same open item BackgroundJobsService.enqueue()'s
 * own doc comment already flags for its own callers.
 */
@Injectable()
export class PublishingDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly backgroundJobs: BackgroundJobsService,
  ) {}

  async dispatchTarget(workspaceId: string, actorUserId: string, targetPublicId: string, context: RequestContext = {}): Promise<{ target: PublicationTarget; job: BackgroundJob }> {
    const { target, workspacePublicId } = await this.prisma.$transaction(async (tx) => {
      const target = await tx.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId } });
      if (!target) {
        throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "Publication target not found." });
      }

      // Module 9 Phase 9.7 (Part Y) — checked BEFORE the ordinary
      // transition guard: a target whose last attempt had an ambiguous
      // external outcome (Facebook's non-idempotent publish call;
      // Instagram's unrecoverable-id race — see @myev/shared's
      // RECONCILIATION_REQUIRED_ERROR_CODES) must never be blindly
      // retried — only PublishingReconciliationService's own explicit
      // "confirm not published" action may clear this and re-enter this
      // exact same QUEUED transition.
      try {
        assertOrdinaryRetryAllowed(target.status, target.lastErrorCode);
      } catch (error) {
        translatePublishingDomainError(error);
      }

      try {
        assertPublicationTargetTransition(target.status, "QUEUED");
      } catch (error) {
        translatePublishingDomainError(error);
      }

      const updated = await tx.publicationTarget.update({
        where: { id: target.id },
        data: { status: "QUEUED", ...(target.status === "FAILED" ? { retryCount: { increment: 1 } } : {}) },
      });
      await tx.publishAttempt.create({
        data: { publicationTargetId: target.id, fromStatus: target.status, toStatus: "QUEUED", detail: { trigger: "manual_dispatch" } },
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLICATION_TARGET_STATUS_CHANGED",
        actorUserId,
        workspaceId,
        entityType: "publication_target",
        entityId: target.publicId,
        beforeState: { status: target.status },
        afterState: { status: "QUEUED" },
        ipAddress: context.ipAddress,
      });

      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { publicId: true } });
      return { target: updated, workspacePublicId: workspace.publicId };
    });

    // Generation-N idempotency key derived from the target's own
    // retryCount (Part R) — a manual re-dispatch attempt against the
    // SAME generation (e.g. a client retrying an ambiguous network
    // failure) replays the original BackgroundJob via enqueue()'s own
    // idempotency-cache/DB-constraint layers rather than creating a
    // second one; a genuinely NEW retry (FAILED -> QUEUED, retryCount
    // incremented above) mints the next generation's own distinct key.
    const idempotencyKey = `publishing:target:${target.publicId}:generation:${target.retryCount}`;

    const job = await this.backgroundJobs.enqueue({
      workspaceId,
      jobType: "publishing.execute.v1",
      payload: { workspacePublicId, publicationTargetPublicId: target.publicId },
      createdByUserId: actorUserId,
      idempotencyKey,
    });

    return { target, job };
  }

  /**
   * Cancel (Part Y): a legal-status-only transition to CANCELLED via the
   * shared domain guard (works from PENDING/SCHEDULED/QUEUED/FAILED,
   * rejected from PUBLISHED/already-CANCELLED). If a ScheduledJob exists
   * for this target (created at schedule time — see
   * PublishingPersistenceService.createPublication()'s own scheduling
   * branch), it is disabled in the same transaction so the schedule can
   * never fire a dispatch for a target that no longer wants one — full
   * history (the ScheduledJob row itself, every PublishAttempt) is
   * preserved, never deleted.
   */
  async cancelTarget(workspaceId: string, actorUserId: string, targetPublicId: string, context: RequestContext = {}): Promise<PublicationTarget> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId } });
      if (!target) {
        throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "Publication target not found." });
      }

      try {
        assertPublicationTargetTransition(target.status, "CANCELLED");
      } catch (error) {
        translatePublishingDomainError(error);
      }

      const updated = await tx.publicationTarget.update({ where: { id: target.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      await tx.publishAttempt.create({ data: { publicationTargetId: target.id, fromStatus: target.status, toStatus: "CANCELLED", detail: { trigger: "manual_cancel" } } });

      await tx.scheduledJob.updateMany({
        where: { workspaceId, jobType: "publishing.dispatch.v1", enabled: true, payloadMetadata: { path: ["publicationTargetPublicId"], equals: target.publicId } },
        data: { enabled: false },
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLICATION_TARGET_STATUS_CHANGED",
        actorUserId,
        workspaceId,
        entityType: "publication_target",
        entityId: target.publicId,
        beforeState: { status: target.status },
        afterState: { status: "CANCELLED" },
        ipAddress: context.ipAddress,
      });

      return updated;
    });
  }
}
