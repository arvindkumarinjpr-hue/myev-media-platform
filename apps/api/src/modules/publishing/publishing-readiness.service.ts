import { HttpException, Injectable, NotFoundException } from "@nestjs/common";
import type { ContentType } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { PublishingProviderResolverService } from "./publishing-provider-resolver.service";
import { PUBLISHING_READINESS_REASONS, type PublishingReadinessMetadata, type PublishingReadinessReasonCode, type PublishingReadinessResult } from "./publishing-readiness.types";
import { PUBLISHING_ERRORS } from "./publishing.errors";
import type { PublishingChannelCapabilities } from "./publishing-provider.interface";

/** True iff `err` is one of this module's own typed HTTP exceptions carrying the given `{ code }` payload — never inspects a raw Prisma/crypto error. */
function isPublishingErrorCode(err: unknown, code: string): boolean {
  if (!(err instanceof HttpException)) return false;
  const response = err.getResponse();
  return typeof response === "object" && response !== null && (response as Record<string, unknown>).code === code;
}

interface ContentItemForReadiness {
  id: string;
  contentType: ContentType;
  status: string;
  deletedAt: Date | null;
  title: string;
  metadata: unknown;
}

/**
 * Module 9 Phase 9.2 — evaluates whether a content item is ready to
 * publish to a specific channel account, before any PublicationTarget
 * is ever created. Purely a read: creates zero Publication/
 * PublicationTarget/PublishAttempt/BackgroundJob/ScheduledJob rows, and
 * never mutates ContentItem/Blog/Video/Module 8 state (Part Q).
 *
 * Video readiness deliberately reuses Phase 9.1's own coarser guarantee
 * (latest VideoRenderJob.status === COMPLETED + an ACTIVE output
 * MediaAsset) rather than Module 7's private scriptVersionHash/
 * sceneAssetFingerprint drift check — that logic lives inside
 * VideoRenderService's own private reconcileWithin() and requires a
 * fully-materialized VideoPipelineState that cannot be cheaply
 * reconstructed from outside Module 7. Reusing it would require either
 * a Module 7 change or re-deriving its internals — both out of bounds
 * for this phase. Staleness detection (script changed after a
 * COMPLETED render) is a known, accepted gap, not fixed here.
 */
