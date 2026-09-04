import { Injectable } from "@nestjs/common";
import {
  derivePublishingReadiness,
  isPublishingCredentialExpired,
  resolveBlogPublishingContent,
  type PublishingChannelCapabilities,
  type PublishingReadinessFacts,
  type PublishingReadinessResult,
} from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import type { ContentType, PublishingChannelType, VideoTargetPlatform } from "../../../api/generated/prisma";
import { PublishingProviderNotConfiguredError, PublishingProviderResolverService, type ResolvedPublishingChannelContext } from "./publishing-provider-resolver.service";

export class PublishingContentItemNotFoundError extends Error {}

/**
 * Module 9 Phase 9.6 — the one, deterministic VideoTargetPlatform each
 * Reel-shaped channel requires (EXPORT_PROFILES defines exactly one 9:16
 * profile per channel — FACEBOOK_REEL/INSTAGRAM_REEL — so there is no
 * ambiguity to resolve via a stored per-account preference). Channels not
 * listed here (YOUTUBE, or a future non-Reel channel) keep the original,
 * platform-unscoped "most recent render" query.
 */
const REEL_TARGET_PLATFORM_BY_CHANNEL: Partial<Record<PublishingChannelType, VideoTargetPlatform>> = {
  FACEBOOK: "FACEBOOK_REEL",
  INSTAGRAM: "INSTAGRAM_REEL",
};

/** Mechanically extracts `body.blogDraft` off a fetched ContentVersion's opaque Json `body` — the ONE narrowing step `resolveBlogPublishingContent()`'s own doc comment expects its caller to already have done. Never interprets the extracted value further; that is `parseBlogPublishingDraft()`'s (packages/shared) job alone. */
function extractBlogDraft(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>).blogDraft;
}

/** Narrows VideoScript.tags (opaque Json?) into `string[] | null` — never invents/generates tags, only structurally validates what the Video SEO stage already wrote. */
function parseVideoTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const tags = raw.filter((t): t is string => typeof t === "string");
  return tags.length > 0 ? tags : null;
}

