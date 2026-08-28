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
 * Module 6 Phase 6.3 — Blog Pipeline orchestration end-to-end.
 *
 * The blog agents have no configured provider in this environment, so a
 * real ai.execute.v1 job FAILS quickly in the background Worker; each
 * test then overwrites the terminal ai_jobs row with a crafted, valid
 * agent output (the established "construct the row directly" technique,
 * see background-job-reconciliation.e2e-spec.ts) and drives the pipeline
 * forward through a GET, which reconciles real ai_jobs state into the
 * pipeline.
 */

const BRIEF_OUTPUT = {
  searchIntent: "informational",
  targetAudience: "New EV owners setting up home charging",
  primaryKeyword: "home ev charging",
  secondaryKeywords: ["level 2 charger", "ev charging cost"],
  ctaObjective: "Book a home charger installation assessment",
  rationale: "A how-to question from buyers who have not yet installed a charger; informational intent with a soft conversion.",
};
const OUTLINE_OUTPUT = {
  h1: "The Complete Guide to Home EV Charging",
  sections: [
    { level: 2, heading: "Why charge at home", purpose: "Establish the cost and convenience case" },
    { level: 2, heading: "Choosing a Level 2 charger", purpose: "Help the reader pick a unit" },
  ],
  faqPlan: ["How much does home charging cost?"],
};
const DRAFT_OUTPUT = {
  introduction:
    "Charging an electric vehicle at home is the cheapest and most convenient way to keep your car ready every morning. This guide walks a new owner through the essentials of home charging.",
  bodySections: [
    { level: 2, heading: "Why charge at home", content: "A home Level 2 setup costs less per mile than public charging and is ready every morning. Most owners install one in the garage within a day." },
    { level: 2, heading: "Choosing a Level 2 charger", content: "Look at amperage, cable length, and smart scheduling. A forty amp unit adds about thirty miles of range each hour for a typical car." },
  ],
  conclusion: "Home charging pays for itself within a year for most drivers who plug in nightly.",
  cta: "Book a free home charger installation assessment today.",
  faqs: [{ question: "How much does home charging cost?", answer: "Usually a few hundred dollars to install, plus your normal electricity rate." }],
};
const SEO_OUTPUT = {
  metaTitle: "Home EV Charging Guide: Costs & Setup",
  metaDescription: "Everything you need to charge your EV at home — Level 2 chargers, install costs, and utility rebates.",
  urlSlug: "home-ev-charging-guide",
  schemaMarkup: { "@type": "Article", headline: "The Complete Guide to Home EV Charging" },
};

interface Workspace {
  id: string;
  publicId: string;
}

