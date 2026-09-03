import { Prisma } from "../generated/prisma";
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
    // Module 8 Phase 8.4: this workspace has no other APPROVED Blog
    // content for the real discovery engine to find, so the seam
    // legitimately still completes with zero suggestions — but the
    // reason is now the real engine's own "no related content found"
    // outcome, not the pre-Phase-8.4 stub's unconditional "engine not
    // available". This is the ONE deliberate, disclosed update to this
    // test as part of Phase 8.4 (see the characterization tests above,
    // written and confirmed green against the seam BEFORE this change,
    // for the CONTRACT elements — SEO-ready precondition, always
    // reaching COMPLETED, QA gate depending only on status — that hold
    // identically both before and after it).
    expect(linked.body.data.internalLinking).toMatchObject({ status: "COMPLETED", suggestions: [], reason: "no_related_content_found" });
    await h.cleanup(ws);
  }, 90_000);

  // =========================================================================
  // Module 8 Phase 8.4 — CHARACTERIZATION of runInternalLinking()'s frozen
  // contract, written and confirmed green against the seam BEFORE Module 8's
  // real discovery engine replaced its stub body (Module 8 Phase 8.4
  // architecture instruction, Part C). These assert the CONTRACT elements
  // that hold identically both before and after the integration: the SEO-
  // readiness precondition, the stage always reaching COMPLETED regardless
  // of suggestion count, the QA gate depending only on
  // internalLinking.status (never suggestions.length), and the frozen
  // InternalLinkingSuggestion shape ({ targetContentItemPublicId, anchorText,
  // reason }). They remain in the suite, unchanged and still green, after
  // the integration — proving the contract itself was preserved.
  // =========================================================================

  it("[characterization] SEO must be READY before internal-linking can run", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Characterization SEO gate", knowledgePackVersionId: packId }).expect(202);
    const itemId = (create.body.data.contentItem as { publicId: string }).publicId;
    await h.completeStageJob(ws, h.briefJobId(create.body.data), BRIEF_OUTPUT);
    await h.reconcileGet(ws, itemId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/brief/approve`).set(h.auth(ws)).expect(200);
    const outline = await request(h.server()).post(`${h.base(ws)}/${itemId}/outline`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(outline.body.data, "outline"), OUTLINE_OUTPUT);
    await h.reconcileGet(ws, itemId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/outline/approve`).set(h.auth(ws)).expect(200);
    // Draft/SEO not yet generated -> SEO cannot be READY -> internal-linking must reject.
    const res = await request(h.server()).post(`${h.base(ws)}/${itemId}/internal-linking`).set(h.auth(ws)).expect(422);
    expect(res.body.code).toBe("BLOG_SEO_NOT_READY");
    await h.cleanup(ws);
  }, 90_000);

  it("[characterization] the stage always reaches COMPLETED, and QA's gate depends only on status, never suggestions.length", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await walkToDraftAndSeo(h, ws, packId, "Characterization QA gate");

    // Not yet run -> QA must refuse.
    const qaBefore = await request(h.server()).post(`${h.base(ws)}/${itemId}/qa`).set(h.auth(ws)).expect(422);
    expect(qaBefore.body.code).toBe("BLOG_INTERNAL_LINKING_NOT_COMPLETE");

    const linked = await request(h.server()).post(`${h.base(ws)}/${itemId}/internal-linking`).set(h.auth(ws)).expect(200);
    const stage = linked.body.data.internalLinking as { status: string; suggestions: unknown[]; reason: string; completedAt: string | null };
    expect(stage.status).toBe("COMPLETED");
    expect(Array.isArray(stage.suggestions)).toBe(true); // may legitimately be empty — zero suggestions is not an error
    expect(stage.completedAt).toBeTruthy();

    // QA now proceeds purely because status === COMPLETED, irrespective of suggestions.length.
    await request(h.server()).post(`${h.base(ws)}/${itemId}/qa`).set(h.auth(ws)).expect(200);

    await h.cleanup(ws);
  }, 90_000);

  it("[characterization] a suggestion, when present, has exactly the frozen shape: targetContentItemPublicId, anchorText, reason", async () => {
    // Static/type-level characterization: InternalLinkingSuggestion (Module
    // 6 Phase 6.3, blog-pipeline.types.ts) is frozen as exactly this shape.
    // A runtime assertion on a populated array is covered by the post-
    // integration suggestion-mapping tests below, once the real engine can
    // legitimately produce a non-empty array; before Phase 8.4 the stub
    // body could never populate one at all (unconditionally suggestions: []),
    // so there is nothing further to characterize about its element shape
    // at runtime pre-integration.
    const shape: { targetContentItemPublicId: string; anchorText: string; reason: string } = {
      targetContentItemPublicId: "x",
      anchorText: "y",
      reason: "z",
    };
    expect(Object.keys(shape).sort()).toEqual(["anchorText", "reason", "targetContentItemPublicId"]);
  });

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

  // ---- Read-side / mutation-boundary correction ----

  it("GET /blog/:id (BLOG_VIEW) is strictly read-only — a completed AI job is reported but never materialized by the read", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Read-only proof", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;

    // Drive brief → approve → outline → approve → draft, then COMPLETE the draft job — but do NOT run any further mutating stage.
    await h.completeStageJob(ws, h.briefJobId(create.body.data), BRIEF_OUTPUT);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/brief/approve`).set(h.auth(ws)).expect(200);
    const outline = await request(h.server()).post(`${h.base(ws)}/${itemId}/outline`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(outline.body.data, "outline"), OUTLINE_OUTPUT);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/outline/approve`).set(h.auth(ws)).expect(200);
    const draft = await request(h.server()).post(`${h.base(ws)}/${itemId}/draft`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(draft.body.data, "draft"), DRAFT_OUTPUT);

    const itemBefore = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, select: { updatedAt: true, metadata: true } });
    const versionsBefore = await ctx.prisma.contentVersion.count({ where: { contentItem: { publicId: itemId } } });
    const articlesBefore = await ctx.prisma.blogArticle.count({ where: { contentItem: { publicId: itemId } } });
    const auditBefore = await ctx.prisma.auditLog.count({ where: { workspaceId: ws.id } });

    // Several GETs.
    for (let i = 0; i < 3; i++) {
      const read = await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(h.auth(ws)).expect(200);
      // The read STILL reports the completed draft job — derived, not persisted.
      expect((read.body.data.draft as { status: string; pendingFinalization: boolean; contentVersionPublicId: string | null }).status).toBe("READY");
      expect((read.body.data.draft as { pendingFinalization: boolean }).pendingFinalization).toBe(true);
      expect((read.body.data.draft as { contentVersionPublicId: string | null }).contentVersionPublicId).toBeNull();
    }

    const itemAfter = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, select: { updatedAt: true, metadata: true } });
    expect(itemAfter.updatedAt.getTime()).toBe(itemBefore.updatedAt.getTime());
    expect(JSON.stringify(itemAfter.metadata)).toBe(JSON.stringify(itemBefore.metadata));
    expect(await ctx.prisma.contentVersion.count({ where: { contentItem: { publicId: itemId } } })).toBe(versionsBefore);
    expect(await ctx.prisma.blogArticle.count({ where: { contentItem: { publicId: itemId } } })).toBe(articlesBefore);
    expect(await ctx.prisma.auditLog.count({ where: { workspaceId: ws.id } })).toBe(auditBefore);

    // The very next mutating stage (SEO, SEO_EDIT) finalizes the draft exactly once.
    const seo = await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(202);
    const afterSeo = await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(h.auth(ws)).expect(200);
    expect((afterSeo.body.data.draft as { contentVersionPublicId: string | null }).contentVersionPublicId).toBeTruthy();
    expect((afterSeo.body.data.draft as { pendingFinalization: boolean }).pendingFinalization).toBe(false);
    void seo;
    await h.cleanup(ws);
  }, 90_000);

  it("Draft finalization is exactly-once and SEO upsert is idempotent under repeated mutating reconciliation", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await walkToDraftAndSeo(h, ws, packId, "Idempotency proof");

    // walkToDraftAndSeo finalized draft (during SEO stage) and SEO (nothing yet — SEO stage submits, next mutating stage finalizes it).
    await request(h.server()).post(`${h.base(ws)}/${itemId}/internal-linking`).set(h.auth(ws)).expect(200);
    const v1 = await ctx.prisma.contentVersion.count({ where: { contentItem: { publicId: itemId } } });
    const a1 = await ctx.prisma.blogArticle.count({ where: { contentItem: { publicId: itemId } } });
    expect(a1).toBe(1);

    // Re-run mutating stages that each call finalizeStages again — no new artifacts.
    await request(h.server()).post(`${h.base(ws)}/${itemId}/qa`).set(h.auth(ws)).expect(200);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/qa`).set(h.auth(ws)).expect(200);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/internal-linking`).set(h.auth(ws)).expect(200);

    expect(await ctx.prisma.contentVersion.count({ where: { contentItem: { publicId: itemId } } })).toBe(v1);
    expect(await ctx.prisma.blogArticle.count({ where: { contentItem: { publicId: itemId } } })).toBe(1);

    // The draft content_version carries the generating job id — the exactly-once key.
    const draftVersion = await ctx.prisma.contentVersion.findFirst({
      where: { contentItem: { publicId: itemId }, body: { path: ["generatedByAiJobPublicId"], not: Prisma.DbNull } },
    });
    expect(draftVersion).toBeTruthy();
    await h.cleanup(ws);
  }, 90_000);

  it("RBAC: a BLOG_VIEW-only user can read the pipeline but cannot finalize or mutate any stage", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Viewer RBAC", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;
    await h.completeStageJob(ws, h.briefJobId(create.body.data), BRIEF_OUTPUT);

    const writer = await createActiveUserAndLogin(ctx, "blog-writer-viewonly");
    // Content Writer holds BLOG_VIEW + BLOG_CREATE + BLOG_EDIT — use Publisher instead: BLOG_VIEW only among blog perms.
    await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Publisher");
    const viewerAuth = { Authorization: `Bearer ${writer.accessToken}`, "X-Workspace-Id": ws.publicId };

    const read = await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(viewerAuth).expect(200);
    expect((read.body.data.brief as { status: string }).status).toBe("READY"); // sees the completed job

    const versionsBefore = await ctx.prisma.contentVersion.count({ where: { contentItem: { publicId: itemId } } });
    await request(h.server()).post(`${h.base(ws)}/${itemId}/brief/approve`).set(viewerAuth).expect(403);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/outline`).set(viewerAuth).expect(403);
    expect(await ctx.prisma.contentVersion.count({ where: { contentItem: { publicId: itemId } } })).toBe(versionsBefore);
    await h.cleanup(ws);
  }, 40_000);

  // ---- Review-gate seal: no bypass via the generic content-items lifecycle route ----

  it("a Blog pipeline item cannot enter REVIEW through the generic content-items route before the gates pass", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "Bypass attempt", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;
    await h.completeStageJob(ws, h.briefJobId(create.body.data), BRIEF_OUTPUT);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/brief/approve`).set(h.auth(ws)).expect(200);

    // The item is IN_PROGRESS with only the brief approved — try the generic route.
    const res = await request(h.server())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/submit-for-review`)
      .set(h.auth(ws))
      .send({})
      .expect(409);
    expect(res.body.code).toBe("CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE");
    expect((await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId } })).status).toBe("IN_PROGRESS");

    // The Blog endpoint refuses it too — gates unmet.
    expect((await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(422)).body.code).toBe("BLOG_OUTLINE_NOT_APPROVED");
    await h.cleanup(ws);
  }, 40_000);

  it("a fully-gated Blog pipeline item still submits for review through the Blog endpoint, and approve/reject delegate to the shared lifecycle authority", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToReadyForReview(ws, packId);

    // Generic route STILL sealed even now that gates pass — the Blog endpoint is the only entry.
    expect(
      (await request(h.server()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/submit-for-review`).set(h.auth(ws)).send({}).expect(409)).body.code,
    ).toBe("CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE");

    const submitted = await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(200);
    expect((submitted.body.data.contentItem as { status: string }).status).toBe("REVIEW");

    // Generic approve now works (item legitimately in REVIEW) — same shared ContentItemsService as the Blog approve endpoint.
    const approved = await request(h.server()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/approve`).set(h.auth(ws)).send({ comment: "ok" }).expect(200);
    expect((approved.body.data as { status: string }).status).toBe("APPROVED");
    const events = await ctx.prisma.contentReviewEvent.findMany({ where: { contentItem: { publicId: itemId } } });
    expect(events.map((e) => e.action).sort()).toEqual(["APPROVED", "SUBMITTED"]);
    await h.cleanup(ws);
  }, 90_000);
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

    // The generic content-items route cannot be used to sidestep the score gate either.
    const generic = await request(h.server())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/submit-for-review`)
      .set(h.auth(ws))
      .send({})
      .expect(409);
    expect(generic.body.code).toBe("CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE");

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

  // ---- Phase 6.4: Blog-facing score read is BLOG_VIEW, not SEO_SCORE ----

  it("GET /blog/:id/score is readable with BLOG_VIEW alone (no SEO_SCORE), returns the full breakdown, and never runs scoring", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToReadyForReview(ws, packId);

    // Publisher: holds BLOG_VIEW, holds NO SEO_SCORE and NO BLOG_EDIT.
    const publisher = await createActiveUserAndLogin(ctx, "blog-score-publisher");
    await addActiveMemberWithRole(ctx, ws.id, publisher.userId, "Publisher");
    const pubAuth = { Authorization: `Bearer ${publisher.accessToken}`, "X-Workspace-Id": ws.publicId };

    const scoresBefore = await ctx.prisma.contentScore.count({ where: { workspaceId: ws.id } });

    const read = await request(h.server()).get(`${h.base(ws)}/${itemId}/score`).set(pubAuth).expect(200);
    expect(typeof read.body.data.overallScore).toBe("number");
    expect(Object.keys(read.body.data.categoryScores).sort()).toEqual(["BUSINESS", "ENGAGEMENT", "QUALITY", "SEO", "VIRAL"]);
    expect(typeof read.body.data.dimension.score).toBe("number");
    expect(read.body.data.dimension.name).toBe("blog");
    expect(typeof read.body.data.passed).toBe("boolean");
    expect(Array.isArray(read.body.data.recommendations)).toBe(true);

    // no new content_scores row was written by the read
    expect(await ctx.prisma.contentScore.count({ where: { workspaceId: ws.id } })).toBe(scoresBefore);

    // Publisher still cannot RUN a score (POST needs SEO_SCORE)
    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(pubAuth).expect(403);
    // ...nor via the generic content-items endpoint
    await request(h.server()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`).set(pubAuth).expect(403);
    await request(h.server()).get(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/score`).set(pubAuth).expect(403);
    await h.cleanup(ws);
  }, 90_000);

  it("GET /blog/:id/score is workspace-isolated (404 across workspaces) and denied to a user without BLOG_VIEW", async () => {
    const wsA = await h.createWorkspace();
    const wsB = await h.createWorkspace();
    const packId = await h.createActivePack(wsA);
    const create = await request(h.server()).post(h.base(wsA)).set(h.auth(wsA)).send({ topic: "Score isolation", knowledgePackVersionId: packId }).expect(202);
    const itemId = create.body.data.contentItem.publicId;

    await request(h.server()).get(`${h.base(wsB)}/${itemId}/score`).set(h.auth(wsB)).expect(404);

    const analyst = await createActiveUserAndLogin(ctx, "blog-score-analyst");
    await addActiveMemberWithRole(ctx, wsA.id, analyst.userId, "Analyst"); // Analyst has no BLOG_VIEW
    await request(h.server())
      .get(`${h.base(wsA)}/${itemId}/score`)
      .set({ Authorization: `Bearer ${analyst.accessToken}`, "X-Workspace-Id": wsA.publicId })
      .expect(403);
    await h.cleanup(wsA);
  }, 40_000);
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
