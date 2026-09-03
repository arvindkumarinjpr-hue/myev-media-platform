import { randomUUID } from "crypto";
import { InternalLinkDiscoveryService } from "../src/modules/internal-links/internal-link-discovery.service";
import { InternalLinksService } from "../src/modules/internal-links/internal-links.service";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 8 Phase 8.2 — Candidate Discovery + Relevance Engine (e2e).
 * No controller exists yet — exercises InternalLinkDiscoveryService
 * directly via ctx.app.get(), same pattern Phase 8.1's own foundation
 * suite established. Blog -> Blog only; zero AI/provider dependency
 * (every fixture is created directly via Prisma or the generic
 * content-items HTTP surface, never a real or fixture AI job).
 */
describe("Internal Link Discovery — Phase 8.2 (e2e)", () => {
  let ctx: E2eApp;
  let discovery: InternalLinkDiscoveryService;
  let internalLinks: InternalLinksService;
  let ownerAccessToken: string;
  let ownerUserId: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    discovery = ctx.app.get(InternalLinkDiscoveryService);
    internalLinks = ctx.app.get(InternalLinksService);
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
    ownerUserId = (await ctx.prisma.user.findUniqueOrThrow({ where: { publicId: owner.publicId } })).id;
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

  async function createBlogItem(ws: Workspace, title: string, body: Record<string, unknown> = { content: "Generic filler content about electric vehicles." }): Promise<{ id: string; publicId: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(auth(ws))
      .send({ contentType: "BLOG", title, body })
      .expect(201);
    const publicId = res.body.data.publicId as string;
    const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId }, select: { id: true } });
    return { id: row.id, publicId };
  }

  async function createVideoItem(ws: Workspace, title: string): Promise<{ id: string; publicId: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(auth(ws))
      .send({ contentType: "VIDEO", title, body: { script: "A short script." } })
      .expect(201);
    const publicId = res.body.data.publicId as string;
    const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId }, select: { id: true } });
    return { id: row.id, publicId };
  }

  /** Direct-Prisma status transition — Phase 8.2 tests discovery/scoring logic, not the (already-covered) generic/Blog lifecycle machinery, and BLOG's own submit-for-review route is sealed against the generic flow (Module 6 Phase 6.3). */
  async function setStatus(itemId: string, status: "IN_PROGRESS" | "APPROVED" | "ARCHIVED" | "DELETED"): Promise<void> {
    await ctx.prisma.contentItem.update({ where: { id: itemId }, data: { status, ...(status === "DELETED" ? { deletedAt: new Date() } : {}) } });
  }

  async function createSeries(ws: Workspace, name: string): Promise<string> {
    const series = await ctx.prisma.contentSeries.create({ data: { workspaceId: ws.id, name, createdById: ownerUserId } });
    return series.id;
  }

  async function createActivePack(ws: Workspace): Promise<string> {
    const id = randomUUID();
    const pack = await ctx.prisma.knowledgePack.create({
      data: { id, lineageRootId: id, workspaceId: ws.id, name: "Pack", industryProfile: { industry: "EV" }, publishingStrategy: { cadence: "weekly" }, status: "ACTIVE", createdById: ownerUserId },
    });
    return pack.id;
  }

  /** Materializes a TopicCluster + KeywordCluster + Keyword/member rows directly via Prisma — bypasses TopicClustersService's real-Research-job requirement entirely, matching topic-clusters.e2e-spec.ts's own createResearchJob-fixture precedent. */
  async function createTopicClusterWithTerms(ws: Workspace, seriesId: string, packId: string, terms: string[]): Promise<void> {
    const job = await ctx.prisma.aiJob.create({
      data: { workspaceId: ws.id, agentName: "research-agent", agentVersion: 1, triggeringModule: "test-fixture", knowledgePackId: packId, inputPayload: {}, status: "COMPLETED", correlationId: `fixture-${seriesId}`, createdById: ownerUserId, completedAt: new Date() },
    });
    const keywordCluster = await ctx.prisma.keywordCluster.create({ data: { workspaceId: ws.id, topic: `topic-${seriesId}`, sourceAiJobId: job.id, knowledgePackId: packId, createdById: ownerUserId } });
    for (const term of terms) {
      const keyword = await ctx.prisma.keyword.upsert({
        where: { workspaceId_term: { workspaceId: ws.id, term } },
        create: { workspaceId: ws.id, term, searchIntent: "INFORMATIONAL", opportunityScore: 50, rationale: "fixture" },
        update: {},
      });
      await ctx.prisma.keywordClusterMember.create({ data: { keywordClusterId: keywordCluster.id, keywordId: keyword.id, membership: "PRIMARY" } });
    }
    await ctx.prisma.topicCluster.create({ data: { workspaceId: ws.id, name: `cluster-${seriesId}`, keywordClusterId: keywordCluster.id, contentSeriesId: seriesId, createdById: ownerUserId } });
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await ctx.prisma.internalLink.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentScore.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.blogArticle.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.topicCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.keywordClusterMember.deleteMany({ where: { keywordCluster: { workspaceId: ws.id } } });
    await ctx.prisma.keywordCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.keyword.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.aiJobStep.deleteMany({ where: { aiJob: { workspaceId: ws.id } } });
    await ctx.prisma.aiJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentReviewEvent.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentItem.updateMany({ where: { workspaceId: ws.id }, data: { currentVersionId: null, featuredMediaAssetId: null, seriesId: null, deletedAt: new Date() } });
    await ctx.prisma.contentVersion.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentItem.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentSeries.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.knowledgePack.updateMany({ where: { workspaceId: ws.id }, data: { currentVersionOfId: null } });
    await ctx.prisma.knowledgePackSeoRule.deleteMany({ where: { knowledgePack: { workspaceId: ws.id } } });
    await ctx.prisma.knowledgePack.deleteMany({ where: { workspaceId: ws.id } });
  }

  it("source eligibility: DRAFT and IN_PROGRESS accepted, APPROVED source rejected (422)", async () => {
    const ws = await createWorkspace();
    const draftSource = await createBlogItem(ws, "Draft source");
    const target = await createBlogItem(ws, "Approved target");
    await setStatus(target.id, "APPROVED");

    const draftRun = await discovery.generateForSource(ws.id, draftSource.publicId, ownerUserId);
    expect(draftRun.candidatesConsidered).toBeGreaterThanOrEqual(0); // no series relationship yet — token-fallback tier still runs

    const inProgressSource = await createBlogItem(ws, "In-progress source");
    await setStatus(inProgressSource.id, "IN_PROGRESS");
    await discovery.generateForSource(ws.id, inProgressSource.publicId, ownerUserId); // must not throw

    const approvedSource = await createBlogItem(ws, "Approved source");
    await setStatus(approvedSource.id, "APPROVED");
    await expect(discovery.generateForSource(ws.id, approvedSource.publicId, ownerUserId)).rejects.toMatchObject({ status: 422 });

    await cleanup(ws);
  });

  it("rejects a non-Blog source — 422", async () => {
    const ws = await createWorkspace();
    const video = await createVideoItem(ws, "A video source");
    await expect(discovery.generateForSource(ws.id, video.publicId, ownerUserId)).rejects.toMatchObject({ status: 422, response: { code: "INTERNAL_LINK_DISCOVERY_SOURCE_NOT_BLOG" } });
    await cleanup(ws);
  });

  it("cluster discovery: same series + promoted Topic Cluster finds the target, scores it, and persists a GENERATED row with full evidence", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const seriesId = await createSeries(ws, "EV Charging Series");
    await createTopicClusterWithTerms(ws, seriesId, packId, ["ev charging", "fast charging"]);

    const source = await createBlogItem(ws, "Source in the series");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Target in the same series");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
    await setStatus(target.id, "APPROVED");

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated).toHaveLength(1);
    expect(result.recommendationsCreated[0].targetContentItemPublicId).toBe(target.publicId);
    expect(result.recommendationsCreated[0].discoveryMethod).toBe("cluster");

    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    expect(row.status).toBe("GENERATED");
    expect(row.anchorText).toBe("Target in the same series"); // truthful placeholder = target title, not a fabricated anchor
    const evidence = row.evidence as { factors: Array<{ id: string }>; overallScore: number };
    expect(evidence.factors.map((f) => f.id)).toContain("cluster-proximity");
    expect(evidence.overallScore).toBe(row.relevanceScore);

    await cleanup(ws);
  });

  it("fallback discovery: plain series-mate WITHOUT a promoted Topic Cluster is still found (weaker cluster-proximity score)", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Un-promoted series");
    const source = await createBlogItem(ws, "Source, no cluster");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Series-mate, no cluster");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
    await setStatus(target.id, "APPROVED");

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated.map((r) => r.targetContentItemPublicId)).toContain(target.publicId);
    const created = result.recommendationsCreated.find((r) => r.targetContentItemPublicId === target.publicId)!;
    expect(created.discoveryMethod).toBe("cluster");

    await cleanup(ws);
  });

  it("keyword-cluster overlap: different series sharing a keyword term are discovered without being series-mates", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const seriesA = await createSeries(ws, "Series A");
    const seriesB = await createSeries(ws, "Series B");
    await createTopicClusterWithTerms(ws, seriesA, packId, ["battery swap"]);
    await createTopicClusterWithTerms(ws, seriesB, packId, ["battery swap", "charging cost"]);

    const source = await createBlogItem(ws, "Source in series A");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId: seriesA } });
    const target = await createBlogItem(ws, "Target in series B");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId: seriesB } });
    await setStatus(target.id, "APPROVED");

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    const created = result.recommendationsCreated.find((r) => r.targetContentItemPublicId === target.publicId);
    expect(created).toBeDefined();
    expect(created!.discoveryMethod).toBe("keyword-cluster");

    await cleanup(ws);
  });

  it("zero-candidate result: an isolated source in an otherwise-empty workspace produces no recommendations, no error", async () => {
    const ws = await createWorkspace();
    const source = await createBlogItem(ws, "Alone");
    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result).toEqual({ sourceContentItemPublicId: source.publicId, candidatesConsidered: 0, candidatesScored: 0, recommendationsCreated: [] });
    await cleanup(ws);
  });

  it("exclusions: self, non-Blog, non-APPROVED, archived, deleted, and cross-workspace content never appear as a candidate", async () => {
    const ws = await createWorkspace();
    const other = await createWorkspace();
    const seriesId = await createSeries(ws, "Exclusion series");

    const source = await createBlogItem(ws, "Source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });

    const video = await createVideoItem(ws, "Video sibling");
    await ctx.prisma.contentItem.update({ where: { id: video.id }, data: { seriesId, status: "APPROVED" } });

    const draftSibling = await createBlogItem(ws, "Draft sibling");
    await ctx.prisma.contentItem.update({ where: { id: draftSibling.id }, data: { seriesId } }); // stays DRAFT

    const archived = await createBlogItem(ws, "Archived sibling");
    await ctx.prisma.contentItem.update({ where: { id: archived.id }, data: { seriesId, status: "ARCHIVED" } });

    const deleted = await createBlogItem(ws, "Deleted sibling");
    await ctx.prisma.contentItem.update({ where: { id: deleted.id }, data: { seriesId, status: "DELETED", deletedAt: new Date() } });

    const foreignTarget = await createBlogItem(other, "Foreign approved");
    await setStatus(foreignTarget.id, "APPROVED"); // a different workspace's own series/seriesId is irrelevant — every discovery query is workspace-scoped by construction

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    const targetIds = result.recommendationsCreated.map((r) => r.targetContentItemPublicId);
    expect(targetIds).not.toContain(source.publicId);
    expect(targetIds).not.toContain(video.publicId);
    expect(targetIds).not.toContain(draftSibling.publicId);
    expect(targetIds).not.toContain(archived.publicId);
    expect(targetIds).not.toContain(deleted.publicId);
    expect(targetIds).not.toContain(foreignTarget.publicId);

    await cleanup(ws);
    await cleanup(other);
  });

  it("min relevance threshold: a low-overlap candidate is scored but not persisted", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Threshold series");
    const source = await createBlogItem(ws, "Zzz completely unrelated topic qqq");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    // A series-mate always scores >= 70 on cluster-proximity alone (weight 3
    // of 12 => contributes >=17.5 to the weighted mean even at zero on every
    // other factor) — to exercise the threshold path realistically we
    // instead use the token-fallback tier (no series) with deliberately
    // disjoint text, which can legitimately land below any positive
    // threshold.
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId: null } });
    const target = await createBlogItem(ws, "Completely different subject entirely", { content: "Nothing in common with the source at all." });
    await setStatus(target.id, "APPROVED");

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.candidatesScored).toBeGreaterThan(0);
    expect(result.recommendationsCreated.map((r) => r.targetContentItemPublicId)).not.toContain(target.publicId);

    await cleanup(ws);
  });

  it("duplicate active recommendation: a rerun does not create a second live row for the same pair", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Rerun series");
    const source = await createBlogItem(ws, "Rerun source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Rerun target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
    await setStatus(target.id, "APPROVED");

    const first = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(first.recommendationsCreated).toHaveLength(1);

    const second = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(second.recommendationsCreated).toHaveLength(0); // excluded pre-scoring — already has a live GENERATED row

    const count = await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    expect(count).toBe(1);

    await cleanup(ws);
  });

  it("regeneration history: after REJECTED, a rerun creates a new row and preserves the rejected one", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Regen series");
    const source = await createBlogItem(ws, "Regen source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Regen target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
    await setStatus(target.id, "APPROVED");

    await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    const firstRow = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    await internalLinks.reject(ws.id, firstRow.publicId, ownerUserId, "not relevant enough");

    const second = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(second.recommendationsCreated).toHaveLength(1);

    const all = await ctx.prisma.internalLink.findMany({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id }, orderBy: { createdAt: "asc" } });
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe("REJECTED");
    expect(all[1].status).toBe("GENERATED");

    await cleanup(ws);
  });

  it("ACCEPTED recommendations are preserved — a rerun never touches or duplicates them", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Accept series");
    const source = await createBlogItem(ws, "Accept source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Accept target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
    await setStatus(target.id, "APPROVED");

    await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    const accepted = await internalLinks.accept(ws.id, row.publicId, ownerUserId);

    const rerun = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(rerun.recommendationsCreated).toHaveLength(0);

    const stillAccepted = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { id: accepted.id } });
    expect(stillAccepted.status).toBe("ACCEPTED");
    expect(stillAccepted.updatedAt.getTime()).toBe(accepted.updatedAt.getTime());
    const count = await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    expect(count).toBe(1);

    await cleanup(ws);
  });

  it("existing-link suppression: a target already linked (via its BlogArticle.urlSlug) in the source body is excluded", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Existing link series");
    const target = await createBlogItem(ws, "Already linked target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId, status: "APPROVED" } });
    await ctx.prisma.blogArticle.create({ data: { workspaceId: ws.id, contentItemId: target.id, metaTitle: "T", metaDescription: "D", urlSlug: "already-linked-target-slug", schemaMarkup: {}, createdById: ownerUserId } });

    const source = await createBlogItem(ws, "Source with an existing link", { content: "See our [prior post](/blog/already-linked-target-slug) for background." });
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated.map((r) => r.targetContentItemPublicId)).not.toContain(target.publicId);

    await cleanup(ws);
  });

  it("missing ContentScore: target-authority factor uses the documented neutral default and still produces a recommendation", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "No score series");
    const source = await createBlogItem(ws, "No score source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Never scored target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
    await setStatus(target.id, "APPROVED");

    expect(await ctx.prisma.contentScore.count({ where: { workspaceId: ws.id } })).toBe(0);
    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated).toHaveLength(1);
    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    const evidence = row.evidence as { factors: Array<{ id: string; rawValue: { targetAuthorityScore: number | null } }> };
    const authorityFactor = evidence.factors.find((f) => f.id === "target-authority")!;
    expect(authorityFactor.rawValue.targetAuthorityScore).toBeNull();

    await cleanup(ws);
  });

  it("no AI/provider dependency: a full discovery run creates zero ai_jobs rows", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "No AI series");
    const source = await createBlogItem(ws, "No AI source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "No AI target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
    await setStatus(target.id, "APPROVED");

    await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } })).toBe(0);

    await cleanup(ws);
  });

  it("relevance score determinism: two structurally-identical workspaces produce the identical overall score", async () => {
    async function buildScenario(): Promise<{ ws: Workspace; source: { id: string; publicId: string }; target: { id: string; publicId: string } }> {
      const ws = await createWorkspace();
      const seriesId = await createSeries(ws, "Determinism series");
      const source = await createBlogItem(ws, "Determinism source", { content: "Electric vehicle charging network overview." });
      await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
      const target = await createBlogItem(ws, "Determinism target", { content: "Electric vehicle charging network details." });
      await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
      await setStatus(target.id, "APPROVED");
      return { ws, source, target };
    }
    const a = await buildScenario();
    const b = await buildScenario();
    const [resultA, resultB] = await Promise.all([discovery.generateForSource(a.ws.id, a.source.publicId, ownerUserId), discovery.generateForSource(b.ws.id, b.source.publicId, ownerUserId)]);
    expect(resultA.recommendationsCreated[0].relevanceScore).toBe(resultB.recommendationsCreated[0].relevanceScore);

    await cleanup(a.ws);
    await cleanup(b.ws);
  });
});

