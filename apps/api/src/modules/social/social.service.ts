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
    const sources = await this.prisma.contentItem.findMany({ where: { id: { in: sourceIds } }, select: { id: true, publicId: true } });
    const sourcePublicIdById = new Map(sources.map((s) => [s.id, s.publicId]));

    return items
      .filter((i) => socialByItemId.has(i.id))
      .map((i) => {
        const social = socialByItemId.get(i.id)!;
        return {
          publicId: i.publicId,
          title: i.title,
          status: i.status,
          platform: social.platform,
          sourceContentItemPublicId: sourcePublicIdById.get(social.sourceContentItemId),
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

    const updated = await this.contentItems.createVersion(workspace, actor, itemPublicId, { body }, ctx);
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
