import { randomUUID } from "crypto";
import { BLOG_PIPELINE_METADATA_KEY } from "../src/modules/blog/blog-pipeline.types";
import { InternalLinkDiscoveryService } from "../src/modules/internal-links/internal-link-discovery.service";
import { InternalLinksService } from "../src/modules/internal-links/internal-links.service";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 8 Phase 8.3 — Anchor Recommendation Engine (e2e). No controller
 * exists yet — exercises InternalLinkDiscoveryService (its Phase 8.3
 * integration) and InternalLinksService.updateAnchor() directly, against
 * a real migrated Postgres database. Zero AI/provider dependency.
 */
describe("Internal Link Anchor Recommendation — Phase 8.3 (e2e)", () => {
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

  /** A promoted Topic Cluster gives cluster-proximity=100 (vs 70 for a plain, un-promoted series) — needed so relevance clears the default 40 threshold in fixtures whose source/target titles are deliberately dissimilar (to isolate anchor selection from relevance scoring). Same fixture pattern as Phase 8.2's own e2e suite. */
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

  async function setTargetPrimaryKeyword(targetId: string, primaryKeyword: string): Promise<void> {
    await ctx.prisma.contentItem.update({
      where: { id: targetId },
      data: { metadata: { [BLOG_PIPELINE_METADATA_KEY]: { knowledgePackVersionId: randomUUID(), brief: { status: "APPROVED", aiJobPublicId: null, artifact: { primaryKeyword }, approvedAt: null, approvedByUserPublicId: null, failureReason: null } } } },
    });
  }

  async function pairUp(source: { id: string }, target: { id: string }, seriesId: string): Promise<void> {
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId, status: "APPROVED" } });
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
    await ctx.prisma.brandGuideline.deleteMany({ where: { knowledgePack: { workspaceId: ws.id } } });
    await ctx.prisma.competitor.deleteMany({ where: { knowledgePack: { workspaceId: ws.id } } });
    await ctx.prisma.knowledgePackSeoRule.deleteMany({ where: { knowledgePack: { workspaceId: ws.id } } });
    await ctx.prisma.knowledgePack.deleteMany({ where: { workspaceId: ws.id } });
  }

  it("selects a natural anchor from the source body matching the target's primary keyword, replacing the Phase 8.2 title seed", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const seriesId = await createSeries(ws, "Anchor series");
    // A promoted Topic Cluster (cluster-proximity=100) keeps relevance
    // comfortably above the default threshold even though source/target
    // titles are deliberately dissimilar here — the point of this test
    // is that the anchor differs from the (unrelated) target title, not
    // relevance scoring, which Phase 8.2's own suite already covers.
    await createTopicClusterWithTerms(ws, seriesId, packId, ["home ev charging"]);
    const source = await createBlogItem(ws, "Anchor source", { content: "For background, see our guide to home ev charging setups." });
    const target = await createBlogItem(ws, "A Completely Different Title");
    await pairUp(source, target, seriesId);
    await setTargetPrimaryKeyword(target.id, "home ev charging");

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated).toHaveLength(1);
    expect(result.recommendationsCreated[0].anchorText.toLowerCase()).toBe("home ev charging");
    expect(result.recommendationsCreated[0].anchorText).not.toBe("A Completely Different Title"); // replaced the Phase 8.2 title seed

    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    expect(row.anchorText.toLowerCase()).toBe("home ev charging");
    const evidence = row.evidence as { factors: unknown[]; overallScore: number; discoveryMethod: string; anchor: { selectedAnchor: string; selectionSource: string; engineVersion: number } };
    expect(evidence.anchor.selectionSource).toBe("target-primary-keyword");
    expect(evidence.anchor.selectedAnchor.toLowerCase()).toBe("home ev charging");
    expect(evidence.anchor.engineVersion).toBe(1);
    // Phase 8.2 relevance evidence preserved, not destroyed.
    expect(Array.isArray(evidence.factors)).toBe(true);
    expect(typeof evidence.overallScore).toBe("number");
    expect(typeof evidence.discoveryMethod).toBe("string");

    await cleanup(ws);
  });

  it("falls back to a target-title subphrase when no primary keyword is available but a natural title phrase is present", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Subphrase series");
    const source = await createBlogItem(ws, "Subphrase source", { content: "Our fast charging networks guide covers everything you need." });
    const target = await createBlogItem(ws, "Fast Charging Networks Explained");
    await pairUp(source, target, seriesId); // no primary keyword set on target

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated).toHaveLength(1);
    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    const evidence = row.evidence as { anchor: { selectionSource: string } };
    expect(evidence.anchor.selectionSource).toBe("target-title-subphrase");
    expect(row.anchorText.toLowerCase()).toContain("fast charging networks");

    await cleanup(ws);
  });

  it("falls back deterministically to the target title when no natural phrase exists anywhere in the source", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const seriesId = await createSeries(ws, "Fallback series");
    // Promoted cluster keeps relevance above threshold despite the
    // deliberately unrelated source/target text (see comment on the
    // primary-keyword test above for why).
    await createTopicClusterWithTerms(ws, seriesId, packId, ["battery chemistry"]);
    const source = await createBlogItem(ws, "Fallback source", { content: "Bicycles are a great way to get around town for short trips." });
    const target = await createBlogItem(ws, "Electric Vehicle Battery Chemistry");
    await pairUp(source, target, seriesId);

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated).toHaveLength(1);
    expect(result.recommendationsCreated[0].anchorText).toBe("Electric Vehicle Battery Chemistry");
    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    const evidence = row.evidence as { anchor: { selectionSource: string; fallbackUsed: boolean } };
    expect(evidence.anchor.selectionSource).toBe("target-title-fallback");
    expect(evidence.anchor.fallbackUsed).toBe(true);

    await cleanup(ws);
  });

  it("excludes a blocked brand term as an anchor candidate, falling through to the next tier", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    await ctx.prisma.brandGuideline.create({ data: { knowledgePackId: packId, terminology: { Voltiq: "Voltiq" } } });
    const seriesId = await createSeries(ws, "Brand block series");
    const source = await createBlogItem(ws, "Brand block source", { content: "Check out the Voltiq Home Charger for your driveway setup." });
    const target = await createBlogItem(ws, "Voltiq Home Charger");
    await pairUp(source, target, seriesId);
    await setTargetPrimaryKeyword(target.id, "voltiq home charger"); // would otherwise match verbatim

    await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    const evidence = row.evidence as { anchor: { selectionSource: string; rejectedCandidates: Array<{ reason: string }> } };
    expect(evidence.anchor.selectionSource).not.toBe("target-primary-keyword"); // blocked
    expect(evidence.anchor.rejectedCandidates.some((r) => r.reason.startsWith("blocked-term"))).toBe(true);

    await cleanup(ws);
  });

  it("does not falsely block a generic word that merely shares letters with a competitor domain", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    await ctx.prisma.competitor.create({ data: { knowledgePackId: packId, domain: "voltnetwork.com" } });
    const seriesId = await createSeries(ws, "Generic word series");
    const source = await createBlogItem(ws, "Generic word source", { content: "Learn to read your volt meter accurately before installation." });
    const target = await createBlogItem(ws, "Volt Meter Guide");
    await pairUp(source, target, seriesId);
    await setTargetPrimaryKeyword(target.id, "volt meter");

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated).toHaveLength(1);
    expect(result.recommendationsCreated[0].anchorText.toLowerCase()).toBe("volt meter");

    await cleanup(ws);
  });

  it("exact-match-repeat protection: stops reusing the same anchor for the same target once the policy limit is reached", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    await ctx.prisma.knowledgePackSeoRule.create({ data: { knowledgePackId: packId, internalLinkingPolicy: { maxExactMatchAnchorRepeats: 1 } } });
    const seriesId = await createSeries(ws, "Repeat series");
    await createTopicClusterWithTerms(ws, seriesId, packId, ["repeat anchor phrase"]);
    const target = await createBlogItem(ws, "Repeat target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId, status: "APPROVED" } });
    await setTargetPrimaryKeyword(target.id, "repeat anchor phrase");

    const sourceA = await createBlogItem(ws, "Repeat source A", { content: "See our repeat anchor phrase guide for details." });
    await ctx.prisma.contentItem.update({ where: { id: sourceA.id }, data: { seriesId } });
    const runA = await discovery.generateForSource(ws.id, sourceA.publicId, ownerUserId);
    expect(runA.recommendationsCreated[0].anchorText.toLowerCase()).toBe("repeat anchor phrase");
    // Accept it so it counts as active history for the repeat guard.
    const rowA = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: sourceA.id, targetContentItemId: target.id } });
    await internalLinks.accept(ws.id, rowA.publicId, ownerUserId);

    const sourceB = await createBlogItem(ws, "Repeat source B", { content: "See our repeat anchor phrase guide for details, too." });
    await ctx.prisma.contentItem.update({ where: { id: sourceB.id }, data: { seriesId } });
    const runB = await discovery.generateForSource(ws.id, sourceB.publicId, ownerUserId);
    // maxExactMatchAnchorRepeats=1 already met by sourceA's ACCEPTED row -> the exact-match candidate is rejected for sourceB.
    expect(runB.recommendationsCreated[0].anchorText.toLowerCase()).not.toBe("repeat anchor phrase");

    await cleanup(ws);
  });

  it("lifecycle protection: updateAnchor only ever succeeds on a GENERATED row — ACCEPTED/REJECTED/STALE are refused with a typed conflict", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Lifecycle series");
    const source = await createBlogItem(ws, "Lifecycle source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Lifecycle target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId, status: "APPROVED" } });

    await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });

    const accepted = await internalLinks.accept(ws.id, row.publicId, ownerUserId);
    const beforeUpdatedAt = accepted.updatedAt.getTime();
    await expect(internalLinks.updateAnchor(ws.id, row.publicId, { anchorText: "should not apply", evidence: {} })).rejects.toMatchObject({ status: 409 });
    const stillAccepted = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { id: row.id } });
    expect(stillAccepted.status).toBe("ACCEPTED");
    expect(stillAccepted.anchorText).not.toBe("should not apply");
    expect(stillAccepted.updatedAt.getTime()).toBe(beforeUpdatedAt);

    await cleanup(ws);
  });

  it("a fresh GENERATED row's anchor may be updated directly", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "Direct update series");
    const source = await createBlogItem(ws, "Direct update source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Direct update target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId, status: "APPROVED" } });

    await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    const row = await ctx.prisma.internalLink.findFirstOrThrow({ where: { workspaceId: ws.id, sourceContentItemId: source.id, targetContentItemId: target.id } });
    const updated = await internalLinks.updateAnchor(ws.id, row.publicId, { anchorText: "a manually revised anchor", evidence: { ...(row.evidence as Record<string, unknown>), anchor: { note: "revised" } } });
    expect(updated.anchorText).toBe("a manually revised anchor");
    expect(updated.status).toBe("GENERATED");

    await cleanup(ws);
  });

  it("policy excludedContentItemIds removes a candidate before scoring", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const seriesId = await createSeries(ws, "Exclude series");
    const source = await createBlogItem(ws, "Exclude source");
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "Excluded target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId, status: "APPROVED" } });
    await ctx.prisma.knowledgePackSeoRule.create({ data: { knowledgePackId: packId, internalLinkingPolicy: { excludedContentItemIds: [target.publicId] } } });

    const result = await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    expect(result.recommendationsCreated.map((r) => r.targetContentItemPublicId)).not.toContain(target.publicId);

    await cleanup(ws);
  });

  it("no content body mutation: source content_versions.body is byte-identical before and after a discovery + anchor run", async () => {
    const ws = await createWorkspace();
    const seriesId = await createSeries(ws, "No mutation series");
    const body = { content: "Immutable body text about ev charging that should never change." };
    const source = await createBlogItem(ws, "No mutation source", body);
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, "No mutation target");
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId, status: "APPROVED" } });
    await setTargetPrimaryKeyword(target.id, "ev charging");

    const before = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: source.id }, include: { currentVersion: true } });
    await discovery.generateForSource(ws.id, source.publicId, ownerUserId);
    const after = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: source.id }, include: { currentVersion: true } });

    expect(after.currentVersion?.body).toEqual(before.currentVersion?.body);
    expect(after.currentVersionId).toBe(before.currentVersionId);

    await cleanup(ws);
  });
});
