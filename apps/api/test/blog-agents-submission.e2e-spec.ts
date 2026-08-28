import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 6 Phase 6.2 — proves the four Blog pipeline agents are
 * registered in apps/api's AgentRegistry and submittable through the
 * EXISTING generic durable AI Job API (no Blog-specific endpoint in this
 * phase): valid input → 202 QUEUED with the exact Knowledge Pack version
 * recorded; invalid input → 422; and the additive blog_articles schema's
 * FK / 1:1 / workspace-safety guarantees hold.
 */
describe("Blog agents — generic AI Job submission + blog_articles schema (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  const ALL_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"];

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    ownerAccessToken = (await loginAsPlatformOwner(ctx)).accessToken;
  });
  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  interface Workspace {
    id: string;
    publicId: string;
  }
  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const row = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }
  const auth = (ws: Workspace) => ({ Authorization: `Bearer ${ownerAccessToken}`, "X-Workspace-Id": ws.publicId });

  async function createActivePack(ws: Workspace): Promise<string> {
    const create = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set(auth(ws))
      .send({ name: "Blog Agents Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packId = create.body.data.publicId as string;
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}`)
      .set(auth(ws))
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ALL_CONTENT_TYPES.map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}/validate`).set(auth(ws)).expect(200);
    return packId;
  }

  async function cleanupAiJobs(ws: Workspace): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pending = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      const pendingBg = await ctx.prisma.backgroundJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      if (pending === 0 && pendingBg === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await ctx.prisma.aiJob.updateMany({ where: { workspaceId: ws.id }, data: { backgroundJobId: null } });
    const bg = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
    const bgIds = bg.map((b) => b.id);
    if (bgIds.length > 0) {
      await ctx.prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: bgIds } } });
      await ctx.prisma.backgroundJob.deleteMany({ where: { id: { in: bgIds } } });
    }
    await ctx.prisma.aiJobStep.deleteMany({ where: { aiJob: { workspaceId: ws.id } } });
    await ctx.prisma.aiJob.deleteMany({ where: { workspaceId: ws.id } });
  }

  const VALID_INPUT: Record<string, Record<string, unknown>> = {
    "blog-brief-agent": { topic: "Home EV charging" },
    "blog-outline-agent": { topic: "Home EV charging", searchIntent: "informational", targetAudience: "New EV owners", primaryKeyword: "home ev charging", secondaryKeywords: ["level 2 charger"], ctaObjective: "Book an assessment" },
    "blog-draft-agent": {
      topic: "Home EV charging",
      h1: "The Complete Guide to Home EV Charging",
      sections: [{ level: 2, heading: "Why charge at home", purpose: "case" }],
      faqPlan: ["How much does it cost?"],
      primaryKeyword: "home ev charging",
      secondaryKeywords: ["level 2 charger"],
      targetAudience: "New EV owners",
      ctaObjective: "Book an assessment",
    },
    "seo-metadata-agent": { topic: "Home EV charging", title: "The Complete Guide to Home EV Charging", primaryKeyword: "home ev charging", secondaryKeywords: ["level 2 charger"], articleSummary: "How to set up home charging." },
  };

  for (const agentIdentifier of Object.keys(VALID_INPUT)) {
    it(`submits ${agentIdentifier} — 202 QUEUED, exact KP version recorded, ai.execute.v1 background job linked`, async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);

      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
        .set(auth(ws))
        .send({ agentIdentifier, knowledgePackVersionId: packId, input: VALID_INPUT[agentIdentifier] })
        .expect(202);

      expect(res.body.data.status).toBe("QUEUED");
      expect(res.body.data.agentIdentifier).toBe(agentIdentifier);
      expect(res.body.data.agentVersion).toBe(1);
      expect(res.body.data.knowledgePackVersionId).toBe(packId);

      const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { publicId: res.body.data.publicId, workspaceId: ws.id } });
      expect(job.backgroundJobId).toBeTruthy();
      const bg = await ctx.prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.backgroundJobId! } });
      expect(bg.jobType).toBe("ai.execute.v1");

      await cleanupAiJobs(ws);
    });

    it(`rejects ${agentIdentifier} with invalid input — 422, no job created`, async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);

      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
        .set(auth(ws))
        .send({ agentIdentifier, knowledgePackVersionId: packId, input: { unrelated: "garbage" } })
        .expect(422);
      expect(res.body.code).toBeTruthy();

      expect(await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } })).toBe(0);
      await cleanupAiJobs(ws);
    });
  }

  it("an unknown agent identifier is still rejected (404) — the 4 blog agents did not shadow that behaviour", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set(auth(ws))
      .send({ agentIdentifier: "no-such-agent", knowledgePackVersionId: packId, input: {} })
      .expect(404);
    await cleanupAiJobs(ws);
  });

  describe("blog_articles schema (additive)", () => {
    async function createBlogItem(ws: Workspace): Promise<{ publicId: string; id: string }> {
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
        .set(auth(ws))
        .send({ contentType: "BLOG", title: "Home EV charging", body: { content: "draft" } })
        .expect(201);
      const row = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: res.body.data.publicId }, select: { id: true } });
      return { publicId: res.body.data.publicId, id: row.id };
    }
    const ownerId = () => ctx.prisma.user.findFirstOrThrow({ where: { email: process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com" } });

    it("allows exactly one blog_articles row per BLOG content item, in the same workspace", async () => {
      const ws = await createWorkspace();
      const item = await createBlogItem(ws);
      const uid = (await ownerId()).id;

      const created = await ctx.prisma.blogArticle.create({
        data: { workspaceId: ws.id, contentItemId: item.id, metaTitle: "MT", metaDescription: "MD", urlSlug: "home-ev-charging", schemaMarkup: { "@type": "Article" }, createdById: uid },
      });
      expect(created.contentItemId).toBe(item.id);

      // 1:1 — a second row for the same content item is rejected.
      await expect(
        ctx.prisma.blogArticle.create({
          data: { workspaceId: ws.id, contentItemId: item.id, metaTitle: "MT2", metaDescription: "MD2", urlSlug: "dupe", schemaMarkup: {}, createdById: uid },
        }),
      ).rejects.toThrow();

      await ctx.prisma.blogArticle.deleteMany({ where: { workspaceId: ws.id } });
    });

    it("workspace-safe FK: a blog_articles row cannot point at a content item from another workspace", async () => {
      const wsA = await createWorkspace();
      const wsB = await createWorkspace();
      const itemInA = await createBlogItem(wsA);
      const uid = (await ownerId()).id;

      await expect(
        ctx.prisma.blogArticle.create({
          data: { workspaceId: wsB.id, contentItemId: itemInA.id, metaTitle: "MT", metaDescription: "MD", urlSlug: "x", schemaMarkup: {}, createdById: uid },
        }),
      ).rejects.toThrow();

      expect(await ctx.prisma.blogArticle.count({ where: { OR: [{ workspaceId: wsA.id }, { workspaceId: wsB.id }] } })).toBe(0);
    });
  });
});
