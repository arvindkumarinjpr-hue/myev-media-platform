import { randomUUID } from "crypto";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Publication, type PublicationTarget, type PublicationTargetStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { assertContentPublishEligible, assertPublicationTargetTransition } from "./publishing-domain";
import { PUBLISHING_ERRORS } from "./publishing.errors";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

// Mirrors InternalLinksService's own isActivePairConflict — the partial
// unique index on (workspace_id, content_item_id, channel_account_id)
// WHERE status is live is the DB-level concurrency authority (Part M);
// this is what a caught violation of it is mapped to, never leaked as a
// raw Prisma/Postgres error.
function isLiveTargetConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION;
}

interface CreatePublicationInput {
  contentItemPublicId: string;
  channelAccountPublicIds: string[];
  scheduledFor?: Date;
}

interface RequestContext {
  ipAddress?: string;
}

/**
 * Module 9 Phase 9.1 — Publishing / Content Distribution Engine, domain +
 * persistence foundation.
 *
 * Deliberately narrow, mirroring InternalLinksService's own Phase 8.1
 * scope exactly: this service only creates a Publication + its
 * PublicationTarget rows and records target-status transitions — it
 * never talks to a real channel provider, never resolves/uploads a
 * media artifact, never schedules a worker job, and has no HTTP
 * controller in this phase (Architecture Checkpoint's own Phase 9.1
 * scope / Part U). Actual publish execution, provider connectors, and
 * scheduling are later phases.
 *
 * `createPublication()` never supersedes an existing live target for a
 * (content item, channel account) pair — it is a plain insert, race-safe
 * via the DB's own partial unique index (caught and mapped to a typed
 * conflict, see isLiveTargetConflict).
 */
@Injectable()
export class PublishingPersistenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createPublication(workspaceId: string, actorUserId: string, input: CreatePublicationInput, context: RequestContext = {}): Promise<{ publication: Publication; targets: PublicationTarget[] }> {
    return this.prisma.$transaction(async (tx) => {
      const contentItem = await tx.contentItem.findFirst({
        where: { workspaceId, publicId: input.contentItemPublicId },
        select: { id: true, contentType: true, status: true, deletedAt: true },
      });
      if (!contentItem) {
        throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CONTENT_ITEM_NOT_FOUND, message: "Content item not found." });
      }

      // Video-only context: the highest-priority render job for this
      // content item. See publishing-domain.ts's own doc comment on why
      // this stops at COMPLETED-or-not rather than re-deriving Module
      // 7's full render-currentness hash check.
      let latestVideoRenderJobStatus = null;
      if (contentItem.contentType === "VIDEO") {
        const latestRenderJob = await tx.videoRenderJob.findFirst({
          where: { contentItemId: contentItem.id },
          orderBy: { createdAt: "desc" },
          select: { status: true },
        });
        latestVideoRenderJobStatus = latestRenderJob?.status ?? null;
      }

      assertContentPublishEligible({
        contentType: contentItem.contentType,
        status: contentItem.status,
        deletedAt: contentItem.deletedAt,
        latestVideoRenderJobStatus,
      });

      const channelAccounts = await tx.publishingChannelAccount.findMany({
        where: { workspaceId, publicId: { in: input.channelAccountPublicIds } },
        select: { id: true, publicId: true },
      });
      if (channelAccounts.length !== input.channelAccountPublicIds.length) {
        throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND, message: "One or more channel accounts were not found in this workspace." });
      }

      const publication = await tx.publication.create({
        data: {
          workspaceId,
          contentItemId: contentItem.id,
          requestedById: actorUserId,
          scheduledFor: input.scheduledFor ?? null,
        },
      });

      const targets: PublicationTarget[] = [];
      for (const account of channelAccounts) {
        try {
          const target = await tx.publicationTarget.create({
            data: {
              workspaceId,
              publicationId: publication.id,
              contentItemId: contentItem.id,
              channelAccountId: account.id,
              // Generation-1 idempotency key for this target's first
              // attempt — a later phase's retry logic mints its own
              // "generation N" key per retry, never reusing this one
              // (Part N: distinguishes request idempotency from
              // per-attempt execution idempotency).
              idempotencyKey: `publish:${publication.publicId}:${account.publicId}:${randomUUID()}`,
            },
          });
          targets.push(target);
        } catch (error) {
          if (isLiveTargetConflict(error)) {
            throw new ConflictException({
              code: PUBLISHING_ERRORS.PUBLISHING_LIVE_TARGET_EXISTS,
              message: "A live (not yet published, failed, or cancelled) publication already exists for this content item on this channel account.",
            });
          }
          throw error;
        }
      }

      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLICATION_CREATED",
        actorUserId,
        workspaceId,
        entityType: "publication",
        entityId: publication.publicId,
        afterState: { contentItemPublicId: input.contentItemPublicId, channelAccountCount: targets.length },
        ipAddress: context.ipAddress,
      });

      return { publication, targets };
    });
  }

  async transitionTarget(workspaceId: string, targetPublicId: string, toStatus: PublicationTargetStatus, detail: Record<string, unknown> | null = null): Promise<PublicationTarget> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId } });
      if (!target) {
        throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "Publication target not found." });
      }

      assertPublicationTargetTransition(target.status, toStatus);

      const updated = await tx.publicationTarget.update({
        where: { id: target.id },
        data: {
          status: toStatus,
          ...(toStatus === "PUBLISHED" ? { publishedAt: new Date() } : {}),
          ...(toStatus === "CANCELLED" ? { cancelledAt: new Date() } : {}),
          ...(toStatus === "QUEUED" && target.status === "FAILED" ? { retryCount: { increment: 1 } } : {}),
        },
      });

      // Append-only history — never an update to a prior row (Part O).
      await tx.publishAttempt.create({
        data: {
          publicationTargetId: target.id,
          fromStatus: target.status,
          toStatus,
          detail: detail as Prisma.InputJsonValue | undefined,
        },
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLICATION_TARGET_STATUS_CHANGED",
        workspaceId,
        entityType: "publication_target",
        entityId: target.publicId,
        beforeState: { status: target.status },
        afterState: { status: toStatus },
      });

      return updated;
    });
  }

  async findTarget(workspaceId: string, targetPublicId: string): Promise<PublicationTarget> {
    const target = await this.prisma.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId } });
    if (!target) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "Publication target not found." });
    }
    return target;
  }
}