function helpers(getCtx: () => E2eApp, getToken: () => string) {
  const ctx = () => getCtx();
  const server = () => getCtx().app.getHttpServer();
  const auth = (ws: Workspace, token = getToken()) => ({ Authorization: `Bearer ${token}`, "X-Workspace-Id": ws.publicId });
  const base = (ws: Workspace) => `/api/v1/workspaces/${ws.publicId}/blog`;

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(getCtx(), getToken());
    const row = await getCtx().prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  async function createActivePack(ws: Workspace): Promise<string> {
    const create = await request(server())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set(auth(ws))
      .send({ name: "Blog Pipeline Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packId = create.body.data.publicId as string;
    await request(server())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}`)
      .set(auth(ws))
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"].map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);
    await request(server()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}/validate`).set(auth(ws)).expect(200);
    return packId;
  }

  async function waitTerminal(ws: Workspace, aiJobPublicId: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const job = await ctx().prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, publicId: aiJobPublicId } });
      if (["COMPLETED", "FAILED", "TIMED_OUT"].includes(job.status)) return job.status;
      await new Promise((r) => setTimeout(r, 100));
    }
    return "QUEUED";
  }

  async function completeStageJob(ws: Workspace, aiJobPublicId: string, output: Record<string, unknown>): Promise<void> {
    await waitTerminal(ws, aiJobPublicId);
    const job = await ctx().prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, publicId: aiJobPublicId } });
    await ctx().prisma.aiJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", outputPayload: output as object, errorCode: null, errorMessageSafe: null, completedAt: new Date() },
    });
    if (job.backgroundJobId) {
      await ctx().prisma.backgroundJob.update({ where: { id: job.backgroundJobId }, data: { status: "COMPLETED" } }).catch(() => undefined);
    }
  }

  async function cleanup(ws: Workspace): Promise<void> {
    // Wait for any in-flight ai.execute.v1 jobs to settle so the Worker
    // can't write a job_history row mid-delete, then drop ai_jobs (+ its
    // dependents) — background_jobs themselves are left for
    // teardownE2eApp, which already tears them down by workspace.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pending = await ctx().prisma.aiJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      const pendingBg = await ctx().prisma.backgroundJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      if (pending === 0 && pendingBg === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await ctx().prisma.keywordCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx().prisma.aiJobStep.deleteMany({ where: { aiJob: { workspaceId: ws.id } } });
    await ctx().prisma.aiJob.deleteMany({ where: { workspaceId: ws.id } });
  }

  const briefJobId = (data: { brief: { aiJobPublicId: string | null } }) => data.brief.aiJobPublicId as string;
  const stageJobId = (data: Record<string, { aiJobPublicId: string | null }>, key: string) => data[key].aiJobPublicId as string;

  async function reconcileGet(ws: Workspace, itemId: string): Promise<Record<string, unknown>> {
    const r = await request(server()).get(`${base(ws)}/${itemId}`).set(auth(ws)).expect(200);
    return r.body.data;
  }

  /** create → brief → approve → outline → approve → draft → SEO → internal-linking → QA → score. Returns itemId + final read model (post-score). */
  async function walkToReadyForReview(ws: Workspace, packId: string): Promise<{ itemId: string; readModel: Record<string, unknown> }> {
    const create = await request(server()).post(base(ws)).set(auth(ws)).send({ topic: "Home EV charging", knowledgePackVersionId: packId }).expect(202);
    const itemId = (create.body.data.contentItem as { publicId: string }).publicId;

    await completeStageJob(ws, briefJobId(create.body.data), BRIEF_OUTPUT);
    await reconcileGet(ws, itemId);
    await request(server()).post(`${base(ws)}/${itemId}/brief/approve`).set(auth(ws)).expect(200);

    const outline = await request(server()).post(`${base(ws)}/${itemId}/outline`).set(auth(ws)).expect(202);
    await completeStageJob(ws, stageJobId(outline.body.data, "outline"), OUTLINE_OUTPUT);
    await reconcileGet(ws, itemId);
    await request(server()).post(`${base(ws)}/${itemId}/outline/approve`).set(auth(ws)).expect(200);

    const draft = await request(server()).post(`${base(ws)}/${itemId}/draft`).set(auth(ws)).expect(202);
    await completeStageJob(ws, stageJobId(draft.body.data, "draft"), DRAFT_OUTPUT);
    await reconcileGet(ws, itemId);

    const seo = await request(server()).post(`${base(ws)}/${itemId}/seo`).set(auth(ws)).expect(202);
    await completeStageJob(ws, stageJobId(seo.body.data, "seo"), SEO_OUTPUT);
    await reconcileGet(ws, itemId);

    await request(server()).post(`${base(ws)}/${itemId}/internal-linking`).set(auth(ws)).expect(200);
    await request(server()).post(`${base(ws)}/${itemId}/qa`).set(auth(ws)).expect(200);
    const scored = await request(server()).post(`${base(ws)}/${itemId}/score`).set(auth(ws)).expect(201);
    return { itemId, readModel: scored.body.data };
  }

  return { ctx, server, auth, base, createWorkspace, createActivePack, waitTerminal, completeStageJob, cleanup, briefJobId, stageJobId, reconcileGet, walkToReadyForReview };
}