/**
 * Candidate-pool-bound and max-recommendations-per-run behave against
 * config values, which are read once at bootstrap — a separate app
 * instance with overridden env vars is required to exercise them without
 * needing dozens of fixture content items against the (much larger)
 * default limit.
 */
describe("Internal Link Discovery — bounded config behavior (e2e)", () => {
  let ctx: E2eApp;
  let discovery: InternalLinkDiscoveryService;
  let ownerAccessToken: string;
  let ownerUserId: string;
  const originalPoolLimit = process.env.INTERNAL_LINKING_CANDIDATE_POOL_LIMIT;
  const originalMaxPerRun = process.env.INTERNAL_LINKING_MAX_RECOMMENDATIONS_PER_RUN;
  const originalMinThreshold = process.env.INTERNAL_LINKING_MIN_RELEVANCE_THRESHOLD;

  beforeAll(async () => {
    process.env.INTERNAL_LINKING_CANDIDATE_POOL_LIMIT = "3";
    process.env.INTERNAL_LINKING_MAX_RECOMMENDATIONS_PER_RUN = "2";
    process.env.INTERNAL_LINKING_MIN_RELEVANCE_THRESHOLD = "0"; // isolate the pool/count bounds from threshold filtering
    ctx = await bootstrapE2eApp();
    discovery = ctx.app.get(InternalLinkDiscoveryService);
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
    ownerUserId = (await ctx.prisma.user.findUniqueOrThrow({ where: { publicId: owner.publicId } })).id;
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
    if (originalPoolLimit === undefined) delete process.env.INTERNAL_LINKING_CANDIDATE_POOL_LIMIT;
    else process.env.INTERNAL_LINKING_CANDIDATE_POOL_LIMIT = originalPoolLimit;
    if (originalMaxPerRun === undefined) delete process.env.INTERNAL_LINKING_MAX_RECOMMENDATIONS_PER_RUN;
    else process.env.INTERNAL_LINKING_MAX_RECOMMENDATIONS_PER_RUN = originalMaxPerRun;
    if (originalMinThreshold === undefined) delete process.env.INTERNAL_LINKING_MIN_RELEVANCE_THRESHOLD;
    else process.env.INTERNAL_LINKING_MIN_RELEVANCE_THRESHOLD = originalMinThreshold;
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

  async function createBlogItem(ws: Workspace, title: string): Promise<{ id: string; publicId: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(auth(ws))
      .send({ contentType: "BLOG", title, body: { content: "Shared filler content about electric vehicles." } })
      .expect(201);
    const publicId = res.body.data.publicId as string;
    const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId }, select: { id: true } });
    return { id: row.id, publicId };
  }

  it("candidate pool is bounded to the configured limit, and persisted recommendations are capped to the configured max per run", async () => {
    const ws = await createWorkspace();
    const seriesId = (await ctx.prisma.contentSeries.create({ data: { workspaceId: ws.id, name: "Bound series", createdById: ownerUserId } })).id;
    const source = await createBlogItem(ws, "Bound source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });

    // 5 eligible series-mates against a pool limit of 3 and a per-run cap of 2.
    for (let i = 0; i < 5; i++) {
      const mate = await createBlogItem(ws, `Bound series-mate ${i}`);
      await ctx.prisma.contentItem.update({ where: { id: mate.id }, data: { seriesId, status: "APPROVED" } });
    }

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.candidatesConsidered).toBeLessThanOrEqual(3);
    expect(result.recommendationsCreated.length).toBeLessThanOrEqual(2);
    expect(result.recommendationsCreated.length).toBeGreaterThan(0);

    const persistedCount = await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id, sourceContentItemId: source.id } });
    expect(persistedCount).toBe(result.recommendationsCreated.length);
    expect(persistedCount).toBeLessThanOrEqual(2);
  });
});
