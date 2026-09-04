import { Injectable } from "@nestjs/common";
import { derivePublishingReadiness, isPublishingCredentialExpired, type PublishingChannelCapabilities, type PublishingReadinessFacts, type PublishingReadinessResult } from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import type { ContentType } from "../../../api/generated/prisma";
import { PublishingProviderNotConfiguredError, PublishingProviderResolverService, type ResolvedPublishingChannelContext } from "./publishing-provider-resolver.service";

export class PublishingContentItemNotFoundError extends Error {}

interface ContentItemForReadiness {
  id: string;
  contentType: ContentType;
  status: string;
  deletedAt: Date | null;
  title: string;
  metadata: unknown;
}

/**
 * Module 9 Phase 9.3 — this worker process's own thin adapter over
 * `@myev/shared`'s `derivePublishingReadiness()`, mirroring apps/api's
 * identically-named service exactly. Fetches the same facts via its own
 * (worker-core) PrismaService and hands them to the identical shared
 * decision function — the execution-time readiness re-check (Part O)
 * this phase's execution service performs immediately before ever
 * calling a provider.
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
    if (!contentItem) throw new PublishingContentItemNotFoundError("Content item not found.");

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

  private async resolveChannelForReadiness(
    workspaceId: string,
    channelAccountPublicId: string,
  ): Promise<{ channelContext: ResolvedPublishingChannelContext | null; capabilities: PublishingChannelCapabilities | null }> {
    try {
      const channelContext = await this.resolver.resolveChannelContext(workspaceId, channelAccountPublicId);
      return { channelContext, capabilities: channelContext.provider.getCapabilities() };
    } catch (err) {
      if (err instanceof PublishingProviderNotConfiguredError) {
        return { channelContext: null, capabilities: null };
      }
      // PublishingChannelAccountNotFoundError (the target doesn't exist
      // in this workspace) and anything unexpected both propagate — a
      // hard failure, same convention as apps/api's own resolver.
      throw err;
    }
  }

  private async buildConnectionHealthResult(workspaceId: string, channelAccountPublicId: string, channelContext: ResolvedPublishingChannelContext) {
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