// ===========================================================================
describe("Blog pipeline — full workflow (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;
  const originalThreshold = process.env.CONTENT_SCORING_PASS_THRESHOLD;
  const h = helpers(() => ctx, () => ownerToken);

  beforeAll(async () => {
    process.env.CONTENT_SCORING_PASS_THRESHOLD = "1";
    ctx = await bootstrapE2eApp();
    ownerToken = (await loginAsPlatformOwner(ctx)).accessToken;
  });
  afterAll(async () => {
    await teardownE2eApp(ctx);
    if (originalThreshold === undefined) delete process.env.CONTENT_SCORING_PASS_THRESHOLD;
    else process.env.CONTENT_SCORING_PASS_THRESHOLD = originalThreshold;
  });

  it("happy path: topic → brief → approve → outline → approve → draft → SEO → internal-linking → QA → score pass → submit → approve → publish-ready", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId, readModel } = await h.walkToReadyForReview(ws, packId);

    expect(readModel.currentStage).toBe("READY_FOR_REVIEW");
    expect((readModel.scoring as { passed: boolean }).passed).toBe(true);
    expect((readModel.draft as { contentVersionPublicId: string }).contentVersionPublicId).toBeTruthy();
    expect((readModel.seo as { blogArticlePublicId: string }).blogArticlePublicId).toBeTruthy();

    const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, include: { versions: true, blogArticle: true } });
    expect(item.versions.length).toBeGreaterThanOrEqual(2);
    expect(item.currentVersionId).toBeTruthy();
    expect(item.blogArticle?.urlSlug).toBe("home-ev-charging-guide");

    const submitted = await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(200);
    expect((submitted.body.data.contentItem as { status: string }).status).toBe("REVIEW");

    const approved = await request(h.server()).post(`${h.base(ws)}/${itemId}/approve`).set(h.auth(ws)).send({ comment: "LGTM" }).expect(200);
    expect((approved.body.data.contentItem as { status: string }).status).toBe("APPROVED");
    expect(approved.body.data.publishReady).toBe(true);
    expect(approved.body.data.currentStage).toBe("PUBLISH_READY");

    const events = await ctx.prisma.contentReviewEvent.findMany({ where: { contentItem: { publicId: itemId } } });
    expect(events.map((e) => e.action).sort()).toEqual(["APPROVED", "SUBMITTED"]);

    await h.cleanup(ws);
  }, 90_000);

  it("GET read model exposes every stage + review status without fake progress percentages", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "EV road trips", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;

    const d = await h.reconcileGet(ws, itemId);
    expect(Object.keys(d)).toEqual(
      expect.arrayContaining(["contentItem", "currentStage", "publishReady", "brief", "outline", "draft", "seo", "internalLinking", "qa", "scoring", "reviewGatesUnmet"]),
    );
    expect(d.currentStage).toBe("BRIEF");
    expect(d.publishReady).toBe(false);
    expect(JSON.stringify(d)).not.toContain("percent");
    await h.cleanup(ws);
  }, 30_000);

  it("rejects a missing topic (400) and an inactive Knowledge Pack (422)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "", knowledgePackVersionId: packId }).expect(400);

    await request(h.server()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}/archive`).set(h.auth(ws)).expect(200);
    const res = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "X", knowledgePackVersionId: packId }).expect(422);
    expect(res.body.code).toBe("BLOG_KNOWLEDGE_PACK_NOT_ACTIVE");
    await h.cleanup(ws);
  }, 30_000);

  it("enforces stage order: outline before brief approval → 422; draft before outline approval → 422; seo before draft → 422", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Charging etiquette", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;

    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/outline`).set(h.auth(ws)).expect(422)).body.code).toBe("BLOG_BRIEF_NOT_APPROVED");

    await h.completeStageJob(ws, h.briefJobId(create.body.data), BRIEF_OUTPUT);
    await h.reconcileGet(ws, itemId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/brief/approve`).set(h.auth(ws)).expect(200);

    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/draft`).set(h.auth(ws)).expect(422)).body.code).toBe("BLOG_OUTLINE_NOT_APPROVED");

    const outline = await request(h.server()).post(`${h.base(ws)}/${itemId}/outline`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(outline.body.data, "outline"), OUTLINE_OUTPUT);
    await h.reconcileGet(ws, itemId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/outline/approve`).set(h.auth(ws)).expect(200);

    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(422)).body.code).toBe("BLOG_DRAFT_NOT_READY");
    await h.cleanup(ws);
  }, 60_000);

  it("QA needs internal-linking first (422); submit needs QA then score (422s); approve cannot skip the REVIEW state", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await walkToDraftAndSeo(h, ws, packId, "Battery care");

    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/qa`).set(h.auth(ws)).expect(422)).body.code).toBe("BLOG_INTERNAL_LINKING_NOT_COMPLETE");
    await request(h.server()).post(`${h.base(ws)}/${itemId}/internal-linking`).set(h.auth(ws)).expect(200);
    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(422)).body.code).toBe("BLOG_QA_NOT_COMPLETE");
    await request(h.server()).post(`${h.base(ws)}/${itemId}/qa`).set(h.auth(ws)).expect(200);
    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(422)).body.code).toBe("SEO_SCORE_NOT_RUN");
    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/approve`).set(h.auth(ws)).send({}).expect(409)).body.code).toBe("CONTENT_ITEM_INVALID_TRANSITION");
    await h.cleanup(ws);
  }, 90_000);

  it("internal-linking is a real seam that legitimately returns zero suggestions with a typed reason", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await walkToDraftAndSeo(h, ws, packId, "Public charging");
    const linked = await request(h.server()).post(`${h.base(ws)}/${itemId}/internal-linking`).set(h.auth(ws)).expect(200);
    expect(linked.body.data.internalLinking).toMatchObject({ status: "COMPLETED", suggestions: [], reason: "engine_not_available" });
    await h.cleanup(ws);
  }, 90_000);

  it("AI failure preserves the previous checkpoint; approving a FAILED stage is refused", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Charging myths", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;

    const status = await h.waitTerminal(ws, h.briefJobId(create.body.data));
    expect(["FAILED", "TIMED_OUT"]).toContain(status);

    const read = await h.reconcileGet(ws, itemId);
    expect((read.brief as { status: string }).status).toBe("FAILED");
    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/brief/approve`).set(h.auth(ws)).expect(422)).body.code).toBe("BLOG_BRIEF_NOT_READY");

    const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, include: { versions: true } });
    expect(item.versions.length).toBe(1);
    await h.cleanup(ws);
  }, 40_000);

  it("malformed AI output fails the stage — never silently repaired", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Charging safety", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;
    await h.completeStageJob(ws, h.briefJobId(create.body.data), { nonsense: true });
    const read = await h.reconcileGet(ws, itemId);
    expect((read.brief as { status: string; failureReason: string }).status).toBe("FAILED");
    expect((read.brief as { failureReason: string }).failureReason).toMatch(/schema validation/);
    await h.cleanup(ws);
  }, 30_000);

  it("regeneration preserves history: a new brief creates a new ai_job, keeps the old one, and resets downstream", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Charging networks", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;
    const firstBriefJob = h.briefJobId(create.body.data);
    await h.completeStageJob(ws, firstBriefJob, BRIEF_OUTPUT);
    await h.reconcileGet(ws, itemId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/brief/approve`).set(h.auth(ws)).expect(200);
    const outline = await request(h.server()).post(`${h.base(ws)}/${itemId}/outline`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(outline.body.data, "outline"), OUTLINE_OUTPUT);
    await h.reconcileGet(ws, itemId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/outline/approve`).set(h.auth(ws)).expect(200);

    const regen = await request(h.server()).post(`${h.base(ws)}/${itemId}/brief`).set(h.auth(ws)).expect(202);
    const secondBriefJob = h.briefJobId(regen.body.data);
    expect(secondBriefJob).not.toBe(firstBriefJob);
    // The regenerated stage is re-submitted (GENERATING), or already
    // reconciled to FAILED by the provider-less Worker — either way it is
    // no longer APPROVED, and downstream was reset.
    expect(["GENERATING", "FAILED"]).toContain((regen.body.data.brief as { status: string }).status);
    expect((regen.body.data.outline as { status: string }).status).toBe("PENDING");

    const jobs = await ctx.prisma.aiJob.findMany({ where: { workspaceId: ws.id, agentName: "blog-brief-agent" } });
    expect(jobs.map((j) => j.publicId).sort()).toEqual([firstBriefJob, secondBriefJob].sort());
    await h.cleanup(ws);
  }, 60_000);

  it("a repeated generate request for an already-running stage is rejected (409), not a corrupting double-run", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Charging costs", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;
    // Force the brief stage to a stable GENERATING with an ai_job id that
    // resolves to nothing (reconcile leaves such a stage untouched) —
    // isolates the concurrency guard from the provider-less Worker's
    // near-instant failure of the real job.
    const row = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, select: { id: true, metadata: true } });
    const md = row.metadata as { blogPipeline: { brief: Record<string, unknown> } };
    md.blogPipeline.brief = { ...md.blogPipeline.brief, status: "GENERATING", aiJobPublicId: "00000000-0000-0000-0000-0000000000aa", failureReason: null };
    await ctx.prisma.contentItem.update({ where: { id: row.id }, data: { metadata: md as object } });

    const read = await h.reconcileGet(ws, itemId);
    expect((read.brief as { status: string }).status).toBe("GENERATING");
    const dup = await request(h.server()).post(`${h.base(ws)}/${itemId}/brief`).set(h.auth(ws)).expect(409);
    expect(dup.body.code).toBe("BLOG_STAGE_ALREADY_RUNNING");
    await h.cleanup(ws);
  }, 30_000);

  it("workspace isolation: an article in workspace A is a 404 through workspace B; unauthorized roles are refused (403)", async () => {
    const wsA = await h.createWorkspace();
    const wsB = await h.createWorkspace();
    const packId = await h.createActivePack(wsA);
    const create = await request(h.server()).post(h.base(wsA)).set(h.auth(wsA)).send({ topic: "Cross tenant", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;

    await request(h.server()).get(`${h.base(wsB)}/${itemId}`).set(h.auth(wsB)).expect(404);

    const analyst = await createActiveUserAndLogin(ctx, "blog-analyst");
    await addActiveMemberWithRole(ctx, wsA.id, analyst.userId, "Analyst");
    const analystAuth = { Authorization: `Bearer ${analyst.accessToken}`, "X-Workspace-Id": wsA.publicId };
    await request(h.server()).post(h.base(wsA)).set(analystAuth).send({ topic: "Nope", knowledgePackVersionId: packId }).expect(403);
    await request(h.server()).post(`${h.base(wsA)}/${itemId}/brief`).set(analystAuth).expect(403);
    await h.cleanup(wsA);
  }, 40_000);

  it("regression: Phase 6.2 blog agents remain submittable through the generic AI Job API", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const res = await request(h.server())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set(h.auth(ws))
      .send({ agentIdentifier: "blog-brief-agent", knowledgePackVersionId: packId, input: { topic: "Home EV charging" } })
      .expect(202);
    expect(res.body.data.status).toBe("QUEUED");
    await h.cleanup(ws);
  }, 30_000);

  it("regression: Phase 6.1 generic content-item scoring endpoint still works", async () => {
    const ws = await h.createWorkspace();
    const item = await request(h.server())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(h.auth(ws))
      .send({ contentType: "BLOG", title: "Manual blog", body: { content: "A manually written blog about home EV charging with enough words to score reasonably here." } })
      .expect(201);
    const scored = await request(h.server()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.body.data.publicId}/score`).set(h.auth(ws)).expect(201);
    expect(scored.body.data.overallScore).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

// ===========================================================================
describe("Blog pipeline — score threshold gate (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;
  const originalThreshold = process.env.CONTENT_SCORING_PASS_THRESHOLD;
  const h = helpers(() => ctx, () => ownerToken);

  beforeAll(async () => {
    process.env.CONTENT_SCORING_PASS_THRESHOLD = "100";
    ctx = await bootstrapE2eApp();
    ownerToken = (await loginAsPlatformOwner(ctx)).accessToken;
  });
  afterAll(async () => {
    await teardownE2eApp(ctx);
    if (originalThreshold === undefined) delete process.env.CONTENT_SCORING_PASS_THRESHOLD;
    else process.env.CONTENT_SCORING_PASS_THRESHOLD = originalThreshold;
  });

  it("a below-threshold score blocks submit-for-review, leaves the item IN_PROGRESS, and exposes itemized feedback", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId, readModel } = await h.walkToReadyForReview(ws, packId);
    expect((readModel.scoring as { passed: boolean }).passed).toBe(false);

    const blocked = await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(422);
    expect(blocked.body.code).toBe("SEO_SCORE_BELOW_THRESHOLD");

    const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId } });
    expect(item.status).toBe("IN_PROGRESS");

    const feedback = await request(h.server()).get(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(200);
    expect(feedback.body.data.passed).toBe(false);
    expect(Array.isArray(feedback.body.data.recommendations)).toBe(true);

    const withVersions = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, include: { versions: true, contentScores: true } });
    expect(withVersions.versions.length).toBeGreaterThanOrEqual(2);
    expect(withVersions.contentScores.length).toBeGreaterThanOrEqual(1);
    await h.cleanup(ws);
  }, 90_000);
});

/** Shared: create → brief → approve → outline → approve → draft → SEO (stops before internal-linking). */
async function walkToDraftAndSeo(h: ReturnType<typeof helpers>, ws: Workspace, packId: string, topic: string): Promise<{ itemId: string }> {
  const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic, knowledgePackVersionId: packId }).expect(202);
  const itemId = create.body.data.contentItem.publicId;
  await h.completeStageJob(ws, h.briefJobId(create.body.data), BRIEF_OUTPUT);
  await h.reconcileGet(ws, itemId);
  await request(h.server()).post(`${h.base(ws)}/${itemId}/brief/approve`).set(h.auth(ws)).expect(200);
  const outline = await request(h.server()).post(`${h.base(ws)}/${itemId}/outline`).set(h.auth(ws)).expect(202);
  await h.completeStageJob(ws, h.stageJobId(outline.body.data, "outline"), OUTLINE_OUTPUT);
  await h.reconcileGet(ws, itemId);
  await request(h.server()).post(`${h.base(ws)}/${itemId}/outline/approve`).set(h.auth(ws)).expect(200);
  const draft = await request(h.server()).post(`${h.base(ws)}/${itemId}/draft`).set(h.auth(ws)).expect(202);
  await h.completeStageJob(ws, h.stageJobId(draft.body.data, "draft"), DRAFT_OUTPUT);
  await h.reconcileGet(ws, itemId);
  const seo = await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(202);
  await h.completeStageJob(ws, h.stageJobId(seo.body.data, "seo"), SEO_OUTPUT);
  await h.reconcileGet(ws, itemId);
  return { itemId };
}
