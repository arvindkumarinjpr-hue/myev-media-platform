import { randomUUID } from "crypto";
import {
  AgentRegistryBuilder,
  AIProviderRegistryBuilder,
  AIProviderError,
  AIProviderErrorCode,
  HASHTAG_AGENT_V1,
  parseStructuredOutput,
  SOCIAL_CAPTION_AGENT_V1,
  type AIModelCapability,
  type AIProvider,
  type AIRequest,
  type AIResponse,
} from "@myev/shared";
import { AgentExecutorService } from "../src/modules/ai-agents/agent-executor.service";
import { AI_PROVIDER_REGISTRY } from "../src/modules/ai-agents/ai-provider-registry.module";
import { AuditService } from "../src/modules/audit/audit.service";
import { KnowledgePacksService } from "../src/modules/knowledge-packs/knowledge-packs.service";
import { ContentPermissionResolver } from "../src/modules/content/content-permission.resolver";
import { ContentBodyValidator } from "../src/modules/content/content-body-validator";
import { ContentItemsService } from "../src/modules/content/content-items.service";
import { SocialGenerationService } from "../src/modules/social/social-generation.service";
import {
  addActiveMemberWithRole,
  bootstrapE2eApp,
  createActiveUserAndLogin,
  createWorkspaceAsOwner,
  loginAsPlatformOwner,
  request,
  teardownE2eApp,
  type E2eApp,
} from "./helpers/e2e-app";

/**
 * Module 10 Phase 10.3 — Social Review + Versioning Workflow (e2e).
 *
 * One bootstrapped app for the whole file, with AI_PROVIDER_REGISTRY
 * overridden to a deterministic AgentKeyedFakeProvider (same technique
 * social-generation.e2e-spec.ts already established) — every "create a
 * real SocialPost via POST /social-posts" setup call in this file
 * succeeds deterministically through the real HTTP route, so list/detail/
 * versions/edit/submit-for-review/approve/reject/RBAC are all proven at
 * the true system boundary. The few tests that need a FAILING generation
 * (regenerate failure, invalid output) instead instantiate
 * SocialGenerationService directly with its own dedicated executor/
 * provider — the same direct-instantiation technique
 * social-generation.e2e-spec.ts's own "no-placeholder" suite uses.
 */
class AgentKeyedFakeProvider implements AIProvider {
  readonly id = "openai";
  constructor(private readonly byAgent: Record<string, Record<string, unknown> | "FAIL">) {}

  async execute(request: AIRequest): Promise<AIResponse> {
    const fixture = request.agentName ? this.byAgent[request.agentName] : undefined;
    if (!fixture || fixture === "FAIL") {
      throw new AIProviderError(AIProviderErrorCode.INVALID_REQUEST, `AgentKeyedFakeProvider: simulated failure for "${request.agentName}".`, this.id);
    }
    const output = request.structuredOutputSchema ? ((await parseStructuredOutput(JSON.stringify(fixture), request.structuredOutputSchema, this.id)) as Record<string, unknown>) : fixture;
    return { provider: this.id, model: "fake-openai-1", requestId: `fake-${request.correlationId ?? "none"}`, usage: { tokensIn: 1, tokensOut: 1, tokensTotal: 2 }, executionTimeMs: 1, finishReason: "stop", correlationId: request.correlationId, output };
  }

  getCapabilities(): AIModelCapability[] {
    return [{ model: "fake-openai-1", capability: "chat" }];
  }
}

const CAPTION_FIXTURE = { caption: "Charging your EV at home is easier than you think.", ctaObjective: "Invite comments about charging speed." };
const CAPTION_FIXTURE_2 = { caption: "Regenerated: home charging setup in three simple steps." };
const HASHTAG_FIXTURE = { hashtags: ["#ev", "#EV", "#evcharging"] };

