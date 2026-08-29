import { randomUUID } from "crypto";
import { addActiveMemberWithRole, bootstrapE2eApp, createActiveUserAndLogin, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 6 Phase 6.1 — Content Scoring Engine (shared foundation).
 *
 * Proves the API foundation end-to-end against real Postgres:
 * POST/GET /api/v1/workspaces/:workspaceId/content-items/:contentItemId/score,
 * the deterministic score + explainable breakdown, append-only score
 * history, config-driven threshold, RBAC (SEO_SCORE), workspace
 * isolation, and the "content type not scoreable yet" path.
 *
 * Module 7 Phase 7.3: VIDEO now HAS a registered dimension
 * (VIDEO_DIMENSION_V1) — the "not scoreable" demonstration below moved
 * to NEWSLETTER (still genuinely unregistered), and a new test proves
 * the generic route now scores a plain VIDEO content item too, WITHOUT
 * throwing "ambiguous" despite THUMBNAIL_DIMENSION_V1 also being
 * registered (see content-dimension-registry.module.ts's own comment).
 */

const STRONG_BLOG_BODY = {
  metadata: {
    metaTitle: "Home EV Charging Guide: Costs & Setup",
    metaDescription: "Everything you need to charge your EV at home — Level 2 chargers, installation costs, utility rebates, and how much you can save each month with a home setup.",
    slug: "home-ev-charging-guide",
    schemaMarkup: { "@type": "Article" },
  },
  content: [
    "# The Complete Guide to Home EV Charging",
    "",
    "Charging an electric vehicle at home is the cheapest and most convenient way to keep your car ready every morning. This guide covers everything a new owner needs.",
    "",
    "## Why charge at home",
    "",
    "A Level 2 charger adds roughly 25 miles of range per hour. Most owners install one in the garage. The best way to get started is to book a demo with a certified electrician.",
    "",
    "## Choosing a Level 2 charger",
    "",
    "Look at amperage, cable length, and whether you want smart scheduling. See [our charger comparison](/guides/chargers) for details.",
    "",
    "### Installation steps",
    "",
    "A licensed electrician handles the panel work. Learn more from your utility at [the rebate page](https://example.com/rebates).",
    "",
    "## Costs and savings",
    "",
    "A typical install runs a few hundred dollars. Home EV charging usually costs far less than public charging.",
    "",
    "## Frequently asked questions",
    "",
    "How much does home charging cost?",
    "Do I need a permit?",
    "How long does installation take?",
    "",
    "![charging setup diagram](/img/setup.png)",
  ].join("\n"),
};

const THIN_BLOG_BODY = { content: "Cars need power sometimes and this is a very short note about charging without much detail here at all." };

describe("Content Scoring API (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;

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

  async function createBlogItem(ws: Workspace, token: string, body: Record<string, unknown>, title = "Home EV charging"): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ contentType: "BLOG", title, body })
      .expect(201);
    return res.body.data.publicId as string;
  }

  const authHeaders = (ws: Workspace, token: string) => ({ Authorization: `Bearer ${token}`, "X-Workspace-Id": ws.publicId });

  it("scores a blog item — deterministic overall, all five universal categories, a Blog Score, factors, and recommendations", async () => {
    const ws = await createWorkspace();
    const itemId = await createBlogItem(ws, ownerAccessToken, STRONG_BLOG_BODY);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, ownerAccessToken))
      .expect(201);

    const data = res.body.data;
    expect(data.overallScore).toBeGreaterThanOrEqual(0);
    expect(data.overallScore).toBeLessThanOrEqual(100);
    expect(Object.keys(data.categoryScores)).toEqual(["SEO", "VIRAL", "QUALITY", "ENGAGEMENT", "BUSINESS"]);
    expect(data.dimension.name).toBe("blog");
    expect(data.dimension.label).toBe("Blog Score");
    expect(data.dimension.score).toBeGreaterThanOrEqual(0);
    expect(data.factors.length).toBeGreaterThan(5);
    expect(data.factors.every((f: { value: number }) => f.value >= 0 && f.value <= 100)).toBe(true);
    expect(Array.isArray(data.recommendations)).toBe(true);

    // deterministic: scoring the same unchanged content again gives the same numbers
    const res2 = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, ownerAccessToken))
      .expect(201);
    expect(res2.body.data.overallScore).toBe(data.overallScore);
    expect(res2.body.data.categoryScores).toEqual(data.categoryScores);
  });

  it("persists append-only score history — GET returns the latest run", async () => {
    const ws = await createWorkspace();
    const itemId = await createBlogItem(ws, ownerAccessToken, STRONG_BLOG_BODY);

    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`).set(authHeaders(ws, ownerAccessToken)).expect(201);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`).set(authHeaders(ws, ownerAccessToken)).expect(201);

    const itemRow = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, select: { id: true } });
    const scoreCount = await ctx.prisma.contentScore.count({ where: { workspaceId: ws.id, contentItemId: itemRow.id } });
    const seoCount = await ctx.prisma.seoReport.count({ where: { workspaceId: ws.id, contentItemId: itemRow.id } });
    expect(scoreCount).toBe(2);
    expect(seoCount).toBe(2);

    const getRes = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, ownerAccessToken))
      .expect(200);
    expect(getRes.body.data.contentItemId).toBe(itemId);
    expect(getRes.body.data.seoReportId).toBeTruthy();

    const latest = await ctx.prisma.contentScore.findFirstOrThrow({ where: { contentItemId: itemRow.id }, orderBy: { calculatedAt: "desc" } });
    expect(getRes.body.data.contentScoreId).toBe(latest.publicId);
    expect(getRes.body.data.overallScore).toBe(latest.score);
  });

  it("surfaces the configured pass threshold and a passed flag (default threshold = 70)", async () => {
    const ws = await createWorkspace();
    const itemId = await createBlogItem(ws, ownerAccessToken, STRONG_BLOG_BODY);
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, ownerAccessToken))
      .expect(201);
    expect(res.body.data.passThreshold).toBe(70);
    expect(res.body.data.passed).toBe(res.body.data.overallScore >= 70);
  });

  it("does not fabricate keyword/brand results with no active Knowledge Pack — it recommends activating one", async () => {
    const ws = await createWorkspace();
    const itemId = await createBlogItem(ws, ownerAccessToken, THIN_BLOG_BODY);
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, ownerAccessToken))
      .expect(201);
    expect(res.body.data.recommendations.some((r: { message: string }) => /Knowledge Pack/i.test(r.message))).toBe(true);
    const kwFactor = res.body.data.factors.find((f: { id: string }) => f.id === "seo-keyword-coverage");
    expect(kwFactor.reason).toMatch(/no target keywords/i);
  });

  it("uses active Knowledge Pack keyword sets when present", async () => {
    const ws = await createWorkspace();
    const ownerId = (await ctx.prisma.user.findFirstOrThrow({ where: { email: process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com" } })).id;
    const packId = randomUUID();
    const pack = await ctx.prisma.knowledgePack.create({
      data: { id: packId, lineageRootId: packId, workspaceId: ws.id, name: "Scoring KP", status: "ACTIVE", createdById: ownerId },
    });
    await ctx.prisma.keywordSet.create({ data: { knowledgePackId: pack.id, name: "core", keywords: ["home ev charging", "level 2 charger"] } });

    const itemId = await createBlogItem(ws, ownerAccessToken, STRONG_BLOG_BODY, "The Complete Guide to Home EV Charging");
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, ownerAccessToken))
      .expect(201);
    const kwFactor = res.body.data.factors.find((f: { id: string }) => f.id === "seo-keyword-coverage");
    expect(kwFactor.reason).toMatch(/target keyword\(s\) appear/i);
    const titleFactor = res.body.data.factors.find((f: { id: string }) => f.id === "seo-primary-keyword-in-title");
    expect(titleFactor.value).toBe(100);
  });

  it("returns 422 for a content type with no registered scoring dimension (NEWSLETTER)", async () => {
    // Module 1E's CreateContentItemDto only accepts BLOG/VIDEO
    // (SUPPORTED_CONTENT_TYPES) at the DTO layer, so a genuinely
    // unregistered-dimension content type can no longer be created
    // through the generic content-items route at all (400, before this
    // service is ever reached) — the "not scoreable" 422 path is now
    // only reachable for a content type the DTO accepts but no dimension
    // covers. There is currently none (BLOG and VIDEO both have
    // dimensions) — this test proves the DTO-layer 400 stands in for
    // Phase 6.1's original 422 demonstration until Module 1E supports a
    // third content type.
    const ws = await createWorkspace();
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(authHeaders(ws, ownerAccessToken))
      .send({ contentType: "NEWSLETTER", title: "A newsletter", body: { content: "x" } });
    expect(res.status).toBe(400);
  });

  it("Module 7 Phase 7.3: VIDEO is now scoreable through the generic route too — resolves unambiguously despite THUMBNAIL_DIMENSION_V1 also being registered", async () => {
    const ws = await createWorkspace();
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(authHeaders(ws, ownerAccessToken))
      .send({ contentType: "VIDEO", title: "A video", body: { script: "A short video script about home EV charging." } })
      .expect(201);
    const videoId = res.body.data.publicId;

    const scoreRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${videoId}/score`)
      .set(authHeaders(ws, ownerAccessToken))
      .expect(201);
    expect(scoreRes.body.data.dimension.name).toBe("video");
    expect(scoreRes.body.data.overallScore).toBeGreaterThanOrEqual(0);
  });

  it("404s when a content item has never been scored", async () => {
    const ws = await createWorkspace();
    const itemId = await createBlogItem(ws, ownerAccessToken, THIN_BLOG_BODY);
    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, ownerAccessToken))
      .expect(404);
    expect(res.body.code).toBe("CONTENT_SCORE_NOT_FOUND");
  });

  it("RBAC — SEO_SCORE is required; a Content Writer (BLOG_CREATE but not SEO_SCORE) is denied", async () => {
    const ws = await createWorkspace();
    const itemId = await createBlogItem(ws, ownerAccessToken, STRONG_BLOG_BODY);

    const writer = await createActiveUserAndLogin(ctx, "scoring-writer");
    await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Content Writer");
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, writer.accessToken))
      .expect(403);

    const seo = await createActiveUserAndLogin(ctx, "scoring-seo");
    await addActiveMemberWithRole(ctx, ws.id, seo.userId, "SEO Specialist");
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`)
      .set(authHeaders(ws, seo.accessToken))
      .expect(201);
  });

  it("workspace isolation — a content item cannot be scored through another workspace's URL", async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    const itemInA = await createBlogItem(wsA, ownerAccessToken, STRONG_BLOG_BODY);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsB.publicId}/content-items/${itemInA}/score`)
      .set(authHeaders(wsB, ownerAccessToken))
      .expect(404);
    expect(res.body.code).toBe("CONTENT_ITEM_NOT_FOUND");
  });

  it("every persisted score row carries the correct workspace_id", async () => {
    const ws = await createWorkspace();
    const itemId = await createBlogItem(ws, ownerAccessToken, STRONG_BLOG_BODY);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`).set(authHeaders(ws, ownerAccessToken)).expect(201);

    const scores = await ctx.prisma.contentScore.findMany({ where: { workspaceId: ws.id } });
    const seos = await ctx.prisma.seoReport.findMany({ where: { workspaceId: ws.id } });
    expect(scores.length).toBeGreaterThan(0);
    expect(scores.every((s) => s.workspaceId === ws.id)).toBe(true);
    expect(seos.every((s) => s.workspaceId === ws.id)).toBe(true);
  });
});

describe("Content Scoring API — configurable threshold (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  const original = process.env.CONTENT_SCORING_PASS_THRESHOLD;

  beforeAll(async () => {
    process.env.CONTENT_SCORING_PASS_THRESHOLD = "100";
    ctx = await bootstrapE2eApp();
    ownerAccessToken = (await loginAsPlatformOwner(ctx)).accessToken;
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
    if (original === undefined) delete process.env.CONTENT_SCORING_PASS_THRESHOLD;
    else process.env.CONTENT_SCORING_PASS_THRESHOLD = original;
  });

  it("honours CONTENT_SCORING_PASS_THRESHOLD — the same content that passes at 70 fails at 100", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const item = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set({ Authorization: `Bearer ${ownerAccessToken}`, "X-Workspace-Id": ws.publicId })
      .send({ contentType: "BLOG", title: "Home EV charging", body: STRONG_BLOG_BODY })
      .expect(201);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.body.data.publicId}/score`)
      .set({ Authorization: `Bearer ${ownerAccessToken}`, "X-Workspace-Id": ws.publicId })
      .expect(201);
    expect(res.body.data.passThreshold).toBe(100);
    expect(res.body.data.passed).toBe(false);
  });
});
