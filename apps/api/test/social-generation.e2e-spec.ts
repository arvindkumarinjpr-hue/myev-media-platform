import { randomUUID } from "crypto";
import {
  AgentRegistryBuilder,
  AIProviderRegistryBuilder,
  AIProviderError,
  AIProviderErrorCode,
  HASHTAG_AGENT_V1,
  parseStructuredOutput,
  SOCIAL_CAPTION_AGENT_V1,
  type AgentRegistry,
  type AIModelCapability,
  type AIProvider,
  type AIProviderRegistry,
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
 * Module 10 Phase 10.2 — Social Media AI Generation Foundation (e2e).
 *
 * SocialGenerationService is instantiated directly against real Postgres
 * (same technique agent-executor.e2e-spec.ts already established), with a
 * custom AgentRegistry/AIProviderRegistry per test so caption/hashtag
 * outputs — and failures — are fully deterministic and zero-spend, while
 * PrismaService/AuditService/ContentPermissionResolver/ContentBodyValidator
 * are the real, DI-resolved instances from the one bootstrapped app.
 * AgentKeyedFakeProvider (below) exists because SocialCaptionAgent and
 * HashtagAgent share providerPreference.provider "openai" — one
 * registered provider instance must answer differently per
 * request.agentName, the same reasoning VideoUatFixtureProvider's own doc
 * comment gives for keying off agentName.
 *
 * One additional suite ("real HTTP path") proves the controller/module
 * wiring and RBAC enforcement at the true system boundary, overriding
 * AI_PROVIDER_REGISTRY via bootstrapE2eApp's own configureModule escape
 * hatch (the identical pattern research.e2e-spec.ts already uses for
 * RESEARCH_SOURCE_PROVIDER).
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

describe("Social Media AI Generation Foundation (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let knowledgePacks: KnowledgePacksService;
  let audit: AuditService;
  let permissions: ContentPermissionResolver;
  let bodyValidator: ContentBodyValidator;
  let contentItems: ContentItemsService;
  let ownerUserId: string;

  interface Workspace {
    id: string;
    publicId: string;
  }

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
    knowledgePacks = ctx.app.get(KnowledgePacksService);
    audit = ctx.app.get(AuditService);
    permissions = ctx.app.get(ContentPermissionResolver);
    bodyValidator = ctx.app.get(ContentBodyValidator);
    contentItems = ctx.app.get(ContentItemsService);
    ownerUserId = (await ctx.prisma.user.findUniqueOrThrow({ where: { publicId: owner.publicId } })).id;
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const row = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  /** Same FR-KP-005-satisfying flow as agent-executor.e2e-spec.ts's own createActivePack. */
  async function createActivePack(ws: Workspace): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Phase 10.2 Social Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"].map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    return packPublicId;
  }

  /** Direct-Prisma fixture — same established technique as social-domain-foundation.e2e-spec.ts's own createContentItemInWorkspace (one $transaction, satisfying the deferred current_version_id trigger). */
  async function createSourceItem(
    workspaceId: string,
    overrides: { contentType: "BLOG" | "VIDEO" | "SOCIAL_POST"; status: string; title?: string; bodyField?: "content" | "script"; bodyText?: string },
  ): Promise<{ id: string; publicId: string; versionId: string }> {
    const id = randomUUID();
    const publicId = randomUUID();
    const versionId = randomUUID();
    const field = overrides.bodyField ?? (overrides.contentType === "BLOG" ? "content" : "script");
    await ctx.prisma.$transaction(async (tx) => {
      await tx.contentItem.create({ data: { id, publicId, workspaceId, contentType: overrides.contentType, title: overrides.title ?? "Fixture source", status: "DRAFT", createdById: ownerUserId } });
      await tx.contentVersion.create({ data: { id: versionId, publicId: randomUUID(), contentItemId: id, versionNumber: 1, body: { [field]: overrides.bodyText ?? "Home EV charging is simpler than most people expect." }, createdById: ownerUserId } });
      await tx.contentItem.update({ where: { id }, data: { currentVersionId: versionId, status: overrides.status as never } });
    });
    return { id, publicId, versionId };
  }

  function serviceWithFixtures(byAgent: Record<string, Record<string, unknown> | "FAIL">): { service: SocialGenerationService; providerRegistry: AIProviderRegistry; agentRegistry: AgentRegistry } {
    const agentBuilder = new AgentRegistryBuilder();
    agentBuilder.register(SOCIAL_CAPTION_AGENT_V1);
    agentBuilder.register(HASHTAG_AGENT_V1);
    const agentRegistry = agentBuilder.freeze();

    const providerBuilder = new AIProviderRegistryBuilder();
    providerBuilder.register(new AgentKeyedFakeProvider(byAgent));
    const providerRegistry = providerBuilder.freeze();

    const executor = new AgentExecutorService(agentRegistry, providerRegistry, knowledgePacks, ctx.prisma, audit);
    const service = new SocialGenerationService(ctx.prisma, audit, executor, permissions, bodyValidator, contentItems);
    return { service, providerRegistry, agentRegistry };
  }

  const CAPTION_FIXTURE = { caption: "Charging your EV at home is easier than you think.", ctaObjective: "Invite comments about charging speed." };
  const HASHTAG_FIXTURE = { hashtags: ["#ev", "#EV", "#evcharging"] };

  it("Facebook generation context reaches the agent input (Part N #5)", async () => {
    const ws = await createWorkspace();
    const pack = await createActivePack(ws);
    const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED", title: "Home Charging Guide" });
    const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
    const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

    const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
    await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-fb" });

    const captionJob = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, agentName: "social-caption-agent" }, orderBy: { createdAt: "desc" } });
    expect((captionJob.inputPayload as Record<string, unknown>).platform).toBe("FACEBOOK");
  });

  it("Instagram generation context reaches the agent input (Part N #6)", async () => {
    const ws = await createWorkspace();
    const pack = await createActivePack(ws);
    const source = await createSourceItem(ws.id, { contentType: "VIDEO", status: "APPROVED", title: "Charging Walkthrough Video" });
    const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
    const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

    const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
    const result = await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "INSTAGRAM", knowledgePackVersionId: pack }, { correlationId: "corr-ig" });

    const captionJob = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, agentName: "social-caption-agent" }, orderBy: { createdAt: "desc" } });
    expect((captionJob.inputPayload as Record<string, unknown>).platform).toBe("INSTAGRAM");
    expect((captionJob.inputPayload as Record<string, unknown>).sourceContentType).toBe("VIDEO");
    expect(result.platform).toBe("INSTAGRAM");
  });

  describe("source eligibility (Part N #7-11)", () => {
    it("accepts an APPROVED Blog source (#7) and creates exactly one SocialPost (#15)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

      const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
      const result = await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-blog" });

      const created = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: result.publicId as string } });
      const count = await ctx.prisma.socialPost.count({ where: { contentItemId: created.id } });
      expect(count).toBe(1);
    });

    it("accepts an APPROVED Video source (#8)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "VIDEO", status: "APPROVED" });
      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

      const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
      const result = await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "INSTAGRAM", knowledgePackVersionId: pack }, { correlationId: "corr-video" });
      expect(result.contentType).toBe("SOCIAL_POST");
    });

    it("rejects a non-APPROVED (DRAFT) source — no ai_jobs even attempted, no SocialPost (#9)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "DRAFT" });
      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

      const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
      await expect(service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-draft" })).rejects.toThrow();

      const jobCount = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id, agentName: "social-caption-agent" } });
      expect(jobCount).toBe(0);
      const socialCount = await ctx.prisma.socialPost.count({ where: { workspaceId: ws.id } });
      expect(socialCount).toBe(0);
    });

    it("rejects a source from a different workspace as not found (#10)", async () => {
      const wsA = await createWorkspace();
      const wsB = await createWorkspace();
      const packA = await createActivePack(wsA);
      const sourceInB = await createSourceItem(wsB.id, { contentType: "BLOG", status: "APPROVED" });
      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

      const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
      await expect(service.createFromSource(wsA, actor, { sourceContentItemId: sourceInB.publicId, platform: "FACEBOOK", knowledgePackVersionId: packA }, { correlationId: "corr-cross-ws" })).rejects.toMatchObject({
        response: { code: "SOCIAL_SOURCE_NOT_FOUND" },
      });
    });

    it("rejects an unsupported source type (SOCIAL_POST-as-source) (#11)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "SOCIAL_POST", status: "APPROVED", bodyField: "content" });
      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

      const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
      await expect(service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-social-source" })).rejects.toMatchObject({
        response: { code: "SOCIAL_SOURCE_CONTENT_TYPE_UNSUPPORTED" },
      });
    });
  });

  it("source content is never mutated by generation (#12)", async () => {
    const ws = await createWorkspace();
    const pack = await createActivePack(ws);
    const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED", bodyText: "Original approved body text." });
    const before = await ctx.prisma.contentItem.findFirstOrThrow({ where: { id: source.id } });
    const beforeVersion = await ctx.prisma.contentVersion.findFirstOrThrow({ where: { id: source.versionId } });
    const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
    const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

    const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
    await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-unchanged" });

    const after = await ctx.prisma.contentItem.findFirstOrThrow({ where: { id: source.id } });
    const afterVersion = await ctx.prisma.contentVersion.findFirstOrThrow({ where: { id: source.versionId } });
    expect(after.status).toBe(before.status);
    expect(after.currentVersionId).toBe(before.currentVersionId);
    expect(afterVersion.body).toEqual(beforeVersion.body);
  });

  describe("no-placeholder, generate-then-create discipline (Part N #13-14, #20)", () => {
    it("a failed caption generation creates no SOCIAL_POST (#13)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

      const { service } = serviceWithFixtures({ "social-caption-agent": "FAIL", "hashtag-agent": HASHTAG_FIXTURE });
      await expect(service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-fail-caption" })).rejects.toMatchObject({
        response: { code: "SOCIAL_CAPTION_GENERATION_FAILED" },
      });

      expect(await ctx.prisma.contentItem.count({ where: { workspaceId: ws.id, contentType: "SOCIAL_POST" } })).toBe(0);
      expect(await ctx.prisma.socialPost.count({ where: { workspaceId: ws.id } })).toBe(0);
      // The caption ai_jobs row IS real execution evidence, per the checkpoint's own "AIJob records may still exist" allowance.
      expect(await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id, agentName: "social-caption-agent", status: "FAILED" } })).toBe(1);
    });

    it("a failed hashtag generation (after a successful caption) creates no SOCIAL_POST (#13)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

      const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": "FAIL" });
      await expect(service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-fail-hashtag" })).rejects.toMatchObject({
        response: { code: "SOCIAL_HASHTAG_GENERATION_FAILED" },
      });

      expect(await ctx.prisma.contentItem.count({ where: { workspaceId: ws.id, contentType: "SOCIAL_POST" } })).toBe(0);
      expect(await ctx.prisma.socialPost.count({ where: { workspaceId: ws.id } })).toBe(0);
      expect(await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id, agentName: "social-caption-agent", status: "COMPLETED" } })).toBe(1);
    });

    it("invalid (schema-violating) AI output creates no SOCIAL_POST (#14)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
      const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
      const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

      // Missing the required `caption` field entirely — fails structured-output schema validation inside AgentExecutorService, terminal FAILED.
      const { service } = serviceWithFixtures({ "social-caption-agent": { ctaObjective: "no caption at all" }, "hashtag-agent": HASHTAG_FIXTURE });
      await expect(service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-invalid-output" })).rejects.toMatchObject({
        response: { code: "SOCIAL_CAPTION_GENERATION_FAILED" },
      });
      expect(await ctx.prisma.socialPost.count({ where: { workspaceId: ws.id } })).toBe(0);
    });
  });

  it("successful generation creates a real SocialPost extension row, ContentVersion v1, and correct currentVersion linkage (#16-19)", async () => {
    const ws = await createWorkspace();
    const pack = await createActivePack(ws);
    const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
    const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
    const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

    const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
    const result = await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-happy" });

    const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: result.publicId as string } });
    const socialPost = await ctx.prisma.socialPost.findFirstOrThrow({ where: { contentItemId: item.id } });
    const version = await ctx.prisma.contentVersion.findFirstOrThrow({ where: { id: item.currentVersionId! } });

    expect(item.contentType).toBe("SOCIAL_POST");
    expect(socialPost.platform).toBe("FACEBOOK");
    expect(socialPost.sourceContentItemId).toBe(source.id);
    expect(version.versionNumber).toBe(1);
    expect(item.currentVersionId).toBe(version.id);

    const body = version.body as Record<string, unknown>;
    expect(body.caption).toBe(CAPTION_FIXTURE.caption);
    // HASHTAG_FIXTURE is ["#ev", "#EV", "#evcharging"] — "#EV" dedupes into "#ev" (case-insensitive), "#evcharging" is a genuinely distinct tag and survives.
    expect(body.hashtags).toEqual(["#ev", "#evcharging"]);
  });

  it("ContentVersion body contains real, deduplicated hashtags — never a placeholder (#19-20)", async () => {
    const ws = await createWorkspace();
    const pack = await createActivePack(ws);
    const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
    const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
    const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

    const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": { hashtags: ["#ev", "#EVCharging", "#evcharging"] } });
    const result = await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "INSTAGRAM", knowledgePackVersionId: pack }, { correlationId: "corr-hashtags" });

    const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: result.publicId as string } });
    const version = await ctx.prisma.contentVersion.findFirstOrThrow({ where: { id: item.currentVersionId! } });
    const body = version.body as Record<string, unknown>;

    expect(body.hashtags).toEqual(["#ev", "#EVCharging"]);
    expect(body.caption).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/pending_generation|placeholder|queue.?status|job.?status/i);
  });

  it("generation provenance is captured — SocialVersionGeneration references real, correctly-named ai_jobs rows (#21, updated Phase 10.3: provenance moved from SocialPost to a per-version record — see SocialVersionGeneration's own doc comment)", async () => {
    const ws = await createWorkspace();
    const pack = await createActivePack(ws);
    const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
    const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
    const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

    const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
    const result = await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-provenance" });

    const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: result.publicId as string } });
    const socialPost = await ctx.prisma.socialPost.findFirstOrThrow({ where: { contentItemId: item.id } });
    const generation = await ctx.prisma.socialVersionGeneration.findFirstOrThrow({ where: { socialPostId: socialPost.id } });
    const captionJob = await ctx.prisma.aiJob.findFirstOrThrow({ where: { id: generation.captionAiJobId } });
    const hashtagJob = await ctx.prisma.aiJob.findFirstOrThrow({ where: { id: generation.hashtagAiJobId } });

    expect(captionJob.agentName).toBe("social-caption-agent");
    expect(captionJob.status).toBe("COMPLETED");
    expect(hashtagJob.agentName).toBe("hashtag-agent");
    expect(hashtagJob.status).toBe("COMPLETED");
    expect(captionJob.id).not.toBe(hashtagJob.id);
  });

  it("source-version provenance points at the EXACT version generation used, not just the source item (#22)", async () => {
    const ws = await createWorkspace();
    const pack = await createActivePack(ws);
    const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
    const ownerRow = await ctx.prisma.user.findFirstOrThrow({ where: { id: ownerUserId } });
    const actor = { publicId: ownerRow.publicId, internalId: ownerUserId };

    const { service } = serviceWithFixtures({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE });
    const result = await service.createFromSource(ws, actor, { sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack }, { correlationId: "corr-source-version" });

    const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: result.publicId as string } });
    const socialPost = await ctx.prisma.socialPost.findFirstOrThrow({ where: { contentItemId: item.id } });
    expect(socialPost.sourceContentVersionId).toBe(source.versionId);

    // A later edit to the source producing v2 must NOT retroactively change this row's own provenance.
    const v2Id = randomUUID();
    await ctx.prisma.$transaction(async (tx) => {
      await tx.contentVersion.create({ data: { id: v2Id, publicId: randomUUID(), contentItemId: source.id, versionNumber: 2, body: { content: "A revised approved body." }, createdById: ownerUserId } });
      await tx.contentItem.update({ where: { id: source.id }, data: { currentVersionId: v2Id } });
    });
    const socialPostAfter = await ctx.prisma.socialPost.findFirstOrThrow({ where: { contentItemId: item.id } });
    expect(socialPostAfter.sourceContentVersionId).toBe(source.versionId);
    expect(socialPostAfter.sourceContentVersionId).not.toBe(v2Id);
  });

  describe("RBAC enforced at the real HTTP boundary (Part N #23)", () => {
    it("a member holding SOCIAL_CREATE (Content Writer) can POST /social-posts — 201, real generation runs", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
      const writer = await createActiveUserAndLogin(ctx, "social-writer");
      await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Content Writer");

      const overrideApp = await bootstrapE2eApp((builder) =>
        builder.overrideProvider(AI_PROVIDER_REGISTRY).useFactory({
          factory: () => {
            const builder2 = new AIProviderRegistryBuilder();
            builder2.register(new AgentKeyedFakeProvider({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE }));
            return builder2.freeze();
          },
        }),
      );
      try {
        const res = await request(overrideApp.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/social-posts`)
          .set("Authorization", `Bearer ${writer.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack })
          .expect(201);
        expect(res.body.data.contentType).toBe("SOCIAL_POST");
      } finally {
        await teardownE2eApp(overrideApp);
      }
    });

    it("a member WITHOUT SOCIAL_CREATE (Video Editor) gets 403 — no generation is ever triggered", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, { contentType: "BLOG", status: "APPROVED" });
      const videoEditor = await createActiveUserAndLogin(ctx, "social-video-editor");
      await addActiveMemberWithRole(ctx, ws.id, videoEditor.userId, "Video Editor");

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/social-posts`)
        .set("Authorization", `Bearer ${videoEditor.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ sourceContentItemId: source.publicId, platform: "FACEBOOK", knowledgePackVersionId: pack })
        .expect(403);

      expect(await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id, agentName: "social-caption-agent" } })).toBe(0);
    });
  });
});
