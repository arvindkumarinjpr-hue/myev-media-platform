import { HttpException, Injectable, NotFoundException } from "@nestjs/common";
import {
  derivePublishingReadiness,
  isPublishingCredentialExpired,
  type PublishingChannelCapabilities,
  type PublishingConnectionValidationResult,
  type PublishingReadinessFacts,
  type PublishingReadinessResult,
} from "@myev/shared";
import type { ContentType } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { PublishingProviderResolverService, type ResolvedPublishingChannelContext } from "./publishing-provider-resolver.service";
import { PUBLISHING_ERRORS } from "./publishing.errors";

interface ContentItemForReadiness {
  id: string;
  contentType: ContentType;
  status: string;
  deletedAt: Date | null;
  title: string;
  metadata: unknown;
}

/** True iff `err` is one of this module's own typed HTTP exceptions carrying the given `{ code }` payload — never inspects a raw Prisma/crypto error. */
function isPublishingErrorCode(err: unknown, code: string): boolean {
  if (!(err instanceof HttpException)) return false;
  const response = err.getResponse();
  return typeof response === "object" && response !== null && (response as Record<string, unknown>).code === code;
}

/**
 * Module 9 Phase 9.2/9.3 — the apps/api thin adapter over `@myev/shared`'s
 * `derivePublishingReadiness()` (Phase 9.3 Milestone A extraction). This
 * class's only remaining job is the mechanical part: fetch ContentItem/
 * BlogArticle/VideoRenderJob/MediaAsset facts via its own PrismaService,
 * resolve the channel/provider/connection-health facts via
 * PublishingProviderResolverService, assemble the plain
 * `PublishingReadinessFacts` object, and hand it to the shared pure
 * decision function — never re-implementing any part of the decision
 * tree itself. apps/worker's own equivalent adapter performs the exact
 * same mechanical steps against its own PrismaService and calls the
 * identical shared function.
 *
 * Purely a read: creates zero Publication/PublicationTarget/
 * PublishAttempt/BackgroundJob/ScheduledJob rows and mutates nothing.
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

    const { channelContext, capabilities } = await this.resolveChannelForReadiness(workspaceId, channelAccountPublicId);
    const baseFacts = this.buildBaseFacts(contentItem);

    if (!channelContext || !capabilities) {
      return derivePublishingReadiness(baseFacts, null);
    }

    const connectionHealthResult = await this.buildConnectionHealthResult(workspaceId, channelAccountPublicId, channelContext);
    const contentTypeFacts = await this.buildContentTypeFacts(workspaceId, contentItem);

    const facts: PublishingReadinessFacts = {
      ...baseFacts,
      channelConnectionStatus: channelContext.connectionStatus,
      channelTokenExpiresAt: channelContext.tokenExpiresAt,
      connectionHealthResult,
      ...contentTypeFacts,
    };

    return derivePublishingReadiness(facts, capabilities);
  }

  /**
   * Resolving the channel account itself not existing in this workspace
   * is a hard failure (the caller asked about a target that doesn't
   * exist), same convention as every other workspace-scoped lookup. A
   * channel type with no registered provider is different: readiness
   * must *prove* "provider-not-configured behavior" as part of its own
   * graceful result, never a crash — so that one specific outcome is
   * caught here and folded into `capabilities: null` instead of
   * propagating as an exception.
   */
  private async resolveChannelForReadiness(
    workspaceId: string,
    channelAccountPublicId: string,
  ): Promise<{ channelContext: ResolvedPublishingChannelContext | null; capabilities: PublishingChannelCapabilities | null }> {
    try {
      const channelContext = await this.resolver.resolveChannelContext(workspaceId, channelAccountPublicId);
      return { channelContext, capabilities: channelContext.provider.getCapabilities() };
    } catch (err) {
      if (isPublishingErrorCode(err, PUBLISHING_ERRORS.PUBLISHING_PROVIDER_NOT_CONFIGURED)) {
        return { channelContext: null, capabilities: null };
      }
      throw err;
    }
  }

  /** Mirrors `isPublishingCredentialExpired`'s own doc comment: skip the decrypt-and-call-provider step entirely for an already-known-expired credential — the shared decision function re-derives the same CREDENTIAL_EXPIRED classification from `channelTokenExpiresAt` regardless, so this is a security/performance optimization only, never a behavior fork. */
  private async buildConnectionHealthResult(
    workspaceId: string,
    channelAccountPublicId: string,
    channelContext: ResolvedPublishingChannelContext,
  ): Promise<PublishingConnectionValidationResult | null> {
    if (channelContext.connectionStatus !== "CONNECTED" || isPublishingCredentialExpired(channelContext.tokenExpiresAt)) {
      return null;
    }
    return this.resolver.validateConnection(workspaceId, channelAccountPublicId);
  }

  private buildBaseFacts(contentItem: ContentItemForReadiness): PublishingReadinessFacts {
    const publishingMetadata = this.readPublishingMetadataBag(contentItem.metadata);
    return {
      contentType: contentItem.contentType,
      contentStatus: contentItem.status,
      contentDeletedAt: contentItem.deletedAt,
      contentTitle: contentItem.title,
      channelConnectionStatus: "ERROR",
      channelTokenExpiresAt: null,
      connectionHealthResult: null,
      blogArticleExists: false,
      blogMetaDescription: null,
      videoLatestRenderStatus: null,
      videoOutputMediaAssetPublicId: null,
      videoOutputMediaAssetStatus: null,
      metadataDescription: publishingMetadata.description,
      metadataTags: publishingMetadata.tags,
      metadataCaption: publishingMetadata.caption,
    };
  }

  private async buildContentTypeFacts(workspaceId: string, contentItem: ContentItemForReadiness): Promise<Partial<PublishingReadinessFacts>> {
    if (contentItem.contentType === "BLOG") {
      const blogArticle = await this.prisma.blogArticle.findFirst({ where: { workspaceId, contentItemId: contentItem.id }, select: { metaDescription: true } });
      return { blogArticleExists: blogArticle !== null, blogMetaDescription: blogArticle?.metaDescription ?? null };
    }
    if (contentItem.contentType === "VIDEO") {
      const latestRenderJob = await this.prisma.videoRenderJob.findFirst({
        where: { workspaceId, contentItemId: contentItem.id },
        orderBy: { createdAt: "desc" },
        select: { status: true, outputMediaAssetPublicId: true },
      });
      if (!latestRenderJob) return { videoLatestRenderStatus: null };
      const mediaAsset = latestRenderJob.outputMediaAssetPublicId
        ? await this.prisma.mediaAsset.findFirst({ where: { workspaceId, publicId: latestRenderJob.outputMediaAssetPublicId }, select: { status: true } })
        : null;
      return {
        videoLatestRenderStatus: latestRenderJob.status,
        videoOutputMediaAssetPublicId: latestRenderJob.outputMediaAssetPublicId,
        videoOutputMediaAssetStatus: mediaAsset?.status ?? null,
      };
    }
    return {};
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
