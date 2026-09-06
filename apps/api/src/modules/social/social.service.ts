import { randomUUID } from "crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { containsUrl, normalizeHashtags } from "@myev/shared";
import { ContentItemsService, type ContentActor } from "../content/content-items.service";
import { ContentBodyValidator } from "../content/content-body-validator";
import { PrismaService } from "../../prisma/prisma.service";
import type { SubmitForReviewDto, ApproveContentDto, RejectContentDto } from "../content/dto/review-action.dto";
import type { EditSocialPostDto } from "./dto/edit-social-post.dto";

interface RequestContext {
  ipAddress?: string;
  correlationId: string;
}

/**
 * Module 10 Phase 10.3 — the Social read model + human-edit + review-
 * lifecycle facade. Mirrors BlogService's own established shape exactly:
 * a thin layer over Module 1E's generic ContentItemsService (list/findOne/
 * createVersion/submitForReview/approve/reject), enriched with
 * SocialPost/ContentVersion-body/SocialVersionGeneration data — never a
 * second lifecycle engine. Every method that mutates or reveals a single
 * item first confirms contentType === "SOCIAL_POST" (mirrors
 * BlogPipelineService.loadLockedPipeline's own "found.contentType !==
 * BLOG -> 404" guard) so this route surface can never be used to act on
 * an unrelated Blog/Video item a caller happens to also have permission
 * for.
 */
