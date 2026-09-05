import { randomUUID } from "crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { HASHTAG_AGENT_V1, SOCIAL_CAPTION_AGENT_V1, normalizeHashtags, type HashtagAgentOutput, type SocialCaptionAgentOutput } from "@myev/shared";
import type { Prisma } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentExecutorService } from "../ai-agents/agent-executor.service";
import { ContentBodyValidator } from "../content/content-body-validator";
import { ContentPermissionResolver } from "../content/content-permission.resolver";
import { ContentItemsService, EDITABLE_STATUSES, type ContentActor } from "../content/content-items.service";
import { assertSocialSourceEligible, SocialDomainError, SOCIAL_DOMAIN_ERRORS } from "./social-domain";
import type { CreateSocialPostDto } from "./dto/create-social-post.dto";
import type { RegenerateSocialPostDto } from "./dto/regenerate-social-post.dto";

interface RequestContext {
  ipAddress?: string;
  correlationId: string;
}

interface SourceContentRow {
  id: string;
  publicId: string;
  workspaceId: string;
  contentType: string;
  status: string;
  deletedAt: Date | null;
  title: string;
  currentVersionId: string | null;
}

/**
 * Module 10 Phase 10.2 — the "Create Social Post" orchestration
 * (Part C of the Phase 10.2 checkpoint). Deliberately does NOT create an
 * empty SOCIAL_POST up front: AgentExecutorService's own synchronous
 * "internal execution primitive" (see its doc comment — sanctioned by
 * Phase 3.2's own spec for exactly this shape of caller) lets this
 * service validate the source, generate a real caption then real
 * hashtags, and only once BOTH have succeeded, transactionally create
 * ContentItem + SocialPost + ContentVersion v1 with the real generated
 * content. No placeholder body is ever written (contrast with Blog's own
 * NEW_BLOG_PLACEHOLDER_BODY — a deliberate, frozen Phase 10.2 product
 * decision to diverge from that precedent, not an oversight).
 *
 * If AI generation fails at either step, nothing is persisted beyond the
 * ai_jobs row AgentExecutorService itself already wrote (real execution
 * evidence, per the checkpoint's own "AIJob/background-job records may
 * still exist as execution evidence").
 */
