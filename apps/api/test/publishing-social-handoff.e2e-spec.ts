import { randomUUID } from "crypto";
import { AIProviderError, AIProviderErrorCode, AIProviderRegistryBuilder, parseStructuredOutput, type AIModelCapability, type AIProvider, type AIRequest, type AIResponse } from "@myev/shared";
import { AI_PROVIDER_REGISTRY } from "../src/modules/ai-agents/ai-provider-registry.module";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 10 Phase 10.4 — Social approval -> Module 9 publishing-metadata
 * handoff, and the Publishing candidate-query extension.
 *
 * Deliberately does NOT test Facebook/Instagram getCapabilities()/publish()
 * accepting SOCIAL_POST, or WordPress/YouTube rejection of it — this
 * phase's own completion report explains why that remains BLOCKED (both
 * Meta connectors are hardcoded VIDEO-only with a mandatory rendered
 * media artifact; Instagram's Graph API has no caption-only post
 * capability at all). This file proves everything that phase actually
 * shipped: the metadata handoff (atomic with approval) and candidate
 * listing — both real, both independent of the blocked provider-execution
 * piece.
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
const HASHTAG_FIXTURE = { hashtags: ["#ev", "#EV", "#evcharging"] };

describe("Social approval -> Module 9 publishing-metadata handoff (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let ownerUserId: string;

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
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  function auth(workspacePublicId: string) {
    return { Authorization: `Bearer ${ownerAccessToken}`, "X-Workspace-Id": workspacePublicId };
  }

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const row = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  async function createActivePack(ws: Workspace): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set(auth(ws.publicId))
      .send({ name: "Phase 10.4 Handoff Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set(auth(ws.publicId))
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"].map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`).set(auth(ws.publicId)).expect(200);
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

  async function createSocialPost(ws: Workspace, sourcePublicId: string, pack: string): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/social-posts`)
      .set(auth(ws.publicId))
      .send({ sourceContentItemId: sourcePublicId, platform: "FACEBOOK", knowledgePackVersionId: pack })
      .expect(201);
    return res.body.data.publicId as string;
  }

  async function approveViaReview(ws: Workspace, itemPublicId: string): Promise<void> {
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ws.publicId)).send({}).expect(200);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(ws.publicId)).send({}).expect(200);
  }

  async function directContentItem(workspaceId: string, contentType: string, status: string, deletedAt: Date | null = null): Promise<{ id: string; publicId: string }> {
    const id = randomUUID();
    const publicId = randomUUID();
    const versionId = randomUUID();
    await ctx.prisma.$transaction(async (tx) => {
      await tx.contentItem.create({ data: { id, publicId, workspaceId, contentType: contentType as never, title: "Direct fixture", status: status as never, createdById: ownerUserId } });
      await tx.contentVersion.create({ data: { id: versionId, publicId: randomUUID(), contentItemId: id, versionNumber: 1, body: { content: "fixture", script: "fixture" }, createdById: ownerUserId } });
      await tx.contentItem.update({ where: { id }, data: { currentVersionId: versionId, deletedAt: deletedAt ?? undefined } });
    });
    return { id, publicId };
  }

  describe("approval -> metadata.publishing.caption handoff", () => {
    it("writes publishing.caption from the exact approved ContentVersion, deterministically composed with normalized hashtags, excluding ctaObjective (#1-5)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      await approveViaReview(ws, itemPublicId);

      const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      const version = await ctx.prisma.contentVersion.findFirstOrThrow({ where: { id: item.currentVersionId! } });
      const body = version.body as Record<string, unknown>;
      const metadata = item.metadata as Record<string, unknown>;
      const publishing = metadata.publishing as Record<string, unknown>;

      expect(publishing.caption).toBe(`${body.caption}\n\n${(body.hashtags as string[]).join(" ")}`);
      expect(publishing.caption).not.toContain((body.ctaObjective as string) ?? " never-match ");
      expect(publishing.caption).toBe(`${CAPTION_FIXTURE.caption}\n\n#ev #evcharging`);
    });

    it("preserves unrelated existing metadata fields (#6)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      await ctx.prisma.contentItem.update({ where: { id: item.id }, data: { metadata: { unrelatedFlag: true, publishing: { description: "pre-existing description", privacy: "public" } } } });

      await approveViaReview(ws, itemPublicId);

      const after = await ctx.prisma.contentItem.findFirstOrThrow({ where: { id: item.id } });
      const metadata = after.metadata as Record<string, unknown>;
      const publishing = metadata.publishing as Record<string, unknown>;
      expect(metadata.unrelatedFlag).toBe(true);
      expect(publishing.description).toBe("pre-existing description");
      expect(publishing.privacy).toBe("public");
      expect(publishing.caption).toBeTruthy();
    });

    it("approval succeeds with no connected Meta account at all (#7)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      // No publishing/accounts/* call anywhere in this test — approval must not require one.
      await approveViaReview(ws, itemPublicId);
      const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      expect(item.status).toBe("APPROVED");
    });

    it("does not auto-create a Publication or a publishing job on approval (#8, #9)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      await approveViaReview(ws, itemPublicId);

      const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      expect(await ctx.prisma.publication.count({ where: { contentItemId: item.id } })).toBe(0);
      expect(await ctx.prisma.backgroundJob.count({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } })).toBe(0);
    });
  });

  describe("re-review after rejection refreshes the caption (#29, #30, #31)", () => {
    it("rejecting, editing, and re-approving replaces only the caption with the newly approved content; the prior version stays immutable", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      await approveViaReview(ws, itemPublicId);

      const itemAfterFirstApproval = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      const v1Id = itemAfterFirstApproval.currentVersionId!;
      const v1Before = await ctx.prisma.contentVersion.findFirstOrThrow({ where: { id: v1Id } });
      const genCountBefore = await ctx.prisma.socialVersionGeneration.count({ where: { contentItemId: itemAfterFirstApproval.id } });

      // Approved content can't be edited directly — reject requires REVIEW, and this item is APPROVED.
      // Simulate the real re-review path: this phase doesn't add an "unapprove" action, so drive it
      // via the generic lifecycle directly for this fixture-only step (mirrors established test-fixture technique).
      await ctx.prisma.contentItem.update({ where: { id: itemAfterFirstApproval.id }, data: { status: "REVIEW" } });
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/reject`)
        .set(auth(ws.publicId))
        .send({ comment: "needs a stronger hook" })
        .expect(200);

      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`)
        .set(auth(ws.publicId))
        .send({ caption: "A revised, human-edited caption for round two." })
        .expect(200);

      await approveViaReview(ws, itemPublicId);

      const itemAfterSecondApproval = await ctx.prisma.contentItem.findFirstOrThrow({ where: { id: itemAfterFirstApproval.id } });
      const v2Id = itemAfterSecondApproval.currentVersionId!;
      expect(v2Id).not.toBe(v1Id);

      const metadata = itemAfterSecondApproval.metadata as Record<string, unknown>;
      const publishing = metadata.publishing as Record<string, unknown>;
      expect(publishing.caption).toContain("A revised, human-edited caption for round two.");

      const v1After = await ctx.prisma.contentVersion.findUniqueOrThrow({ where: { id: v1Id } });
      expect(v1After.body).toEqual(v1Before.body);

      const genCountAfter = await ctx.prisma.socialVersionGeneration.count({ where: { contentItemId: itemAfterFirstApproval.id } });
      expect(genCountAfter).toBe(genCountBefore);
    });
  });

  describe("Publishing candidate query (Part I)", () => {
    it("unapproved SocialPost is absent, APPROVED SocialPost appears (#10, #11)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);

      const beforeApproval = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/content-candidates`).set(auth(ws.publicId)).expect(200);
      expect((beforeApproval.body.data as Array<{ publicId: string }>).some((c) => c.publicId === itemPublicId)).toBe(false);

      await approveViaReview(ws, itemPublicId);

      const afterApproval = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/content-candidates`).set(auth(ws.publicId)).expect(200);
      const found = (afterApproval.body.data as Array<{ publicId: string; contentType: string }>).find((c) => c.publicId === itemPublicId);
      expect(found?.contentType).toBe("SOCIAL_POST");
    });

    it("deleted and archived SocialPost are excluded (#12, #13)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);

      const source1 = await createSourceItem(ws.id);
      const deletedItem = await createSocialPost(ws, source1.publicId, pack);
      await approveViaReview(ws, deletedItem);
      await request(ctx.app.getHttpServer()).delete(`/api/v1/workspaces/${ws.publicId}/content-items/${deletedItem}`).set(auth(ws.publicId)).expect(200);

      const source2 = await createSourceItem(ws.id);
      const archivedItem = await createSocialPost(ws, source2.publicId, pack);
      await approveViaReview(ws, archivedItem);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${archivedItem}/archive`).set(auth(ws.publicId)).expect(200);

      const candidates = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/content-candidates`).set(auth(ws.publicId)).expect(200);
      const ids = (candidates.body.data as Array<{ publicId: string }>).map((c) => c.publicId);
      expect(ids).not.toContain(deletedItem);
      expect(ids).not.toContain(archivedItem);
    });

    it("cross-workspace SocialPost is excluded (#14)", async () => {
      const wsA = await createWorkspace();
      const wsB = await createWorkspace();
      const pack = await createActivePack(wsA);
      const source = await createSourceItem(wsA.id);
      const itemPublicId = await createSocialPost(wsA, source.publicId, pack);
      await approveViaReview(wsA, itemPublicId);

      const candidatesB = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${wsB.publicId}/publishing/publications/content-candidates`).set(auth(wsB.publicId)).expect(200);
      expect((candidatesB.body.data as Array<{ publicId: string }>).some((c) => c.publicId === itemPublicId)).toBe(false);
    });

    it("BLOG and VIDEO candidate behavior is unchanged (#15, #16)", async () => {
      const ws = await createWorkspace();
      const blog = await directContentItem(ws.id, "BLOG", "APPROVED");
      const video = await directContentItem(ws.id, "VIDEO", "APPROVED");

      const candidates = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/content-candidates`).set(auth(ws.publicId)).expect(200);
      const byId = new Map((candidates.body.data as Array<{ publicId: string; contentType: string }>).map((c) => [c.publicId, c.contentType]));
      expect(byId.get(blog.publicId)).toBe("BLOG");
      expect(byId.get(video.publicId)).toBe("VIDEO");
    });

    it("SHORT, REEL, and NEWSLETTER remain unsupported — never listed as candidates even when APPROVED (#17, #18, #19)", async () => {
      const ws = await createWorkspace();
      for (const contentType of ["SHORT", "REEL", "NEWSLETTER"]) {
        const item = await directContentItem(ws.id, contentType, "APPROVED");
        const candidates = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/content-candidates`).set(auth(ws.publicId)).expect(200);
        expect((candidates.body.data as Array<{ publicId: string }>).some((c) => c.publicId === item.publicId)).toBe(false);
      }
    });
  });
});