describe("Social review + versioning workflow (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let ownerUserId: string;
  let knowledgePacks: KnowledgePacksService;
  let audit: AuditService;
  let permissions: ContentPermissionResolver;
  let bodyValidator: ContentBodyValidator;
  let contentItems: ContentItemsService;

  interface Workspace {
    id: string;
    publicId: string;
  }

  beforeAll(async () => {
    ctx = await bootstrapE2eApp((builder) =>
      builder.overrideProvider(AI_PROVIDER_REGISTRY).useFactory({
        factory: () => {
          const b = new AIProviderRegistryBuilder();
          b.register(new AgentKeyedFakeProvider({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE }));
          return b.freeze();
        },
      }),
    );
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
    ownerUserId = (await ctx.prisma.user.findUniqueOrThrow({ where: { publicId: owner.publicId } })).id;
    knowledgePacks = ctx.app.get(KnowledgePacksService);
    audit = ctx.app.get(AuditService);
    permissions = ctx.app.get(ContentPermissionResolver);
    bodyValidator = ctx.app.get(ContentBodyValidator);
    contentItems = ctx.app.get(ContentItemsService);
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  function auth(token: string, workspacePublicId: string) {
    return { Authorization: `Bearer ${token}`, "X-Workspace-Id": workspacePublicId };
  }

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const row = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  async function createActivePack(ws: Workspace): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set(auth(ownerAccessToken, ws.publicId))
      .send({ name: "Phase 10.3 Social Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set(auth(ownerAccessToken, ws.publicId))
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"].map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);

    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
    return packPublicId;
  }

  async function createSourceItem(workspaceId: string, contentType: "BLOG" | "VIDEO" = "BLOG"): Promise<{ id: string; publicId: string }> {
    const id = randomUUID();
    const publicId = randomUUID();
    const versionId = randomUUID();
    const field = contentType === "BLOG" ? "content" : "script";
    await ctx.prisma.$transaction(async (tx) => {
      await tx.contentItem.create({ data: { id, publicId, workspaceId, contentType, title: "Fixture source", status: "DRAFT", createdById: ownerUserId } });
      await tx.contentVersion.create({ data: { id: versionId, publicId: randomUUID(), contentItemId: id, versionNumber: 1, body: { [field]: "Home EV charging is simpler than most people expect." }, createdById: ownerUserId } });
      await tx.contentItem.update({ where: { id }, data: { currentVersionId: versionId, status: "APPROVED" } });
    });
    return { id, publicId };
  }

  async function createSocialPost(ws: Workspace, token: string, sourcePublicId: string, pack: string, platform: "FACEBOOK" | "INSTAGRAM" = "FACEBOOK"): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/social-posts`)
      .set(auth(token, ws.publicId))
      .send({ sourceContentItemId: sourcePublicId, platform, knowledgePackVersionId: pack })
      .expect(201);
    return res.body.data.publicId as string;
  }

  /** Direct-instantiation SocialGenerationService with a controllable provider — for failure-path tests only. */
  function regenerateServiceWith(byAgent: Record<string, Record<string, unknown> | "FAIL">): SocialGenerationService {
    const agentBuilder = new AgentRegistryBuilder();
    agentBuilder.register(SOCIAL_CAPTION_AGENT_V1);
    agentBuilder.register(HASHTAG_AGENT_V1);
    const agentRegistry = agentBuilder.freeze();
    const providerBuilder = new AIProviderRegistryBuilder();
    providerBuilder.register(new AgentKeyedFakeProvider(byAgent));
    const providerRegistry = providerBuilder.freeze();
    const executor = new AgentExecutorService(agentRegistry, providerRegistry, knowledgePacks, ctx.prisma, audit);
    return new SocialGenerationService(ctx.prisma, audit, executor, permissions, bodyValidator, contentItems);
  }

  // ---------------------------------------------------------------------
  // Read model (Part Q #1-5)
  // ---------------------------------------------------------------------
  describe("read model", () => {
    it("list requires SOCIAL_VIEW (#1) and detail requires SOCIAL_VIEW (#2)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      // Analyst holds no SOCIAL_* permission at all (the frozen role
      // matrix) — this route uses a static @RequirePermission(SOCIAL_VIEW)
      // guard (correct for a single-content-type controller, same as
      // BlogController's own identical choice), so PermissionGuard denies
      // BEFORE the handler runs: 403, not the generic multi-type
      // /content-items route's own enumeration-safe-narrows-to-empty
      // behavior (already proven in social-domain-foundation.e2e-spec.ts).
      const noViewUser = await createActiveUserAndLogin(ctx, "no-social-view");
      await addActiveMemberWithRole(ctx, ws.id, noViewUser.userId, "Analyst");

      await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts`).set(auth(noViewUser.accessToken, ws.publicId)).expect(403);
      await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(noViewUser.accessToken, ws.publicId)).expect(403);

      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(res.body.data.platform).toBe("FACEBOOK");
      expect(res.body.data.caption).toBe(CAPTION_FIXTURE.caption);
      expect(res.body.data.hashtags).toEqual(["#ev", "#evcharging"]);
    });

    it("workspace isolation (#3) — a second workspace's list never includes the first's item, and cross-workspace item is hidden (#4)", async () => {
      const wsA = await createWorkspace();
      const wsB = await createWorkspace();
      const packA = await createActivePack(wsA);
      const sourceA = await createSourceItem(wsA.id);
      const itemA = await createSocialPost(wsA, ownerAccessToken, sourceA.publicId, packA);

      const listB = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${wsB.publicId}/social-posts`).set(auth(ownerAccessToken, wsB.publicId)).expect(200);
      expect(listB.body.data.find((i: { publicId: string }) => i.publicId === itemA)).toBeUndefined();

      await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${wsB.publicId}/social-posts/${itemA}`).set(auth(ownerAccessToken, wsB.publicId)).expect(404);
    });

    it("version history is ordered correctly (#5)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`)
        .set(auth(ownerAccessToken, ws.publicId))
        .send({ caption: "Edited caption v2" })
        .expect(200);

      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/versions`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      const versions = res.body.data as { versionNumber: number; caption: string; isCurrent: boolean; generation: unknown }[];
      expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
      expect(versions[0].generation).not.toBeNull();
      expect(versions[1].generation).toBeNull();
      expect(versions[1].isCurrent).toBe(true);
      expect(versions[1].caption).toBe("Edited caption v2");
    });
  });

  // ---------------------------------------------------------------------
  // Human edit (Part Q #6-11)
  // ---------------------------------------------------------------------
  describe("human edit", () => {
    it("creates ContentVersion v2+ (#6), previous version unchanged (#7), currentVersion updates atomically (#8)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);
      const before = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`)
        .set(auth(ownerAccessToken, ws.publicId))
        .send({ caption: "Human-edited caption" })
        .expect(200);

      const after = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(after.body.data.caption).toBe("Human-edited caption");
      expect(after.body.data.currentVersion.versionNumber).toBe(2);
      expect(after.body.data.currentVersion.publicId).not.toBe(before.body.data.currentVersion.publicId);

      const versions = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/versions`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(versions.body.data[0].caption).toBe(CAPTION_FIXTURE.caption);
    });

    it("edit requires SOCIAL_EDIT (#9)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      const viewOnly = await createActiveUserAndLogin(ctx, "view-only-editor");
      await addActiveMemberWithRole(ctx, ws.id, viewOnly.userId, "SEO Specialist");

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`)
        .set(auth(viewOnly.accessToken, ws.publicId))
        .send({ caption: "should be denied" })
        .expect(403);
    });

    it("rejects an invalid body — empty caption after merge (#10)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`)
        .set(auth(ownerAccessToken, ws.publicId))
        .send({ caption: "" })
        .expect(400);
    });

    it("normalizes/dedupes hashtags on edit (#11) and allows an empty hashtags array", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`)
        .set(auth(ownerAccessToken, ws.publicId))
        .send({ hashtags: ["#EV", " ev ", "#EVCharging"] })
        .expect(200);
      const res1 = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(res1.body.data.hashtags).toEqual(["#EV", "#EVCharging"]);

      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).send({ hashtags: [] }).expect(200);
      const res2 = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(res2.body.data.hashtags).toEqual([]);
    });

    it("does not silently mutate APPROVED content — edit is blocked once approved (Part E)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);

      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`)
        .set(auth(ownerAccessToken, ws.publicId))
        .send({ caption: "trying to sneak an edit past approval" })
        .expect(409);
      expect(res.body.code).toBe("CONTENT_ITEM_NOT_EDITABLE");
    });
  });

  // ---------------------------------------------------------------------
  // Regeneration (Part Q #12-19)
  // ---------------------------------------------------------------------
  describe("regeneration", () => {
    it("creates a new version (#12), preserves the older version (#13), uses the pinned sourceContentVersionId (#14), does not mutate the source (#15)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const beforeSourceVersion = await ctx.prisma.contentVersion.findFirstOrThrow({ where: { contentItemId: (await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: source.publicId } })).id } });
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);
      const detail1 = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);

      const regenRes = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/regenerate`)
        .set(auth(ownerAccessToken, ws.publicId))
        .send({ knowledgePackVersionId: pack })
        .expect(200);
      expect(regenRes.body.data.currentVersionId).toBeDefined();

      const detail2 = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(detail2.body.data.currentVersion.versionNumber).toBe(2);
      expect(detail2.body.data.sourceContentVersionPublicId).toBe(detail1.body.data.sourceContentVersionPublicId);

      const versions = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/versions`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(versions.body.data).toHaveLength(2);
      expect(versions.body.data[0].caption).toBe(CAPTION_FIXTURE.caption);

      const afterSourceVersion = await ctx.prisma.contentVersion.findUniqueOrThrow({ where: { id: beforeSourceVersion.id } });
      expect(afterSourceVersion.body).toEqual(beforeSourceVersion.body);
    });

    it("regeneration failure creates no new ContentVersion (#16)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);
      const before = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);

      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };
      const failingService = regenerateServiceWith({ "social-caption-agent": "FAIL", "hashtag-agent": HASHTAG_FIXTURE });
      await expect(failingService.regenerate({ id: ws.id }, actor, itemPublicId, { knowledgePackVersionId: pack }, { correlationId: "corr-regen-fail" })).rejects.toMatchObject({
        response: { code: "SOCIAL_CAPTION_GENERATION_FAILED" },
      });

      const after = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(after.body.data.currentVersion.publicId).toBe(before.body.data.currentVersion.publicId);
      expect(after.body.data.versionCount).toBe(1);
    });

    it("caption + hashtag job provenance retained per generation (#17, #18), historical provenance not overwritten (#19)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      const socialPost = await ctx.prisma.socialPost.findFirstOrThrow({ where: { contentItemId: item.id } });
      const genV1Before = await ctx.prisma.socialVersionGeneration.findFirstOrThrow({ where: { socialPostId: socialPost.id } });

      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };
      const service = regenerateServiceWith({ "social-caption-agent": CAPTION_FIXTURE_2, "hashtag-agent": HASHTAG_FIXTURE });
      await service.regenerate({ id: ws.id }, actor, itemPublicId, { knowledgePackVersionId: pack }, { correlationId: "corr-regen-ok" });

      const generations = await ctx.prisma.socialVersionGeneration.findMany({ where: { socialPostId: socialPost.id }, orderBy: { createdAt: "asc" } });
      expect(generations).toHaveLength(2);
      expect(generations[0].id).toBe(genV1Before.id);
      expect(generations[0].captionAiJobId).toBe(genV1Before.captionAiJobId);
      expect(generations[0].hashtagAiJobId).toBe(genV1Before.hashtagAiJobId);
      expect(generations[1].captionAiJobId).not.toBe(genV1Before.captionAiJobId);
      expect(generations[1].contentVersionId).not.toBe(genV1Before.contentVersionId);

      const genV1After = await ctx.prisma.socialVersionGeneration.findUniqueOrThrow({ where: { id: genV1Before.id } });
      expect(genV1After.captionAiJobId).toBe(genV1Before.captionAiJobId);
      expect(genV1After.hashtagAiJobId).toBe(genV1Before.hashtagAiJobId);
    });
  });

  // ---------------------------------------------------------------------
  // Submit for review / approve / reject (Part Q #20-24)
  // ---------------------------------------------------------------------
  describe("review lifecycle", () => {
    it("submit-for-review requires SOCIAL_EDIT (#20) and the generic-route bypass remains blocked (#21)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      const viewOnly = await createActiveUserAndLogin(ctx, "submit-view-only");
      await addActiveMemberWithRole(ctx, ws.id, viewOnly.userId, "SEO Specialist");
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(viewOnly.accessToken, ws.publicId)).send({}).expect(403);

      // Generic-route bypass remains blocked (Phase 10.1's own seal, unaffected by Phase 10.3).
      const bypassRes = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemPublicId}/submit-for-review`)
        .set(auth(ownerAccessToken, ws.publicId))
        .send({})
        .expect(409);
      expect(bypassRes.body.code).toBe("CONTENT_ITEM_SOCIAL_REVIEW_VIA_PIPELINE");

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);
      const detail = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(detail.body.data.status).toBe("REVIEW");
    });

    it("approve requires SOCIAL_APPROVE (#22) and only from REVIEW state (#23)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);

      // Cannot approve from DRAFT.
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(409);

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);

      const writer = await createActiveUserAndLogin(ctx, "approve-writer");
      await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Content Writer");
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(writer.accessToken, ws.publicId)).send({}).expect(403);

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);
      const detail = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(detail.body.data.status).toBe("APPROVED");
    });

    it("reject preserves history and returns the item to IN_PROGRESS (#24)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/reject`)
        .set(auth(ownerAccessToken, ws.publicId))
        .send({ comment: "needs a stronger hook" })
        .expect(200);

      const detail = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).expect(200);
      expect(detail.body.data.status).toBe("IN_PROGRESS");

      const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      const events = await ctx.prisma.contentReviewEvent.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
      expect(events.map((e) => e.action)).toEqual(["SUBMITTED", "REJECTED"]);

      // Editable again after rejection.
      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ownerAccessToken, ws.publicId)).send({ caption: "revised after rejection" }).expect(200);
    });
  });

  // ---------------------------------------------------------------------
  // RBAC role matrix (Part Q #25-27)
  // ---------------------------------------------------------------------
  describe("RBAC role matrix", () => {
    it("Publisher (VIEW-only) cannot edit/approve (#25)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);

      const publisher = await createActiveUserAndLogin(ctx, "publisher-role");
      await addActiveMemberWithRole(ctx, ws.id, publisher.userId, "Publisher");
      await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(publisher.accessToken, ws.publicId)).expect(200);
      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(publisher.accessToken, ws.publicId)).send({ caption: "nope" }).expect(403);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(publisher.accessToken, ws.publicId)).send({}).expect(403);
    });

    it("Content Writer cannot approve (#26)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);

      const writer = await createActiveUserAndLogin(ctx, "cw-cannot-approve");
      await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Content Writer");
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(writer.accessToken, ws.publicId)).send({}).expect(403);
    });

    it("Owner/Administrator/Content Manager can approve (#27)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);

      for (const role of ["Administrator", "Content Manager"]) {
        const source = await createSourceItem(ws.id);
        const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);
        await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);

        const approver = await createActiveUserAndLogin(ctx, `approver-${role.replace(/\s/g, "").toLowerCase()}`);
        await addActiveMemberWithRole(ctx, ws.id, approver.userId, role);
        await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(approver.accessToken, ws.publicId)).send({}).expect(200);
      }
    });
  });

  // ---------------------------------------------------------------------
  // No Module 9 write (Part Q #31)
  // ---------------------------------------------------------------------
  it("writes no metadata.publishing.caption anywhere in this phase (#31)", async () => {
    const ws = await createWorkspace();
    const pack = await createActivePack(ws);
    const source = await createSourceItem(ws.id);
    const itemPublicId = await createSocialPost(ws, ownerAccessToken, source.publicId, pack);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(ownerAccessToken, ws.publicId)).send({}).expect(200);

    const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
    const metadata = (item.metadata as Record<string, unknown> | null) ?? {};
    expect((metadata as { publishing?: unknown }).publishing).toBeUndefined();
  });
});
