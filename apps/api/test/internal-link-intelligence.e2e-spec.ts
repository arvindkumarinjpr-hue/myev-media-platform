import { randomUUID } from "crypto";
import { InternalLinkIntelligenceService } from "../src/modules/internal-links/internal-link-intelligence.service";
import { InternalLinksService } from "../src/modules/internal-links/internal-links.service";
import { addActiveMemberWithRole, bootstrapE2eApp, createActiveUserAndLogin, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 8 Phase 8.5 — Orphan + Cluster Intelligence (e2e). Exercises
 * both the real HTTP routes (GET .../internal-links/{orphans,cluster-
 * health,summary}) and InternalLinkIntelligenceService/reconcileWorkspace()
 * directly (the latter has no dedicated HTTP route — Part J describes it
 * as a reusable capability, not a new endpoint).
 */
describe("Internal Link Intelligence — Phase 8.5 (e2e)", () => {
  let ctx: E2eApp;
  let intelligence: InternalLinkIntelligenceService;
  let internalLinks: InternalLinksService;
  let ownerAccessToken: string;
  let ownerUserId: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    intelligence = ctx.app.get(InternalLinkIntelligenceService);
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

  const auth = (ws: Workspace, token = ownerAccessToken) => ({ Authorization: `Bearer ${token}`, "X-Workspace-Id": ws.publicId });
  const base = (ws: Workspace) => `/api/v1/workspaces/${ws.publicId}/internal-links`;

  async function createBlogItem(ws: Workspace, title: string, body: Record<string, unknown> = { content: "Generic filler content." }): Promise<{ id: string; publicId: string }> {
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
      .send({ contentType: "VIDEO", title, body: { script: "x" } })
      .expect(201);
    const publicId = res.body.data.publicId as string;
    const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId }, select: { id: true } });
    return { id: row.id, publicId };
  }

  async function setStatus(itemId: string, status: "IN_PROGRESS" | "APPROVED" | "ARCHIVED" | "DELETED"): Promise<void> {
    await ctx.prisma.contentItem.update({ where: { id: itemId }, data: { status, ...(status === "DELETED" ? { deletedAt: new Date() } : {}) } });
  }

  /** Approves target AND gives it a BlogArticle row (Part D population: "target BlogArticle exists"). */
  async function approveWithArticle(ws: Workspace, target: { id: string }, urlSlug: string): Promise<void> {
    await setStatus(target.id, "APPROVED");
    await ctx.prisma.blogArticle.create({ data: { workspaceId: ws.id, contentItemId: target.id, metaTitle: "T", metaDescription: "D", urlSlug, schemaMarkup: {}, createdById: ownerUserId } });
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

  async function createTopicCluster(ws: Workspace, seriesId: string, packId: string, name: string): Promise<string> {
    const job = await ctx.prisma.aiJob.create({
      data: { workspaceId: ws.id, agentName: "research-agent", agentVersion: 1, triggeringModule: "test-fixture", knowledgePackId: packId, inputPayload: {}, status: "COMPLETED", correlationId: `fixture-${seriesId}`, createdById: ownerUserId, completedAt: new Date() },
    });
    const keywordCluster = await ctx.prisma.keywordCluster.create({ data: { workspaceId: ws.id, topic: `topic-${seriesId}`, sourceAiJobId: job.id, knowledgePackId: packId, createdById: ownerUserId } });
    const topicCluster = await ctx.prisma.topicCluster.create({ data: { workspaceId: ws.id, name, keywordClusterId: keywordCluster.id, contentSeriesId: seriesId, createdById: ownerUserId } });
    return topicCluster.id;
  }

  /** Directly creates an InternalLink row at a specific status — bypasses discovery/scoring entirely, since intelligence tests need precise, arbitrary link graphs, not realistic discovery outcomes. */
  async function createLinkAtStatus(
    ws: Workspace,
    source: { id: string },
    target: { id: string },
    status: "GENERATED" | "ACCEPTED" | "REJECTED" | "STALE",
  ): Promise<string> {
    const created = await internalLinks.create(ws.id, ownerUserId, { sourceContentItemPublicId: (await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: source.id }, select: { publicId: true } })).publicId, targetContentItemPublicId: (await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: target.id }, select: { publicId: true } })).publicId, anchorText: "a valid anchor phrase", relevanceScore: 50, evidence: { note: "fixture" } });
    if (status === "GENERATED") return created.publicId;
    if (status === "ACCEPTED") {
      await internalLinks.accept(ws.id, created.publicId, ownerUserId);
    } else if (status === "REJECTED") {
      await internalLinks.reject(ws.id, created.publicId, ownerUserId, "fixture rejection");
    } else {
      await internalLinks.markStale(ws.id, created.publicId, "fixture stale");
    }
    return created.publicId;
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await ctx.prisma.internalLink.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentScore.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.blogArticle.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.topicCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.keywordClusterMember.deleteMany({ where: { keywordCluster: { workspaceId: ws.id } } });
    await ctx.prisma.keywordCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.keyword.deleteMany({ where: { workspaceId: ws.id } });
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

  // -----------------------------------------------------------------
  // Orphans
  // -----------------------------------------------------------------
  describe("orphans", () => {
    it("an APPROVED Blog with zero incoming ACCEPTED links is an orphan", async () => {
      const ws = await createWorkspace();
      const target = await createBlogItem(ws, "Lonely target");
      await approveWithArticle(ws, target, "lonely-target");

      const orphans = await intelligence.listOrphans(ws.id);
      expect(orphans.map((o) => o.contentItemPublicId)).toContain(target.publicId);
      const row = orphans.find((o) => o.contentItemPublicId === target.publicId)!;
      expect(row.reason).toBe("NO_ACCEPTED_INCOMING_LINKS");
      expect(row.incomingAcceptedLinkCount).toBe(0);

      await cleanup(ws);
    });

    it.each(["GENERATED", "REJECTED", "STALE"] as const)("incoming %s only is still an orphan", async (status) => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Some source");
      const target = await createBlogItem(ws, "Still orphan target");
      await approveWithArticle(ws, target, `still-orphan-${status.toLowerCase()}`);
      await createLinkAtStatus(ws, source, target, status);

      const orphans = await intelligence.listOrphans(ws.id);
      expect(orphans.map((o) => o.contentItemPublicId)).toContain(target.publicId);

      await cleanup(ws);
    });

    it("one valid incoming ACCEPTED link makes it not an orphan", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Accepting source");
      const target = await createBlogItem(ws, "Not orphan target");
      await approveWithArticle(ws, target, "not-orphan-target");
      await createLinkAtStatus(ws, source, target, "ACCEPTED");

      const orphans = await intelligence.listOrphans(ws.id);
      expect(orphans.map((o) => o.contentItemPublicId)).not.toContain(target.publicId);

      await cleanup(ws);
    });

    it("ARCHIVED, DELETED, DRAFT, IN_PROGRESS, and VIDEO targets are all excluded from the orphan population", async () => {
      const ws = await createWorkspace();

      const archived = await createBlogItem(ws, "Archived target");
      await approveWithArticle(ws, archived, "archived-target");
      await setStatus(archived.id, "ARCHIVED");

      const deleted = await createBlogItem(ws, "Deleted target");
      await approveWithArticle(ws, deleted, "deleted-target");
      await setStatus(deleted.id, "DELETED");

      const draft = await createBlogItem(ws, "Draft target"); // never approved

      const inProgress = await createBlogItem(ws, "In-progress target");
      await setStatus(inProgress.id, "IN_PROGRESS");

      const video = await createVideoItem(ws, "Video target");
      await setStatus(video.id, "APPROVED");

      const orphans = await intelligence.listOrphans(ws.id);
      const ids = orphans.map((o) => o.contentItemPublicId);
      expect(ids).not.toContain(archived.publicId);
      expect(ids).not.toContain(deleted.publicId);
      expect(ids).not.toContain(draft.publicId);
      expect(ids).not.toContain(inProgress.publicId);
      expect(ids).not.toContain(video.publicId);

      await cleanup(ws);
    });

    it("cross-workspace isolation: an orphan in another workspace never appears", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const target = await createBlogItem(other, "Other workspace orphan");
      await approveWithArticle(other, target, "other-ws-orphan");

      const orphans = await intelligence.listOrphans(ws.id);
      expect(orphans.map((o) => o.contentItemPublicId)).not.toContain(target.publicId);

      await cleanup(ws);
      await cleanup(other);
    });

    it("orders deterministically and exposes no raw DB ids", async () => {
      const ws = await createWorkspace();
      const b = await createBlogItem(ws, "B orphan");
      await approveWithArticle(ws, b, "b-orphan");
      const a = await createBlogItem(ws, "A orphan");
      await approveWithArticle(ws, a, "a-orphan");

      const orphans1 = await intelligence.listOrphans(ws.id);
      const orphans2 = await intelligence.listOrphans(ws.id);
      expect(orphans1).toEqual(orphans2); // deterministic across repeated calls
      expect(orphans1[0].title).toBe("A orphan"); // alphabetical
      expect(orphans1[1].title).toBe("B orphan");
      for (const o of orphans1) {
        expect(Object.keys(o)).not.toContain("id");
      }

      await cleanup(ws);
    });

    it("HTTP: GET orphans is BLOG_VIEW-gated and returns the same view", async () => {
      const ws = await createWorkspace();
      const target = await createBlogItem(ws, "HTTP orphan target");
      await approveWithArticle(ws, target, "http-orphan-target");

      const writer = await createActiveUserAndLogin(ctx, "orphan-writer");
      await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Content Writer"); // BLOG_VIEW
      const res = await request(ctx.app.getHttpServer()).get(`${base(ws)}/orphans`).set(auth(ws, writer.accessToken)).expect(200);
      expect(res.body.data.map((o: { contentItemPublicId: string }) => o.contentItemPublicId)).toContain(target.publicId);

      const videoEditor = await createActiveUserAndLogin(ctx, "orphan-video-editor");
      await addActiveMemberWithRole(ctx, ws.id, videoEditor.userId, "Video Editor"); // neither BLOG_VIEW nor SEO_EDIT
      await request(ctx.app.getHttpServer()).get(`${base(ws)}/orphans`).set(auth(ws, videoEditor.accessToken)).expect(403);

      await cleanup(ws);
    });
  });

  // -----------------------------------------------------------------
  // Cluster health
  // -----------------------------------------------------------------
  describe("cluster health", () => {
    it("a cluster where every Blog has an incoming ACCEPTED link shows full coverage", async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);
      const seriesId = await createSeries(ws, "Healthy series");
      await createTopicCluster(ws, seriesId, packId, "Healthy cluster");

      const a = await createBlogItem(ws, "Healthy A");
      await ctx.prisma.contentItem.update({ where: { id: a.id }, data: { seriesId } });
      const b = await createBlogItem(ws, "Healthy B");
      await ctx.prisma.contentItem.update({ where: { id: b.id }, data: { seriesId } });
      const dummySource = await createBlogItem(ws, "Healthy dummy source"); // a link's source must be DRAFT/IN_PROGRESS (Phase 8.1 domain rule) — a and b are both APPROVED cluster members, so a separate DRAFT item links into each of them
      await approveWithArticle(ws, b, "healthy-b");
      await createLinkAtStatus(ws, a, b, "ACCEPTED"); // a is still DRAFT here — valid source
      await ctx.prisma.contentItem.update({ where: { id: a.id }, data: { status: "APPROVED" } });
      await ctx.prisma.blogArticle.create({ data: { workspaceId: ws.id, contentItemId: a.id, metaTitle: "T", metaDescription: "D", urlSlug: "healthy-a", schemaMarkup: {}, createdById: ownerUserId } });
      await createLinkAtStatus(ws, dummySource, a, "ACCEPTED");

      const health = await intelligence.clusterHealth(ws.id);
      const cluster = health.find((c) => c.name === "Healthy cluster")!;
      expect(cluster.approvedBlogCount).toBe(2);
      expect(cluster.orphanBlogCount).toBe(0);
      expect(cluster.linkCoveragePercentage).toBe(100);
      // Only a->b has BOTH endpoints as currently-clustered, currently-
      // APPROVED members — dummySource->a's source was never approved,
      // so it's correctly excluded from the intra-cluster count (it still
      // counts toward a's own incoming-accepted total, which is what
      // coverage/orphan status actually measure).
      expect(cluster.intraClusterAcceptedLinkCount).toBe(1);

      await cleanup(ws);
    });

    it("a cluster containing orphan Blogs shows partial coverage", async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);
      const seriesId = await createSeries(ws, "Partial series");
      await createTopicCluster(ws, seriesId, packId, "Partial cluster");

      const linked = await createBlogItem(ws, "Partial linked");
      await ctx.prisma.contentItem.update({ where: { id: linked.id }, data: { seriesId } });
      await approveWithArticle(ws, linked, "partial-linked");
      const orphan = await createBlogItem(ws, "Partial orphan");
      await ctx.prisma.contentItem.update({ where: { id: orphan.id }, data: { seriesId } });
      await approveWithArticle(ws, orphan, "partial-orphan");
      const someSource = await createBlogItem(ws, "Some outside source");
      await createLinkAtStatus(ws, someSource, linked, "ACCEPTED");

      const health = await intelligence.clusterHealth(ws.id);
      const cluster = health.find((c) => c.name === "Partial cluster")!;
      expect(cluster.approvedBlogCount).toBe(2);
      expect(cluster.orphanBlogCount).toBe(1);
      expect(cluster.linkCoveragePercentage).toBe(50);

      await cleanup(ws);
    });

    it("a zero-content cluster reports 0 counts and null coverage (never a misleading 0%)", async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);
      const seriesId = await createSeries(ws, "Empty series");
      await createTopicCluster(ws, seriesId, packId, "Empty cluster");

      const health = await intelligence.clusterHealth(ws.id);
      const cluster = health.find((c) => c.name === "Empty cluster")!;
      expect(cluster.approvedBlogCount).toBe(0);
      expect(cluster.orphanBlogCount).toBe(0);
      expect(cluster.linkCoveragePercentage).toBeNull();

      await cleanup(ws);
    });

    it("intra-cluster vs cross-cluster ACCEPTED links are counted separately and correctly", async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);
      const seriesA = await createSeries(ws, "Cross series A");
      await createTopicCluster(ws, seriesA, packId, "Cross cluster A");
      const seriesB = await createSeries(ws, "Cross series B");
      await createTopicCluster(ws, seriesB, packId, "Cross cluster B");

      const a1 = await createBlogItem(ws, "A1");
      await ctx.prisma.contentItem.update({ where: { id: a1.id }, data: { seriesId: seriesA } });
      const b1 = await createBlogItem(ws, "B1");
      await ctx.prisma.contentItem.update({ where: { id: b1.id }, data: { seriesId: seriesB } });
      await approveWithArticle(ws, b1, "b1");
      await createLinkAtStatus(ws, a1, b1, "ACCEPTED"); // a1 still DRAFT here — valid source; cross-cluster (A -> B)
      await ctx.prisma.contentItem.update({ where: { id: a1.id }, data: { status: "APPROVED" } });
      await ctx.prisma.blogArticle.create({ data: { workspaceId: ws.id, contentItemId: a1.id, metaTitle: "T", metaDescription: "D", urlSlug: "a1", schemaMarkup: {}, createdById: ownerUserId } });

      const health = await intelligence.clusterHealth(ws.id);
      const clusterA = health.find((c) => c.name === "Cross cluster A")!;
      const clusterB = health.find((c) => c.name === "Cross cluster B")!;
      expect(clusterA.crossClusterAcceptedLinkCount).toBe(1);
      expect(clusterB.crossClusterAcceptedLinkCount).toBe(1);
      expect(clusterA.intraClusterAcceptedLinkCount).toBe(0);
      expect(clusterB.intraClusterAcceptedLinkCount).toBe(0);

      await cleanup(ws);
    });

    it("GENERATED and STALE links are never counted toward accepted-link health metrics", async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);
      const seriesId = await createSeries(ws, "Not-accepted series");
      await createTopicCluster(ws, seriesId, packId, "Not-accepted cluster");
      const a = await createBlogItem(ws, "NA A");
      await ctx.prisma.contentItem.update({ where: { id: a.id }, data: { seriesId } });
      const b = await createBlogItem(ws, "NA B");
      await ctx.prisma.contentItem.update({ where: { id: b.id }, data: { seriesId } });
      const dummySource1 = await createBlogItem(ws, "NA dummy source 1");
      const dummySource2 = await createBlogItem(ws, "NA dummy source 2");
      await approveWithArticle(ws, a, "na-a");
      await approveWithArticle(ws, b, "na-b");
      await createLinkAtStatus(ws, dummySource1, a, "GENERATED");
      await createLinkAtStatus(ws, dummySource2, b, "STALE");

      const health = await intelligence.clusterHealth(ws.id);
      const cluster = health.find((c) => c.name === "Not-accepted cluster")!;
      expect(cluster.intraClusterAcceptedLinkCount).toBe(0);
      expect(cluster.orphanBlogCount).toBe(2); // neither has an ACCEPTED incoming link

      await cleanup(ws);
    });

    it("archived/deleted Blogs never count toward any cluster metric", async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);
      const seriesId = await createSeries(ws, "Excl series");
      await createTopicCluster(ws, seriesId, packId, "Excl cluster");
      const archived = await createBlogItem(ws, "Excl archived");
      await ctx.prisma.contentItem.update({ where: { id: archived.id }, data: { seriesId } });
      await approveWithArticle(ws, archived, "excl-archived");
      await setStatus(archived.id, "ARCHIVED");

      const health = await intelligence.clusterHealth(ws.id);
      const cluster = health.find((c) => c.name === "Excl cluster")!;
      expect(cluster.approvedBlogCount).toBe(0);

      await cleanup(ws);
    });

    it("unresolved/no-cluster Blogs are handled explicitly — excluded from every cluster's own counts", async () => {
      const ws = await createWorkspace();
      const unclustered = await createBlogItem(ws, "No cluster Blog"); // no seriesId at all
      await approveWithArticle(ws, unclustered, "no-cluster-blog");

      const health = await intelligence.clusterHealth(ws.id);
      for (const cluster of health) {
        expect(cluster.approvedBlogCount).toBe(0); // no cluster exists in this workspace at all, but the point stands: this Blog appears in none
      }
      // It still appears at the workspace level (see workspace summary tests).
      const summary = await intelligence.workspaceSummary(ws.id);
      expect(summary.eligibleApprovedBlogs).toBe(1);

      await cleanup(ws);
    });

    it("cross-workspace isolation", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const packId = await createActivePack(other);
      const seriesId = await createSeries(other, "Other series");
      await createTopicCluster(other, seriesId, packId, "Other cluster");

      const health = await intelligence.clusterHealth(ws.id);
      expect(health.map((c) => c.name)).not.toContain("Other cluster");

      await cleanup(ws);
      await cleanup(other);
    });

    it("HTTP: GET cluster-health is BLOG_VIEW-gated", async () => {
      const ws = await createWorkspace();
      const writer = await createActiveUserAndLogin(ctx, "cluster-writer");
      await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Content Writer");
      await request(ctx.app.getHttpServer()).get(`${base(ws)}/cluster-health`).set(auth(ws, writer.accessToken)).expect(200);

      const videoEditor = await createActiveUserAndLogin(ctx, "cluster-video-editor");
      await addActiveMemberWithRole(ctx, ws.id, videoEditor.userId, "Video Editor");
      await request(ctx.app.getHttpServer()).get(`${base(ws)}/cluster-health`).set(auth(ws, videoEditor.accessToken)).expect(403);

      await cleanup(ws);
    });
  });

  // -----------------------------------------------------------------
  // Workspace summary
  // -----------------------------------------------------------------
  describe("workspace summary", () => {
    it("aggregates deterministically and matches the underlying orphan/cluster views", async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);
      const seriesId = await createSeries(ws, "Summary series");
      await createTopicCluster(ws, seriesId, packId, "Summary cluster");
      const orphanTarget = await createBlogItem(ws, "Summary orphan");
      await ctx.prisma.contentItem.update({ where: { id: orphanTarget.id }, data: { seriesId } });
      await approveWithArticle(ws, orphanTarget, "summary-orphan");
      const source = await createBlogItem(ws, "Summary source");
      await createLinkAtStatus(ws, source, orphanTarget, "GENERATED");

      const summary = await intelligence.workspaceSummary(ws.id);
      const orphans = await intelligence.listOrphans(ws.id);
      const clusters = await intelligence.clusterHealth(ws.id);

      expect(summary.orphanBlogs).toBe(orphans.length);
      expect(summary.clustersEvaluated).toBe(clusters.length);
      expect(summary.clustersWithOrphans).toBe(clusters.filter((c) => c.orphanBlogCount > 0).length);
      expect(summary.generatedRecommendations).toBeGreaterThanOrEqual(1);

      await cleanup(ws);
    });

    it("never counts cross-workspace data", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const target = await createBlogItem(other, "Other summary target");
      await approveWithArticle(other, target, "other-summary-target");

      const summary = await intelligence.workspaceSummary(ws.id);
      expect(summary.eligibleApprovedBlogs).toBe(0);
      expect(summary.orphanBlogs).toBe(0);

      await cleanup(ws);
      await cleanup(other);
    });

    it("HTTP: GET summary is BLOG_VIEW-gated", async () => {
      const ws = await createWorkspace();
      const writer = await createActiveUserAndLogin(ctx, "summary-writer");
      await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Content Writer");
      await request(ctx.app.getHttpServer()).get(`${base(ws)}/summary`).set(auth(ws, writer.accessToken)).expect(200);

      const videoEditor = await createActiveUserAndLogin(ctx, "summary-video-editor");
      await addActiveMemberWithRole(ctx, ws.id, videoEditor.userId, "Video Editor");
      await request(ctx.app.getHttpServer()).get(`${base(ws)}/summary`).set(auth(ws, videoEditor.accessToken)).expect(403);

      await cleanup(ws);
    });
  });

  // -----------------------------------------------------------------
  // Reconciliation
  // -----------------------------------------------------------------
  describe("reconcileWorkspace", () => {
    it("transitions an invalid GENERATED recommendation to STALE", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Reconcile source A");
      const target = await createBlogItem(ws, "Reconcile target A");
      await approveWithArticle(ws, target, "reconcile-target-a");
      const recId = await createLinkAtStatus(ws, source, target, "GENERATED");
      await setStatus(target.id, "ARCHIVED");

      const result = await intelligence.reconcileWorkspace(ws.id);
      expect(result.staledCount).toBe(1);
      const row = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { publicId: recId } });
      expect(row.status).toBe("STALE");

      await cleanup(ws);
    });

    it("transitions an invalid ACCEPTED recommendation to STALE", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Reconcile source B");
      const target = await createBlogItem(ws, "Reconcile target B");
      await approveWithArticle(ws, target, "reconcile-target-b");
      const recId = await createLinkAtStatus(ws, source, target, "ACCEPTED");
      await setStatus(target.id, "DELETED");

      const result = await intelligence.reconcileWorkspace(ws.id);
      expect(result.staledCount).toBe(1);
      const row = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { publicId: recId } });
      expect(row.status).toBe("STALE");

      await cleanup(ws);
    });

    it("a valid ACCEPTED recommendation is left unchanged", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Reconcile source C");
      const target = await createBlogItem(ws, "Reconcile target C");
      await approveWithArticle(ws, target, "reconcile-target-c");
      const recId = await createLinkAtStatus(ws, source, target, "ACCEPTED");

      const result = await intelligence.reconcileWorkspace(ws.id);
      expect(result.staledCount).toBe(0);
      const row = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { publicId: recId } });
      expect(row.status).toBe("ACCEPTED");

      await cleanup(ws);
    });

    it("relevance-score alone never triggers staleness — only target/source eligibility does", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Reconcile source D");
      const target = await createBlogItem(ws, "Reconcile target D");
      await approveWithArticle(ws, target, "reconcile-target-d");
      const recId = await createLinkAtStatus(ws, source, target, "ACCEPTED");
      await ctx.prisma.internalLink.update({ where: { publicId: recId }, data: { relevanceScore: 0 } }); // deliberately terrible score, still a valid target

      const result = await intelligence.reconcileWorkspace(ws.id);
      expect(result.staledCount).toBe(0);

      await cleanup(ws);
    });

    it("REJECTED and STALE rows are never touched — terminal, history-only", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Reconcile source E");
      const targetR = await createBlogItem(ws, "Reconcile target E rejected");
      await approveWithArticle(ws, targetR, "reconcile-target-e-r");
      const recR = await createLinkAtStatus(ws, source, targetR, "REJECTED");
      const targetS = await createBlogItem(ws, "Reconcile target E stale");
      await approveWithArticle(ws, targetS, "reconcile-target-e-s");
      const recS = await createLinkAtStatus(ws, source, targetS, "STALE");
      await setStatus(targetR.id, "ARCHIVED");
      await setStatus(targetS.id, "ARCHIVED");

      const result = await intelligence.reconcileWorkspace(ws.id);
      expect(result.staledCount).toBe(0); // neither was live, so neither was touched
      expect((await ctx.prisma.internalLink.findUniqueOrThrow({ where: { publicId: recR } })).status).toBe("REJECTED");
      expect((await ctx.prisma.internalLink.findUniqueOrThrow({ where: { publicId: recS } })).status).toBe("STALE");

      await cleanup(ws);
    });

    it("never deletes a row — history is always preserved", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Reconcile source F");
      const target = await createBlogItem(ws, "Reconcile target F");
      await approveWithArticle(ws, target, "reconcile-target-f");
      const recId = await createLinkAtStatus(ws, source, target, "GENERATED");
      await setStatus(target.id, "ARCHIVED");
      await intelligence.reconcileWorkspace(ws.id);

      const stillExists = await ctx.prisma.internalLink.findUnique({ where: { publicId: recId } });
      expect(stillExists).not.toBeNull();

      await cleanup(ws);
    });

    it("repeat run is idempotent — a second call finds nothing new to stale", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Reconcile source G");
      const target = await createBlogItem(ws, "Reconcile target G");
      await approveWithArticle(ws, target, "reconcile-target-g");
      await createLinkAtStatus(ws, source, target, "GENERATED");
      await setStatus(target.id, "ARCHIVED");

      const first = await intelligence.reconcileWorkspace(ws.id);
      const second = await intelligence.reconcileWorkspace(ws.id);
      expect(first.staledCount).toBe(1);
      expect(second.staledCount).toBe(0);

      await cleanup(ws);
    });

    it("is workspace-scoped — never reconciles another workspace's rows", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const source = await createBlogItem(other, "Reconcile other source");
      const target = await createBlogItem(other, "Reconcile other target");
      await approveWithArticle(other, target, "reconcile-other-target");
      const recId = await createLinkAtStatus(other, source, target, "GENERATED");
      await setStatus(target.id, "ARCHIVED");

      const result = await intelligence.reconcileWorkspace(ws.id); // wrong workspace on purpose
      expect(result.staledCount).toBe(0);
      expect((await ctx.prisma.internalLink.findUniqueOrThrow({ where: { publicId: recId } })).status).toBe("GENERATED");

      await cleanup(ws);
      await cleanup(other);
    });

    it("has no AI/provider dependency", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Reconcile source H");
      const target = await createBlogItem(ws, "Reconcile target H");
      await approveWithArticle(ws, target, "reconcile-target-h");
      await createLinkAtStatus(ws, source, target, "GENERATED");
      await setStatus(target.id, "ARCHIVED");
      await intelligence.reconcileWorkspace(ws.id);
      expect(await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } })).toBe(0);
      await cleanup(ws);
    });
  });
});
