import { Injectable, NotFoundException } from "@nestjs/common";
import { derivePublicationSummary, type PublicationSummary } from "@myev/shared";
import { Prisma } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { ContentItemsService, type ContentActor } from "../content/content-items.service";
import { PublishingReconciliationService } from "./publishing-reconciliation.service";
import { PUBLISHING_ERRORS } from "./publishing.errors";

/**
 * Publishing candidate types (Part D/H of the Phase 9.7 authorization,
 * extended by Module 10 Phase 10.4 Part I). SOCIAL_POST is listable as a
 * candidate here — this is the "what content could I attempt to publish"
 * query only, independent of whether any configured channel account can
 * currently ACCEPT it (that is `derivePublishingReadiness`'s own,
 * separate `capabilities.supportedContentTypes` check — see Phase 10.4's
 * own completion report for why FACEBOOK/INSTAGRAM capabilities are
 * deliberately NOT extended in this phase). SHORT/REEL/NEWSLETTER remain
 * unsupported, matching the frontend's own CHANNEL_SUPPORTED_CONTENT_TYPES.
 */
const PUBLISHABLE_CONTENT_TYPES = ["BLOG", "VIDEO", "SOCIAL_POST"] as const;

export interface PublishableContentView {
  publicId: string;
  title: string;
  contentType: "BLOG" | "VIDEO" | "SOCIAL_POST";
}

const PUBLICATION_WITH_TARGETS = Prisma.validator<Prisma.PublicationDefaultArgs>()({
  include: {
    contentItem: { select: { publicId: true, title: true, contentType: true } },
    targets: { include: { channelAccount: { select: { channelType: true, displayName: true, publicId: true } } } },
  },
});
type PublicationWithTargets = Prisma.PublicationGetPayload<typeof PUBLICATION_WITH_TARGETS>;

// Module 9 Phase 9.7 (Part U) — the ONLY `PublishAttempt.detail` keys
// ever surfaced to an operator, and only when their value is a plain
// primitive (never a nested object — this alone excludes an encrypted
// checkpoint envelope's own `encrypted: {ciphertext, nonce, authTag,
// keyVersion}` shape even if "encrypted" were ever added to this list,
// which it deliberately is not). Every `detail` write site in this
// codebase already only ever writes curated, non-secret fields (see
// PublishingExecutionService's own doc comments) — this allowlist is a
// second, independent layer of defense, not the only one.
const SAFE_ATTEMPT_DETAIL_KEYS = ["errorCode", "classification", "externalContentId", "externalUrl", "reason", "note", "checkpointType"] as const;