@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contentItems: ContentItemsService,
    private readonly bodyValidator: ContentBodyValidator,
  ) {}

  private async resolveSocialItem(workspace: { id: string }, itemPublicId: string): Promise<{ id: string; publicId: string; status: string; currentVersionId: string | null }> {
    const item = await this.prisma.contentItem.findFirst({
      where: { publicId: itemPublicId, workspaceId: workspace.id, contentType: "SOCIAL_POST", deletedAt: null },
      select: { id: true, publicId: true, status: true, currentVersionId: true },
    });
    if (!item) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    return item;
  }

  async list(
    workspace: { id: string },
    actor: ContentActor,
    filters: { platform?: string; status?: string; sourceContentItemId?: string },
  ): Promise<Record<string, unknown>[]> {
    const items = await this.contentItems.list(workspace, actor, { contentType: "SOCIAL_POST", status: filters.status as never });
    if (items.length === 0) return [];

    let sourceInternalId: string | undefined;
    if (filters.sourceContentItemId) {
      const source = await this.prisma.contentItem.findFirst({ where: { publicId: filters.sourceContentItemId, workspaceId: workspace.id }, select: { id: true } });
      if (!source) return [];
      sourceInternalId = source.id;
    }

    const socialPosts = await this.prisma.socialPost.findMany({
      where: {
        contentItemId: { in: items.map((i) => i.id) },
        ...(filters.platform ? { platform: filters.platform as never } : {}),
        ...(sourceInternalId ? { sourceContentItemId: sourceInternalId } : {}),
      },
    });
    const socialByItemId = new Map(socialPosts.map((s) => [s.contentItemId, s]));

    const sourceIds = [...new Set(socialPosts.map((s) => s.sourceContentItemId))];
    const sources = await this.prisma.contentItem.findMany({ where: { id: { in: sourceIds } }, select: { id: true, publicId: true, contentType: true } });
    const sourceById = new Map(sources.map((s) => [s.id, s]));

    // Module 10 Phase 10.6 — the list view needs a caption preview + media
    // indicator without an N+1 detail fetch per row; both are read straight
    // off each item's own current version, batched exactly like
    // findOne()/listVersions() already do per-item (safeMediaSummary is not
    // reused here since the list only needs a boolean, never the asset's
    // own publicId/status/type).
    const currentVersionIds = items.map((i) => i.currentVersionId).filter((id): id is string => id !== null);
    const [versions, versionMedia] = await Promise.all([
      this.prisma.contentVersion.findMany({ where: { id: { in: currentVersionIds } }, select: { id: true, body: true } }),
      this.prisma.socialVersionMedia.findMany({ where: { contentVersionId: { in: currentVersionIds } }, select: { contentVersionId: true } }),
    ]);
    const bodyByVersionId = new Map(versions.map((v) => [v.id, v.body as Record<string, unknown>]));
    const hasMediaByVersionId = new Set(versionMedia.map((m) => m.contentVersionId));

    return items
      .filter((i) => socialByItemId.has(i.id))
      .map((i) => {
        const social = socialByItemId.get(i.id)!;
        const body = i.currentVersionId ? bodyByVersionId.get(i.currentVersionId) : undefined;
        return {
          publicId: i.publicId,
          title: i.title,
          status: i.status,
          platform: social.platform,
          sourceContentItemPublicId: sourceById.get(social.sourceContentItemId)?.publicId,
          sourceContentType: sourceById.get(social.sourceContentItemId)?.contentType ?? null,
          caption: (body?.caption as string | undefined) ?? null,
          hasMedia: i.currentVersionId ? hasMediaByVersionId.has(i.currentVersionId) : false,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
        };
      });
  }

  async findOne(workspace: { id: string }, actor: ContentActor, itemPublicId: string): Promise<Record<string, unknown>> {
    const item = await this.contentItems.findOne(workspace, actor, itemPublicId);
    if (item.contentType !== "SOCIAL_POST") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });

    const socialPost = await this.prisma.socialPost.findFirstOrThrow({ where: { contentItemId: item.id, workspaceId: workspace.id } });
    const source = await this.prisma.contentItem.findFirstOrThrow({ where: { id: socialPost.sourceContentItemId }, select: { publicId: true, contentType: true, title: true } });
    const currentVersion = item.currentVersionId ? await this.prisma.contentVersion.findFirst({ where: { id: item.currentVersionId } }) : null;
    const versionCount = await this.prisma.contentVersion.count({ where: { contentItemId: item.id } });
    const generation = currentVersion ? await this.safeGenerationSummary(currentVersion.id) : null;
    const media = currentVersion ? await this.safeMediaSummary(currentVersion.id) : null;

    const body = (currentVersion?.body as Record<string, unknown>) ?? {};
    return {
      publicId: item.publicId,
      title: item.title,
      status: item.status,
      platform: socialPost.platform,
      sourceContentItemPublicId: source.publicId,
      sourceContentType: source.contentType,
      sourceContentItemTitle: source.title,
      sourceContentVersionPublicId: (await this.prisma.contentVersion.findFirst({ where: { id: socialPost.sourceContentVersionId }, select: { publicId: true } }))?.publicId,
      caption: body.caption ?? null,
      hashtags: body.hashtags ?? [],
      ctaObjective: body.ctaObjective ?? null,
      media,
      currentVersion: currentVersion ? { publicId: currentVersion.publicId, versionNumber: currentVersion.versionNumber, createdAt: currentVersion.createdAt } : null,
      versionCount,
      generation,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async listVersions(workspace: { id: string }, actor: ContentActor, itemPublicId: string): Promise<Record<string, unknown>[]> {
    const item = await this.contentItems.findOne(workspace, actor, itemPublicId);
    if (item.contentType !== "SOCIAL_POST") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });

    const versions = await this.prisma.contentVersion.findMany({ where: { contentItemId: item.id }, orderBy: { versionNumber: "asc" } });
    return Promise.all(
      versions.map(async (v) => {
        const body = v.body as Record<string, unknown>;
        return {
          publicId: v.publicId,
          versionNumber: v.versionNumber,
          isCurrent: v.id === item.currentVersionId,
          caption: body.caption ?? null,
          hashtags: body.hashtags ?? [],
          ctaObjective: body.ctaObjective ?? null,
          generation: await this.safeGenerationSummary(v.id),
          media: await this.safeMediaSummary(v.id),
          createdAt: v.createdAt,
        };
      }),
    );
  }

  /** Never exposes ai_jobs.inputPayload/outputPayload (raw prompts) or provider details — publicId + agent identity only. */
  private async safeGenerationSummary(contentVersionId: string): Promise<Record<string, unknown> | null> {
    const gen = await this.prisma.socialVersionGeneration.findFirst({ where: { contentVersionId } });
    if (!gen) return null;
    const [captionJob, hashtagJob] = await Promise.all([
      this.prisma.aiJob.findUnique({ where: { id: gen.captionAiJobId }, select: { publicId: true, agentName: true, agentVersion: true } }),
      this.prisma.aiJob.findUnique({ where: { id: gen.hashtagAiJobId }, select: { publicId: true, agentName: true, agentVersion: true } }),
    ]);
    return { generated: true, captionAiJob: captionJob, hashtagAiJob: hashtagJob, createdAt: gen.createdAt };
  }

  /** Module 10 Phase 10.5 — null means no media attached (valid for Facebook; not-ready for Instagram). Never exposes a raw storage key/URL — publicId + status/type only, same read-model discipline as safeGenerationSummary. */
  private async safeMediaSummary(contentVersionId: string): Promise<Record<string, unknown> | null> {
    const versionMedia = await this.prisma.socialVersionMedia.findFirst({ where: { contentVersionId }, select: { mediaAsset: { select: { publicId: true, status: true, assetType: true } } } });
    if (!versionMedia) return null;
    return { mediaAssetPublicId: versionMedia.mediaAsset.publicId, status: versionMedia.mediaAsset.status, assetType: versionMedia.mediaAsset.assetType };
  }

  async edit(workspace: { id: string }, actor: ContentActor, itemPublicId: string, dto: EditSocialPostDto, ctx: RequestContext): Promise<Record<string, unknown>> {
    const item = await this.resolveSocialItem(workspace, itemPublicId);
    const currentVersion = item.currentVersionId ? await this.prisma.contentVersion.findFirst({ where: { id: item.currentVersionId } }) : null;
    const currentBody = (currentVersion?.body as Record<string, unknown>) ?? {};

    const caption = dto.caption ?? (currentBody.caption as string | undefined) ?? "";
    const hashtags = dto.hashtags !== undefined ? normalizeHashtags(dto.hashtags) : ((currentBody.hashtags as string[] | undefined) ?? []);
    const ctaObjective = dto.ctaObjective !== undefined ? dto.ctaObjective : (currentBody.ctaObjective as string | undefined);

    if (ctaObjective && containsUrl(ctaObjective)) {
      throw new BadRequestException({ code: "SOCIAL_CTA_URL_NOT_ALLOWED", message: "ctaObjective must not contain a URL." });
    }

    const body: Record<string, unknown> = { caption, hashtags, ...(ctaObjective ? { ctaObjective } : {}) };
    this.bodyValidator.validate("SOCIAL_POST", body);

    // Module 10 Phase 10.5 Part D — media resolution BEFORE createVersion()
    // runs, so an invalid mediaAssetPublicId is rejected before any new
    // version is created (never a half-applied edit). undefined = carry
    // the current version's own media forward unchanged; explicit null =
    // detach; a real publicId = validated same-workspace ACTIVE asset.
    let mediaAssetId: string | null | undefined;
    if (dto.mediaAssetPublicId === undefined) {
      const currentMedia = currentVersion ? await this.prisma.socialVersionMedia.findFirst({ where: { contentVersionId: currentVersion.id }, select: { mediaAssetId: true } }) : null;
      mediaAssetId = currentMedia?.mediaAssetId ?? null;
    } else if (dto.mediaAssetPublicId === null) {
      mediaAssetId = null;
    } else {
      const asset = await this.prisma.mediaAsset.findFirst({ where: { publicId: dto.mediaAssetPublicId, workspaceId: workspace.id }, select: { id: true, status: true } });
      if (!asset) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });
      if (asset.status !== "ACTIVE") throw new BadRequestException({ code: "SOCIAL_MEDIA_NOT_ACTIVE", message: "Only an ACTIVE media asset can be attached." });
      mediaAssetId = asset.id;
    }

    const updated = await this.contentItems.createVersion(workspace, actor, itemPublicId, { body }, ctx);

    if (mediaAssetId) {
      const socialPost = await this.prisma.socialPost.findFirstOrThrow({ where: { contentItemId: item.id, workspaceId: workspace.id }, select: { id: true } });
      await this.prisma.socialVersionMedia.create({
        data: { id: randomUUID(), publicId: randomUUID(), workspaceId: workspace.id, socialPostId: socialPost.id, contentItemId: item.id, contentVersionId: updated.currentVersionId!, mediaAssetId },
      });
    }

    return { publicId: updated.publicId, status: updated.status, currentVersionId: updated.currentVersionId };
  }

  async submitForReview(workspace: { id: string }, actor: ContentActor, itemPublicId: string, dto: SubmitForReviewDto, ctx: RequestContext): Promise<Record<string, unknown>> {
    await this.resolveSocialItem(workspace, itemPublicId);
    return this.contentItems.submitForReview(workspace, actor, itemPublicId, dto, ctx, { viaSocialPipeline: true });
  }

  async approve(workspace: { id: string }, actor: ContentActor, itemPublicId: string, dto: ApproveContentDto, ctx: RequestContext): Promise<Record<string, unknown>> {
    await this.resolveSocialItem(workspace, itemPublicId);
    return this.contentItems.approve(workspace, actor, itemPublicId, dto, ctx);
  }

  async reject(workspace: { id: string }, actor: ContentActor, itemPublicId: string, dto: RejectContentDto, ctx: RequestContext): Promise<Record<string, unknown>> {
    await this.resolveSocialItem(workspace, itemPublicId);
    return this.contentItems.reject(workspace, actor, itemPublicId, dto, ctx);
  }
}
