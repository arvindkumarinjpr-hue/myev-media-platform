import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { assertPublicationTargetTransition, PublishingDomainError } from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import type { Prisma } from "../../../api/generated/prisma";
import { isExpectedIdempotencyViolation } from "../scheduler/idempotency-violation";
import { PublishingDispatchQueueService } from "./publishing-dispatch-queue.service";

export interface PublishingDispatchOutcome {
  /** True only on a genuine new dispatch; false for an already-dispatched replay or an illegal/terminal target (both safe no-ops, never thrown). */
  dispatched: boolean;
}

/**
 * Module 9 Phase 9.3 — the worker-local counterpart to
 * SchedulerTickManager.dispatchOccurrence(), used by
 * PublishingDispatchProcessor (the `publishing.dispatch.v1` handler) to
 * transition a due SCHEDULED PublicationTarget to QUEUED and enqueue its
 * `publishing.execute.v1` execution job — mirroring that method's exact
 * shape (idempotency-key check, transactional row + BackgroundJob +
 * BackgroundJobHistory creation, then BullMQ dispatch with the same
 * compensating-write-on-failure pattern) rather than re-deriving it.
 *
 * Never calls a provider (Part S) — this class's only side effects are
 * the PublicationTarget transition and the new BackgroundJob it creates.
 */
@Injectable()
export class PublishingDispatchService {
  private readonly logger = new Logger(PublishingDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatchQueue: PublishingDispatchQueueService,
  ) {}

  async dispatchScheduledTarget(workspacePublicId: string, targetPublicId: string): Promise<PublishingDispatchOutcome> {
    const workspace = await this.prisma.workspace.findUnique({ where: { publicId: workspacePublicId }, select: { id: true } });
    if (!workspace) return { dispatched: false };
    const workspaceId = workspace.id;

    const target = await this.prisma.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId } });
    if (!target) return { dispatched: false };

    // Illegal/terminal source status (already dispatched, cancelled,
    // etc.) is a safe no-op, never an error — a redelivered or
    // duplicate-tick-originated dispatch job for an already-QUEUED
    // target must not fail the job, just decline to act again.
    try {
      assertPublicationTargetTransition(target.status, "QUEUED");
    } catch (err) {
      if (err instanceof PublishingDomainError) return { dispatched: false };
      throw err;
    }

    // Generation-N idempotency key derived from the target's own
    // retryCount (Part R) — stable across a redelivered dispatch attempt
    // for the exact same generation, distinct from the NEXT retry's key.
    const idempotencyKey = `publishing:target:${target.publicId}:generation:${target.retryCount}`;
    const payload = { workspacePublicId, publicationTargetPublicId: target.publicId };

    let jobRow: { id: string } | null = null;
    let replay = false;
    try {
      jobRow = await this.prisma.$transaction(async (tx) => {
        await tx.publicationTarget.update({ where: { id: target.id }, data: { status: "QUEUED" } });
        await tx.publishAttempt.create({
          data: { publicationTargetId: target.id, fromStatus: target.status, toStatus: "QUEUED", detail: { trigger: "scheduled_dispatch" } as Prisma.InputJsonValue },
        });
        const created = await tx.backgroundJob.create({
          data: {
            workspaceId,
            jobType: "publishing.execute.v1",
            queueName: "PUBLISHING",
            payloadMetadata: payload as unknown as Prisma.InputJsonValue,
            maxAttempts: 3,
            idempotencyKey,
            correlationId: randomUUID(),
          },
        });
        await tx.backgroundJobHistory.create({ data: { backgroundJobId: created.id, toStatus: "QUEUED" } });
        return created;
      });
    } catch (error) {
      if (isExpectedIdempotencyViolation(error, workspaceId)) {
        replay = true;
      } else {
        throw error;
      }
    }

    if (replay || !jobRow) return { dispatched: replay };

    try {
      await this.dispatchQueue.add("publishing.execute.v1", jobRow.id, payload);
    } catch (dispatchError) {
      // Known, documented limitation, matching BackgroundJobsService.enqueue()'s
      // and SchedulerTickManager.dispatchOccurrence()'s own accepted
      // trade-off exactly: best-effort compensation, not a full
      // transactional-outbox guarantee.
      this.logger.error({ err: dispatchError, jobId: jobRow.id }, "publishing dispatch failed after Postgres commit — compensating to failed");
      await this.prisma.backgroundJob
        .update({ where: { id: jobRow.id }, data: { status: "FAILED", failedAt: new Date(), errorCode: "ENQUEUE_DISPATCH_FAILED", errorMessageSafe: "Failed to dispatch job to the queue." } })
        .catch(() => undefined);
      throw dispatchError;
    }

    return { dispatched: true };
  }
}