interface ContentItemForReadiness {
  id: string;
  contentType: ContentType;
  status: string;
  deletedAt: Date | null;
  title: string;
  metadata: unknown;
  currentVersionId: string | null;
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
      select: { id: true, contentType: true, status: true, deletedAt: true, title: true, metadata: true, currentVersionId: true },
    });
    if (!contentItem) throw new PublishingContentItemNotFoundError("Content item not found.");

    const { channelContext, capabilities } = await this.resolveChannelForReadiness(workspaceId, channelAccountPublicId);
    const baseFacts = this.buildBaseFacts(contentItem);

    if (!channelContext || !capabilities) {
      return derivePublishingReadiness(baseFacts, null);
    }

    const connectionHealthResult = await this.buildConnectionHealthResult(workspaceId, channelAccountPublicId, channelContext);
    const contentTypeFacts = await this.buildContentTypeFacts(workspaceId, contentItem, channelContext.channelType);

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
      // Overridden for BLOG in buildContentTypeFacts(); true by default
      // since this fact is meaningless (never checked) for other content
      // types — never a silent false-negative there.
      blogPublishingContentAvailable: true,
      videoLatestRenderStatus: null,
      videoOutputMediaAssetPublicId: null,
      videoOutputMediaAssetStatus: null,
      videoMetaDescription: null,
      videoTags: null,
      metadataDescription: publishingMetadata.description,
      metadataTags: publishingMetadata.tags,
      metadataCaption: publishingMetadata.caption,
      metadataPrivacy: publishingMetadata.privacy,
    };
  }

  private async buildContentTypeFacts(workspaceId: string, contentItem: ContentItemForReadiness, channelType: PublishingChannelType): Promise<Partial<PublishingReadinessFacts>> {
    if (contentItem.contentType === "BLOG") {
      const blogArticle = await this.prisma.blogArticle.findFirst({ where: { workspaceId, contentItemId: contentItem.id }, select: { metaDescription: true } });
      const blogPublishingContentAvailable = await this.resolveBlogPublishingContentAvailable(contentItem.currentVersionId);
      return { blogArticleExists: blogArticle !== null, blogMetaDescription: blogArticle?.metaDescription ?? null, blogPublishingContentAvailable };
    }
    if (contentItem.contentType === "VIDEO") {
      // Module 9 Phase 9.6 research finding: a workspace may render the
      // SAME ContentItem for more than one VideoTargetPlatform (e.g. a
      // 1920x1080 YOUTUBE_LONG render and a 1080x1920 INSTAGRAM_REEL
      // render both exist for the same ContentItem — EXPORT_PROFILES
      // already defines a distinct 9:16 profile for FACEBOOK_REEL/
      // INSTAGRAM_REEL). Handing Instagram/Facebook whichever render
      // merely happens to be the most recent (regardless of its own
      // target platform) risks publishing a wrong-aspect-ratio video that
      // Reels' own API rejects. For those two channels, the "latest
      // render" query is scoped to the platform-matched render only —
      // for every other channel (YouTube, or a future non-Reel-shaped
      // channel), this is byte-for-byte the original, unscoped query
      // (Part AH: no behavioral change to the already-shipped YouTube
      // connector).
      const requiredTargetPlatform = REEL_TARGET_PLATFORM_BY_CHANNEL[channelType];
      const [latestRenderJob, videoScript] = await Promise.all([
        this.prisma.videoRenderJob.findFirst({
          where: { workspaceId, contentItemId: contentItem.id, ...(requiredTargetPlatform ? { targetPlatform: requiredTargetPlatform } : {}) },
          orderBy: { createdAt: "desc" },
          select: { status: true, outputMediaAssetPublicId: true },
        }),
        this.prisma.videoScript.findFirst({ where: { workspaceId, contentItemId: contentItem.id }, select: { metaDescription: true, tags: true } }),
      ]);
      const videoContentTypeFacts = { videoMetaDescription: videoScript?.metaDescription ?? null, videoTags: parseVideoTags(videoScript?.tags) };
      if (!latestRenderJob) return { videoLatestRenderStatus: null, ...videoContentTypeFacts };
      const mediaAsset = latestRenderJob.outputMediaAssetPublicId
        ? await this.prisma.mediaAsset.findFirst({ where: { workspaceId, publicId: latestRenderJob.outputMediaAssetPublicId }, select: { status: true } })
        : null;
      return {
        videoLatestRenderStatus: latestRenderJob.status,
        videoOutputMediaAssetPublicId: latestRenderJob.outputMediaAssetPublicId,
        videoOutputMediaAssetStatus: mediaAsset?.status ?? null,
        ...videoContentTypeFacts,
      };
    }
    return {};
  }

  /**
   * Module 9 Phase 9.4 — the mechanical half of BLOG_PUBLISHING_CONTENT_MISSING:
   * fetch the current ContentVersion's opaque `body` and hand it to
   * `resolveBlogPublishingContent()` (packages/shared), the ONE place the
   * blogDraft -> HTML rendering rules live. This service never inspects
   * `body`'s shape itself.
   */
  private async resolveBlogPublishingContentAvailable(currentVersionId: string | null): Promise<boolean> {
    if (!currentVersionId) return false;
    const version = await this.prisma.contentVersion.findFirst({ where: { id: currentVersionId }, select: { body: true } });
    if (!version) return false;
    return resolveBlogPublishingContent(extractBlogDraft(version.body)) !== null;
  }

  private readPublishingMetadataBag(raw: unknown): { description?: string; tags?: string[]; caption?: string; privacy?: string } {
    if (typeof raw !== "object" || raw === null) return {};
    const bag = (raw as Record<string, unknown>).publishing;
    if (typeof bag !== "object" || bag === null) return {};
    const { description, tags, caption, privacy } = bag as Record<string, unknown>;
    return {
      description: typeof description === "string" ? description : undefined,
      tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : undefined,
      caption: typeof caption === "string" ? caption : undefined,
      privacy: typeof privacy === "string" ? privacy : undefined,
    };
  }
}