@Injectable()
export class SocialGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentExecutor: AgentExecutorService,
    private readonly permissions: ContentPermissionResolver,
    private readonly bodyValidator: ContentBodyValidator,
    private readonly contentItems: ContentItemsService,
  ) {}

  async createFromSource(workspace: { id: string }, actor: ContentActor, dto: CreateSocialPostDto, ctx: RequestContext): Promise<Record<string, unknown>> {
    // 1. Permission — checked BEFORE any AI spend is triggered.
    const allowed = await this.permissions.can(actor.publicId, workspace.id, "create", "SOCIAL_POST");
    if (!allowed) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "Missing required permission to create SOCIAL_POST content." });
    }

    // 2/3. Resolve + validate the source — enumeration-safe: a source in
    // a different workspace resolves to the identical 404 as one that
    // doesn't exist (same discipline as KnowledgePacksService.findOne).
    const source = await this.prisma.contentItem.findFirst({
      where: { publicId: dto.sourceContentItemId, workspaceId: workspace.id },
      select: { id: true, publicId: true, workspaceId: true, contentType: true, status: true, deletedAt: true, title: true, currentVersionId: true },
    });
    if (!source) {
      throw new NotFoundException({ code: "SOCIAL_SOURCE_NOT_FOUND", message: "Source content item not found." });
    }
    this.assertEligible(source, workspace.id);

    const currentVersion = await this.prisma.contentVersion.findFirstOrThrow({ where: { id: source.currentVersionId! } });
    const sourceBody = currentVersion.body as Record<string, unknown>;
    const sourceSummary = (source.contentType === "BLOG" ? (sourceBody.content as string) : (sourceBody.script as string)) ?? "";

    // 4. Generate the caption — SYNCHRONOUS execution (no queued job to
    // poll), still fully ai_jobs/ai_job_steps-audited underneath.
    const captionResult = await this.agentExecutor.execute(
      {
        agentIdentifier: SOCIAL_CAPTION_AGENT_V1.identifier,
        agentVersion: SOCIAL_CAPTION_AGENT_V1.version,
        workspaceId: workspace.id,
        knowledgePackVersionId: dto.knowledgePackVersionId,
        input: { sourceContentType: source.contentType, sourceTitle: source.title, sourceSummary, platform: dto.platform },
        correlationId: `${ctx.correlationId}-caption`,
        requestedByUserId: actor.internalId,
      },
      "social-generation",
    );
    if (captionResult.status !== "COMPLETED" || !captionResult.output || typeof captionResult.output === "string") {
      throw new UnprocessableEntityException({
        code: "SOCIAL_CAPTION_GENERATION_FAILED",
        message: "Caption generation failed — no social post was created.",
        details: captionResult.failure,
      });
    }
    const captionOutput = captionResult.output as unknown as SocialCaptionAgentOutput;

    // 5. Generate hashtags — over the generated caption, never over
    // VideoScript.tags and never using Module 8 internal-link data.
    const hashtagResult = await this.agentExecutor.execute(
      {
        agentIdentifier: HASHTAG_AGENT_V1.identifier,
        agentVersion: HASHTAG_AGENT_V1.version,
        workspaceId: workspace.id,
        knowledgePackVersionId: dto.knowledgePackVersionId,
        input: { sourceSummary, caption: captionOutput.caption, platform: dto.platform },
        correlationId: `${ctx.correlationId}-hashtags`,
        requestedByUserId: actor.internalId,
      },
      "social-generation",
    );
    if (hashtagResult.status !== "COMPLETED" || !hashtagResult.output || typeof hashtagResult.output === "string") {
      throw new UnprocessableEntityException({
        code: "SOCIAL_HASHTAG_GENERATION_FAILED",
        message: "Hashtag generation failed — no social post was created.",
        details: hashtagResult.failure,
      });
    }
    const hashtagOutput = hashtagResult.output as unknown as HashtagAgentOutput;
    const hashtags = normalizeHashtags(hashtagOutput.hashtags);
    if (hashtags.length === 0) {
      throw new UnprocessableEntityException({ code: "SOCIAL_HASHTAG_GENERATION_EMPTY", message: "Hashtag generation produced no usable hashtags — no social post was created." });
    }

    // 6. Build + validate the real ContentVersion v1 body — the exact
    // same generic ContentBodyValidator every other content type uses,
    // never a hand-rolled shape check.
    const body: Record<string, unknown> = { caption: captionOutput.caption, hashtags, ...(captionOutput.ctaObjective ? { ctaObjective: captionOutput.ctaObjective } : {}) };
    this.bodyValidator.validate("SOCIAL_POST", body);

    // 7. Only now — after both generations succeeded and the body is
    // validated — transactionally create ContentItem + ContentVersion v1
    // + SocialPost, mirroring ContentItemsService.create()'s own 5-step
    // shape (Module 1E) plus the SocialPost extension row, all inside one
    // $transaction (the checkpoint's own explicit "transactionally
    // create" requirement — see this file's doc comment for why this
    // isn't simply a call to ContentItemsService.create() followed by a
    // second write).
    const title = `${source.title} — ${dto.platform} post`.slice(0, 300);
    const item = await this.prisma.$transaction(async (tx) => {
      const itemId = randomUUID();
      await tx.contentItem.create({
        data: { id: itemId, publicId: randomUUID(), workspaceId: workspace.id, contentType: "SOCIAL_POST", title, status: "DRAFT", createdById: actor.internalId },
      });

      const version = await tx.contentVersion.create({
        data: { id: randomUUID(), publicId: randomUUID(), contentItemId: itemId, versionNumber: 1, body: body as Prisma.InputJsonValue, createdById: actor.internalId },
      });

      const updated = await tx.contentItem.update({ where: { id: itemId }, data: { currentVersionId: version.id } });

      const socialPostId = randomUUID();
      await tx.socialPost.create({
        data: {
          id: socialPostId,
          publicId: randomUUID(),
          workspaceId: workspace.id,
          contentItemId: itemId,
          sourceContentItemId: source.id,
          sourceContentVersionId: currentVersion.id,
          platform: dto.platform,
        },
      });

      // Module 10 Phase 10.3 — per-version generation provenance (see
      // SocialVersionGeneration's own doc comment for why this replaced
      // Phase 10.2's original captionAiJobId/hashtagAiJobId columns on
      // SocialPost itself).
      await tx.socialVersionGeneration.create({
        data: {
          id: randomUUID(),
          publicId: randomUUID(),
          workspaceId: workspace.id,
          socialPostId,
          contentItemId: itemId,
          contentVersionId: version.id,
          captionAiJobId: captionResult.aiJobId!,
          hashtagAiJobId: hashtagResult.aiJobId!,
        },
      });

      await this.audit.recordWithinTransaction(tx, { action: "CONTENT_ITEM_CREATED", actorUserId: actor.internalId, workspaceId: workspace.id, entityType: "content_item", entityId: updated.publicId });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_VERSION_CREATED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: updated.publicId,
        afterState: { versionNumber: 1, sourceContentItemPublicId: source.publicId, platform: dto.platform },
      });

      return updated;
    });

    // DRAFT -> IN_PROGRESS, mirroring Blog's own create()-then-start()
    // sequence exactly (BlogService.create()'s own comment: "Module 1E
    // owns item + version-1 creation and the DRAFT->IN_PROGRESS
    // transition"). Without this, submitForReview() would 409 forever —
    // it only accepts IN_PROGRESS, never DRAFT.
    const started = await this.contentItems.start(workspace, actor, item.publicId, ctx);

    return { publicId: started.publicId, title: started.title, status: started.status, contentType: started.contentType, platform: dto.platform, sourceContentItemPublicId: source.publicId };
  }

  /**
   * Module 10 Phase 10.3 Part F/G — regenerates a SocialPost's caption +
   * hashtags using the EXACT source/platform already pinned on this
   * SocialPost row (Part G: "must not silently switch to source version
   * Y later" — this reads sourceContentItemId/sourceContentVersionId from
   * the SocialPost row itself, never re-resolving to the source's current
   * version). Same generate-then-persist discipline as createFromSource:
   * both agents must succeed before anything is written. The actual
   * version write reuses ContentItemsService.createVersion() UNCHANGED
   * (Part E: this is what makes "cannot edit an APPROVED/REVIEW item"
   * true here too, with zero Social-specific status logic — createVersion
   * throws CONTENT_ITEM_NOT_EDITABLE for those statuses already). The
   * follow-up SocialVersionGeneration write is a second, non-atomic step
   * (matching Blog's own established multi-statement create+start+
   * metadata-update precedent) — acceptable since it is provenance
   * metadata, not the load-bearing 1:1 invariant Phase 10.2's create path
   * had to protect atomically.
   */
  async regenerate(workspace: { id: string }, actor: ContentActor, itemPublicId: string, dto: RegenerateSocialPostDto, ctx: RequestContext): Promise<Record<string, unknown>> {
    const allowed = await this.permissions.can(actor.publicId, workspace.id, "edit", "SOCIAL_POST");
    if (!allowed) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "Missing required permission to edit SOCIAL_POST content." });
    }

    const item = await this.prisma.contentItem.findFirst({
      where: { publicId: itemPublicId, workspaceId: workspace.id, contentType: "SOCIAL_POST", deletedAt: null },
      select: { id: true, publicId: true, status: true },
    });
    if (!item) {
      throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    }
    // Pre-check before spending any AI call — createVersion() enforces
    // this identically, but only after two provider calls would already
    // have run otherwise.
    if (!EDITABLE_STATUSES.includes(item.status)) {
      throw new ConflictException({ code: "CONTENT_ITEM_NOT_EDITABLE", message: `Cannot regenerate while status is ${item.status}.` });
    }

    const socialPost = await this.prisma.socialPost.findFirst({ where: { contentItemId: item.id, workspaceId: workspace.id } });
    if (!socialPost) {
      throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    }

    const source = await this.prisma.contentItem.findFirstOrThrow({ where: { id: socialPost.sourceContentItemId }, select: { title: true, contentType: true } });
    // The PINNED version, never source's own currentVersionId — Part G.
    const pinnedVersion = await this.prisma.contentVersion.findFirstOrThrow({ where: { id: socialPost.sourceContentVersionId } });
    const sourceBody = pinnedVersion.body as Record<string, unknown>;
    const sourceSummary = (source.contentType === "BLOG" ? (sourceBody.content as string) : (sourceBody.script as string)) ?? "";

    const captionResult = await this.agentExecutor.execute(
      {
        agentIdentifier: SOCIAL_CAPTION_AGENT_V1.identifier,
        agentVersion: SOCIAL_CAPTION_AGENT_V1.version,
        workspaceId: workspace.id,
        knowledgePackVersionId: dto.knowledgePackVersionId,
        input: { sourceContentType: source.contentType, sourceTitle: source.title, sourceSummary, platform: socialPost.platform },
        correlationId: `${ctx.correlationId}-caption`,
        requestedByUserId: actor.internalId,
      },
      "social-generation",
    );
    if (captionResult.status !== "COMPLETED" || !captionResult.output || typeof captionResult.output === "string") {
      throw new UnprocessableEntityException({ code: "SOCIAL_CAPTION_GENERATION_FAILED", message: "Caption regeneration failed — no new version was created.", details: captionResult.failure });
    }
    const captionOutput = captionResult.output as unknown as SocialCaptionAgentOutput;

    const hashtagResult = await this.agentExecutor.execute(
      {
        agentIdentifier: HASHTAG_AGENT_V1.identifier,
        agentVersion: HASHTAG_AGENT_V1.version,
        workspaceId: workspace.id,
        knowledgePackVersionId: dto.knowledgePackVersionId,
        input: { sourceSummary, caption: captionOutput.caption, platform: socialPost.platform },
        correlationId: `${ctx.correlationId}-hashtags`,
        requestedByUserId: actor.internalId,
      },
      "social-generation",
    );
    if (hashtagResult.status !== "COMPLETED" || !hashtagResult.output || typeof hashtagResult.output === "string") {
      throw new UnprocessableEntityException({ code: "SOCIAL_HASHTAG_GENERATION_FAILED", message: "Hashtag regeneration failed — no new version was created.", details: hashtagResult.failure });
    }
    const hashtagOutput = hashtagResult.output as unknown as HashtagAgentOutput;
    const hashtags = normalizeHashtags(hashtagOutput.hashtags);
    if (hashtags.length === 0) {
      throw new UnprocessableEntityException({ code: "SOCIAL_HASHTAG_GENERATION_EMPTY", message: "Hashtag regeneration produced no usable hashtags — no new version was created." });
    }

    const body: Record<string, unknown> = { caption: captionOutput.caption, hashtags, ...(captionOutput.ctaObjective ? { ctaObjective: captionOutput.ctaObjective } : {}) };
    this.bodyValidator.validate("SOCIAL_POST", body);

    const updated = await this.contentItems.createVersion(workspace, actor, itemPublicId, { body }, ctx);

    await this.prisma.socialVersionGeneration.create({
      data: {
        id: randomUUID(),
        publicId: randomUUID(),
        workspaceId: workspace.id,
        socialPostId: socialPost.id,
        contentItemId: item.id,
        contentVersionId: updated.currentVersionId!,
        captionAiJobId: captionResult.aiJobId!,
        hashtagAiJobId: hashtagResult.aiJobId!,
      },
    });

    return { publicId: updated.publicId, status: updated.status, currentVersionId: updated.currentVersionId };
  }

  private assertEligible(source: SourceContentRow, targetWorkspaceId: string): void {
    try {
      assertSocialSourceEligible({ contentType: source.contentType, status: source.status, deletedAt: source.deletedAt, workspaceId: source.workspaceId }, targetWorkspaceId);
    } catch (err) {
      if (err instanceof SocialDomainError) {
        if (err.code === SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_WORKSPACE_MISMATCH) {
          // Enumeration-safe: never distinguish "exists in another
          // workspace" from "doesn't exist" — same 404 either way.
          throw new NotFoundException({ code: "SOCIAL_SOURCE_NOT_FOUND", message: "Source content item not found." });
        }
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }
    if (!source.currentVersionId) {
      throw new BadRequestException({ code: SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_NOT_APPROVED, message: "The source content item has no current version." });
    }
  }
}