@Injectable()
export class PublishingReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PublishingProviderResolverService,
  ) {}

  async evaluateReadiness(workspaceId: string, contentItemPublicId: string, channelAccountPublicId: string): Promise<PublishingReadinessResult> {
    const contentItem = await this.prisma.contentItem.findFirst({
      where: { workspaceId, publicId: contentItemPublicId },
      select: { id: true, contentType: true, status: true, deletedAt: true, title: true, metadata: true },
    });
    if (!contentItem) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CONTENT_ITEM_NOT_FOUND, message: "Content item not found." });
    }

    const blockingReasons: PublishingReadinessReasonCode[] = [];
    const warnings: PublishingReadinessReasonCode[] = [];

    // Resolving the channel account itself not existing in this
    // workspace is a hard failure (the caller asked about a target that
    // doesn't exist), same convention as every other workspace-scoped
    // lookup. A channel type with no registered provider is different:
    // Part C requires readiness to *prove* "provider-not-configured
    // behavior" as part of its own graceful result, never a crash — so
    // that one specific outcome is caught here and folded into
    // blockingReasons instead of propagating as an exception. Every
    // capability-dependent check below is skipped in that case (there
    // is no provider to ask).
    let channelContext: Awaited<ReturnType<PublishingProviderResolverService["resolveChannelContext"]>> | null = null;
    try {
      channelContext = await this.resolver.resolveChannelContext(workspaceId, channelAccountPublicId);
    } catch (err) {
      if (isPublishingErrorCode(err, PUBLISHING_ERRORS.PUBLISHING_PROVIDER_NOT_CONFIGURED)) {
        blockingReasons.push(PUBLISHING_READINESS_REASONS.PROVIDER_NOT_CONFIGURED);
      } else {
        throw err;
      }
    }

    if (contentItem.deletedAt !== null) {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.CONTENT_DELETED);
    } else if (contentItem.status !== "APPROVED") {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.CONTENT_NOT_APPROVED);
    }

    let resolvedArtifact: { mediaAssetPublicId: string } | null = null;
    let metadata: PublishingReadinessMetadata = { title: contentItem.title || undefined };

    // Every capability-dependent check requires a resolved provider —
    // skipped entirely when PROVIDER_NOT_CONFIGURED already fired above
    // (no capabilities exist to check against, and Part I promises "no
    // external provider call required," which a missing provider can't
    // satisfy anyway).
    if (channelContext) {
      const capabilities = channelContext.provider.getCapabilities();

      if (!capabilities.supportedContentTypes.includes(contentItem.contentType)) {
        blockingReasons.push(PUBLISHING_READINESS_REASONS.CHANNEL_NOT_SUPPORTED);
      }

      await this.evaluateConnectionHealth(workspaceId, channelAccountPublicId, channelContext, blockingReasons);

      if (contentItem.contentType === "VIDEO" && capabilities.requiresRenderedMedia) {
        resolvedArtifact = await this.evaluateVideoRenderReadiness(workspaceId, contentItem.id, blockingReasons);
      } else if (contentItem.contentType === "BLOG") {
        await this.evaluateBlogReadiness(workspaceId, contentItem, blockingReasons);
      }

      metadata = await this.resolvePlatformMetadata(workspaceId, contentItem, capabilities, blockingReasons);
    }

    return { ready: blockingReasons.length === 0, blockingReasons, warnings, resolvedArtifact, metadata };
  }

  private async evaluateConnectionHealth(
    workspaceId: string,
    channelAccountPublicId: string,
    channelContext: { connectionStatus: string; tokenExpiresAt: Date | null },
    blockingReasons: PublishingReadinessReasonCode[],
  ): Promise<void> {
    if (channelContext.connectionStatus !== "CONNECTED") {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.CHANNEL_ACCOUNT_NOT_CONNECTED);
      return;
    }
    // Cheap, decrypt-free short-circuit: an obviously expired token
    // never needs the credential decrypted at all.
    if (channelContext.tokenExpiresAt !== null && channelContext.tokenExpiresAt.getTime() <= Date.now()) {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.CREDENTIAL_EXPIRED);
      return;
    }
    const connectionResult = await this.resolver.validateConnection(workspaceId, channelAccountPublicId);
    if (!connectionResult.healthy) {
      blockingReasons.push(this.mapConnectionReason(connectionResult.reasonCode));
    }
  }

  private mapConnectionReason(reasonCode?: string): PublishingReadinessReasonCode {
    switch (reasonCode) {
      case "CREDENTIAL_EXPIRED":
        return PUBLISHING_READINESS_REASONS.CREDENTIAL_EXPIRED;
      case "CREDENTIAL_REVOKED":
      case "CREDENTIAL_INVALID":
        return PUBLISHING_READINESS_REASONS.CREDENTIAL_INVALID;
      case "PROVIDER_UNAVAILABLE":
      default:
        return PUBLISHING_READINESS_REASONS.CREDENTIAL_UNAVAILABLE;
    }
  }

  /**
   * Blog: BlogArticle row exists. A "current body/version exists" check
   * was deliberately NOT added here: Module 1E's own deferred DB trigger
   * already guarantees `ContentItem.currentVersionId` is never null for
   * a non-deleted row at commit (confirmed live — attempting to null it
   * directly raises a real Postgres constraint violation, not merely a
   * theoretical guarantee) — BLOG_CONTENT_MISSING would be permanently
   * dead code. Module 8 ACCEPTED links are never consulted — irrelevant
   * to publish readiness by design.
   */
  private async evaluateBlogReadiness(workspaceId: string, contentItem: ContentItemForReadiness, blockingReasons: PublishingReadinessReasonCode[]): Promise<void> {
    const blogArticle = await this.prisma.blogArticle.findFirst({
      where: { workspaceId, contentItemId: contentItem.id },
      select: { id: true },
    });
    if (!blogArticle) {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.BLOG_ARTICLE_MISSING);
    }
  }

  /** Video: reuses Phase 9.1's coarser render-readiness primitive — see this class's own doc comment for why the deeper Module 7 currentness check is not reused here. */
  private async evaluateVideoRenderReadiness(workspaceId: string, contentItemId: string, blockingReasons: PublishingReadinessReasonCode[]): Promise<{ mediaAssetPublicId: string } | null> {
    const latestRenderJob = await this.prisma.videoRenderJob.findFirst({
      where: { workspaceId, contentItemId },
      orderBy: { createdAt: "desc" },
      select: { status: true, outputMediaAssetPublicId: true },
    });
    if (!latestRenderJob || latestRenderJob.status !== "COMPLETED") {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.RENDER_NOT_READY);
      return null;
    }
    if (!latestRenderJob.outputMediaAssetPublicId) {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.MEDIA_ASSET_MISSING);
      return null;
    }

    const mediaAsset = await this.prisma.mediaAsset.findFirst({
      where: { workspaceId, publicId: latestRenderJob.outputMediaAssetPublicId },
      select: { status: true, publicId: true },
    });
    if (!mediaAsset) {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.MEDIA_ASSET_MISSING);
      return null;
    }
    if (mediaAsset.status !== "ACTIVE") {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.MEDIA_ASSET_INELIGIBLE);
      return null;
    }
    return { mediaAssetPublicId: mediaAsset.publicId };
  }

  /**
   * Pre-written metadata pass-through only — never generated or
   * optimized here (Module 10 owns social/caption intelligence, Part
   * L). Title always comes from ContentItem.title (a required field).
   * Description comes from BlogArticle.metaDescription for BLOG.
   * Tags/caption/privacy have no dedicated column on any content model
   * yet, so they are read from ContentItem's own existing generic
   * `metadata` JSON bag under a `publishing` namespace
   * (`metadata.publishing.{tags,caption,privacy,description}`) —
   * reusing the escape hatch Module 1E's own schema comment already
   * establishes ("generic, type-agnostic bag") rather than adding new
   * columns (no migration is authorized in this phase — Part Y).
   */
  private async resolvePlatformMetadata(
    workspaceId: string,
    contentItem: ContentItemForReadiness,
    capabilities: PublishingChannelCapabilities,
    blockingReasons: PublishingReadinessReasonCode[],
  ): Promise<PublishingReadinessMetadata> {
    const publishingMetadata = this.readPublishingMetadataBag(contentItem.metadata);

    let description: string | undefined = publishingMetadata.description;
    if (contentItem.contentType === "BLOG") {
      const blogArticle = await this.prisma.blogArticle.findFirst({
        where: { workspaceId, contentItemId: contentItem.id },
        select: { metaDescription: true },
      });
      description = blogArticle?.metaDescription ?? description;
    }

    const metadata: PublishingReadinessMetadata = {
      title: contentItem.title || undefined,
      description,
      tags: publishingMetadata.tags,
      caption: publishingMetadata.caption,
    };

    const alreadyMissing = blockingReasons.includes(PUBLISHING_READINESS_REASONS.REQUIRED_METADATA_MISSING);
    if (!alreadyMissing) {
      const missingTitle = capabilities.requiresTitle && !metadata.title;
      const missingDescription = capabilities.requiresDescription && !metadata.description;
      if (missingTitle || missingDescription) {
        blockingReasons.push(PUBLISHING_READINESS_REASONS.REQUIRED_METADATA_MISSING);
      }
    }

    return metadata;
  }

  private readPublishingMetadataBag(raw: unknown): { description?: string; tags?: string[]; caption?: string } {
    if (typeof raw !== "object" || raw === null) return {};
    const bag = (raw as Record<string, unknown>).publishing;
    if (typeof bag !== "object" || bag === null) return {};
    const { description, tags, caption } = bag as Record<string, unknown>;
    return {
      description: typeof description === "string" ? description : undefined,
      tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : undefined,
      caption: typeof caption === "string" ? caption : undefined,
    };
  }
}