function projectSafeAttemptDetail(detail: unknown): Record<string, string | number | boolean> | null {
  if (typeof detail !== "object" || detail === null) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const key of SAFE_ATTEMPT_DETAIL_KEYS) {
    const value = (detail as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface SafeAttemptView {
  attemptNumber: number;
  occurredAt: Date;
  fromStatus: string | null;
  toStatus: string;
  detail: Record<string, string | number | boolean> | null;
}

export interface PublicationTargetView {
  publicId: string;
  channelAccountPublicId: string;
  channelType: string;
  channelDisplayName: string;
  status: string;
  scheduledFor: Date | null;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  externalContentId: string | null;
  externalUrl: string | null;
  lastErrorCode: string | null;
  lastErrorMessageSafe: string | null;
  retryCount: number;
  /** Derived (Part V/W) — never a stored column; true only for a FAILED target whose lastErrorCode is one of the known ambiguous-external-outcome codes. */
  reconciliationRequired: boolean;
}

export interface PublicationListItemView {
  publicId: string;
  contentItemPublicId: string;
  contentTitle: string;
  contentType: string;
  requestedAt: Date;
  scheduledFor: Date | null;
  summary: PublicationSummary;
  targets: PublicationTargetView[];
}

/**
 * Module 9 Phase 9.7 (Part S/T/U) — read-only projections for the
 * Publishing dashboard/detail/attempt-history UI. Never persists an
 * aggregate Publication.status (Part S — reuses `derivePublicationSummary()`
 * at read time, exactly like the frozen Phase 9.1 design requires).
 */
@Injectable()
export class PublishingQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: PublishingReconciliationService,
    private readonly contentItems: ContentItemsService,
  ) {}

  /**
   * Staging UAT defect fix (Phase 9.8) — the publish flow's "select
   * content" step needs every APPROVED Blog/Video content item in the
   * workspace, not just the ones that happen to carry Module 6/7 pipeline
   * metadata. Queries ContentItemsService.list() directly (the same
   * generic, RBAC-enforced, workspace-isolated primitive
   * BlogService.list()/VideoService.list() already call internally)
   * rather than reusing their own pipeline-scoped list() methods, which
   * deliberately filter to `readPipelineState(metadata) !== null` for
   * THEIR OWN pipeline-management UIs — a real Approved item created
   * outside that pipeline (e.g. Module 8's own UAT fixture content) is
   * correctly excluded there, but must not be invisible to Publishing.
   */
  async listPublishableContent(workspaceId: string, actor: ContentActor): Promise<PublishableContentView[]> {
    const items = await this.contentItems.list({ id: workspaceId }, actor, { status: "APPROVED" });
    return items
      .filter((item): item is typeof item & { contentType: (typeof PUBLISHABLE_CONTENT_TYPES)[number] } =>
        (PUBLISHABLE_CONTENT_TYPES as readonly string[]).includes(item.contentType),
      )
      .map((item) => ({ publicId: item.publicId, title: item.title, contentType: item.contentType }));
  }

  async listPublications(workspaceId: string, filters: { status?: string; channelType?: string; contentType?: string } = {}): Promise<PublicationListItemView[]> {
    const publications = await this.prisma.publication.findMany({
      where: {
        workspaceId,
        ...(filters.contentType ? { contentItem: { contentType: filters.contentType as never } } : {}),
      },
      ...PUBLICATION_WITH_TARGETS,
      orderBy: { requestedAt: "desc" },
    });

    return publications
      .map((pub) => this.toListItemView(pub))
      .filter((item) => {
        if (filters.status && !item.targets.some((t) => t.status === filters.status)) return false;
        if (filters.channelType && !item.targets.some((t) => t.channelType === filters.channelType)) return false;
        return true;
      });
  }

  async getPublicationDetail(workspaceId: string, publicationPublicId: string): Promise<PublicationListItemView> {
    const pub = await this.prisma.publication.findFirst({ where: { workspaceId, publicId: publicationPublicId }, ...PUBLICATION_WITH_TARGETS });
    if (!pub) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "Publication not found." });
    }
    return this.toListItemView(pub);
  }

  async getTargetAttempts(workspaceId: string, targetPublicId: string): Promise<SafeAttemptView[]> {
    const target = await this.prisma.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId }, select: { id: true } });
    if (!target) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_TARGET_NOT_FOUND, message: "Publication target not found." });
    }
    const attempts = await this.prisma.publishAttempt.findMany({ where: { publicationTargetId: target.id }, orderBy: { occurredAt: "asc" } });
    return attempts.map((a, index) => ({
      attemptNumber: index + 1,
      occurredAt: a.occurredAt,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      detail: projectSafeAttemptDetail(a.detail),
    }));
  }

  private toListItemView(pub: PublicationWithTargets): PublicationListItemView {
    const targets: PublicationTargetView[] = pub.targets.map((t) => ({
      publicId: t.publicId,
      channelAccountPublicId: t.channelAccount.publicId,
      channelType: t.channelAccount.channelType,
      channelDisplayName: t.channelAccount.displayName,
      status: t.status,
      scheduledFor: pub.scheduledFor,
      publishedAt: t.publishedAt,
      cancelledAt: t.cancelledAt,
      externalContentId: t.externalContentId,
      externalUrl: t.externalUrl,
      lastErrorCode: t.lastErrorCode,
      lastErrorMessageSafe: t.lastErrorMessageSafe,
      retryCount: t.retryCount,
      reconciliationRequired: this.reconciliation.isAwaitingReconciliation(t.status, t.lastErrorCode),
    }));
    return {
      publicId: pub.publicId,
      contentItemPublicId: pub.contentItem.publicId,
      contentTitle: pub.contentItem.title,
      contentType: pub.contentItem.contentType,
      requestedAt: pub.requestedAt,
      scheduledFor: pub.scheduledFor,
      summary: derivePublicationSummary(targets.map((t) => t.status as never)),
      targets,
    };
  }
}
