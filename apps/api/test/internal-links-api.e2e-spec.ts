import { randomUUID } from "crypto";
import { addActiveMemberWithRole, bootstrapE2eApp, createActiveUserAndLogin, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 8 Phase 8.4 — Human Review API surface (e2e). The FIRST suite
 * in this Module 8 sub-project to exercise the real HTTP controllers
 * (BlogInternalLinksController / InternalLinksController) rather than
 * calling services directly — Phase 8.1-8.3 had no controller yet.
 */
describe("Internal Links — Human Review API (Phase 8.4, e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let ownerUserId: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
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
  const blogInternalLinksBase = (ws: Workspace, itemId: string) => `/api/v1/workspaces/${ws.publicId}/blog/${itemId}/internal-links`;
  const internalLinksBase = (ws: Workspace) => `/api/v1/workspaces/${ws.publicId}/internal-links`;

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

  async function setStatus(itemId: string, status: "APPROVED" | "ARCHIVED" | "DELETED"): Promise<void> {
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

  /** Promoted Topic Cluster -> cluster-proximity=100 (vs 70 for a plain series) — a reliable score floor so a token-overlap difference alone produces a clear, comfortably-above-threshold gap between two candidates. */
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

  /** A ready-to-score pair: source + APPROVED target sharing a series (cluster-proximity=70, comfortably clears the default threshold together with token overlap from shared wording). */
  async function createLinkablePair(ws: Workspace, label: string): Promise<{ sourcePublicId: string; targetPublicId: string; targetId: string }> {
    const seriesId = await createSeries(ws, `${label} series`);
    const source = await createBlogItem(ws, `${label} source about electric vehicle charging`, { content: `Read about electric vehicle charging basics and ${label} setup tips.` });
    await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
    const target = await createBlogItem(ws, `${label} target about electric vehicle charging`, { content: `More detail on electric vehicle charging for the ${label} scenario.` });
    await ctx.prisma.contentItem.update({ where: { id: target.id }, data: { seriesId } });
    await setStatus(target.id, "APPROVED");
    return { sourcePublicId: source.publicId, targetPublicId: target.publicId, targetId: target.id };
  }

  async function addMember(ws: Workspace, label: string, roleName: string) {
    const user = await createActiveUserAndLogin(ctx, label);
    await addActiveMemberWithRole(ctx, ws.id, user.userId, roleName);
    return user;
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await ctx.prisma.internalLink.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentScore.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentReviewEvent.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentItem.updateMany({ where: { workspaceId: ws.id }, data: { currentVersionId: null, featuredMediaAssetId: null, seriesId: null, deletedAt: new Date() } });
    await ctx.prisma.contentVersion.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentItem.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.topicCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.keywordClusterMember.deleteMany({ where: { keywordCluster: { workspaceId: ws.id } } });
    await ctx.prisma.keywordCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.keyword.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.aiJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentSeries.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.knowledgePack.updateMany({ where: { workspaceId: ws.id }, data: { currentVersionOfId: null } });
    await ctx.prisma.knowledgePackSeoRule.deleteMany({ where: { knowledgePack: { workspaceId: ws.id } } });
    await ctx.prisma.knowledgePack.deleteMany({ where: { workspaceId: ws.id } });
  }

  // -------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------
  describe("permissions", () => {
    it("BLOG_VIEW can list, but cannot generate/edit/accept/reject (403) — SEO_EDIT can do all four", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId, targetPublicId } = await createLinkablePair(ws, "perm");
      const writer = await addMember(ws, "perm-writer", "Content Writer"); // BLOG_VIEW, no SEO_EDIT
      const seo = await addMember(ws, "perm-seo", "SEO Specialist"); // both

      await request(ctx.app.getHttpServer()).get(blogInternalLinksBase(ws, sourcePublicId)).set(auth(ws, writer.accessToken)).expect(200);
      await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws, writer.accessToken)).expect(403);

      const generated = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws, seo.accessToken)).expect(200);
      const recId = generated.body.data[0].publicId as string;
      expect(generated.body.data[0].targetContentItemPublicId).toBe(targetPublicId);

      await request(ctx.app.getHttpServer()).patch(`${internalLinksBase(ws)}/${recId}`).set(auth(ws, writer.accessToken)).send({ anchorText: "should be forbidden" }).expect(403);
      await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/accept`).set(auth(ws, writer.accessToken)).expect(403);
      await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/reject`).set(auth(ws, writer.accessToken)).send({ rejectionReason: "no" }).expect(403);

      await request(ctx.app.getHttpServer()).patch(`${internalLinksBase(ws)}/${recId}`).set(auth(ws, seo.accessToken)).send({ anchorText: "a real anchor" }).expect(200);

      await cleanup(ws);
    });

    it("a role with neither BLOG_VIEW nor SEO_EDIT is refused everywhere", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "unauth");
      const videoEditor = await addMember(ws, "unauth-video", "Video Editor");

      await request(ctx.app.getHttpServer()).get(blogInternalLinksBase(ws, sourcePublicId)).set(auth(ws, videoEditor.accessToken)).expect(403);
      await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws, videoEditor.accessToken)).expect(403);

      await cleanup(ws);
    });

    it("cross-workspace access is enumeration-safe (404, not 403/leak)", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "isolation");

      await request(ctx.app.getHttpServer()).get(blogInternalLinksBase(other, sourcePublicId)).set(auth(other)).expect(404);
      await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(other, sourcePublicId)}/generate`).set(auth(other)).expect(404);

      await cleanup(ws);
      await cleanup(other);
    });
  });

  // -------------------------------------------------------------------
  // Generate
  // -------------------------------------------------------------------
  describe("generate", () => {
    it("creates deterministic recommendations and returns the full current list", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId, targetPublicId } = await createLinkablePair(ws, "gen");
      const res = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ targetContentItemPublicId: targetPublicId, status: "GENERATED" });
      expect(res.body.data[0].publicId).toBeTruthy();
      expect(res.body.data[0].id).toBeUndefined(); // never a raw internal id
      await cleanup(ws);
    });

    it("a repeat call is safe — no duplicate active recommendation", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "repeat");
      await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const second = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      expect(second.body.data).toHaveLength(1); // still exactly one live row, not two
      await cleanup(ws);
    });

    it("an accepted recommendation is preserved across a repeat generate call", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "acceptpreserve");
      const first = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recId = first.body.data[0].publicId as string;
      const accepted = await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/accept`).set(auth(ws)).expect(200);
      expect(accepted.body.data.status).toBe("ACCEPTED");

      const second = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.data[0].publicId).toBe(recId);
      expect(second.body.data[0].status).toBe("ACCEPTED"); // untouched

      await cleanup(ws);
    });

    it("no candidate returns a valid empty result, not an error", async () => {
      const ws = await createWorkspace();
      const source = await createBlogItem(ws, "Isolated generate source");
      const res = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, source.publicId)}/generate`).set(auth(ws)).expect(200);
      expect(res.body.data).toEqual([]);
      await cleanup(ws);
    });
  });

  // -------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------
  describe("list", () => {
    it("returns the expected human-review fields", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId, targetPublicId } = await createLinkablePair(ws, "listfields");
      await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const res = await request(ctx.app.getHttpServer()).get(blogInternalLinksBase(ws, sourcePublicId)).set(auth(ws)).expect(200);
      expect(res.body.data).toHaveLength(1);
      const rec = res.body.data[0];
      expect(rec).toMatchObject({ targetContentItemPublicId: targetPublicId, status: "GENERATED" });
      for (const key of ["publicId", "anchorText", "relevanceScore", "evidence", "generatedAt", "reviewedAt", "rejectionReason", "staleReason", "targetTitle"]) {
        expect(Object.prototype.hasOwnProperty.call(rec, key)).toBe(true);
      }
      expect(rec.id).toBeUndefined();
      await cleanup(ws);
    });

    it("orders recommendations by relevanceScore descending within a single generate call", async () => {
      const ws = await createWorkspace();
      const packId = await createActivePack(ws);
      const seriesId = await createSeries(ws, "score order series");
      await createTopicClusterWithTerms(ws, seriesId, packId, ["electric vehicle charging"]); // cluster-proximity=100 floor for every candidate in this series
      const source = await createBlogItem(ws, "score order source about electric vehicle charging", { content: "electric vehicle charging content for scoring." });
      await ctx.prisma.contentItem.update({ where: { id: source.id }, data: { seriesId } });
      // Two eligible series-mates with different body-text overlap against
      // the source, so they score differently — proves descending order
      // without depending on precisely tuned wording to guarantee a gap.
      for (const [label, body] of [
        ["high", "electric vehicle charging content for scoring, closely matching wording"],
        ["low", "a mostly unrelated topic with only faint overlap"],
      ] as const) {
        const t = await createBlogItem(ws, `score order ${label} target`, { content: body });
        await ctx.prisma.contentItem.update({ where: { id: t.id }, data: { seriesId, status: "APPROVED" } });
      }

      const gen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, source.publicId)}/generate`).set(auth(ws)).expect(200);
      const scores = (gen.body.data as Array<{ relevanceScore: number }>).map((r) => r.relevanceScore);
      expect(scores.length).toBeGreaterThanOrEqual(2);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));

      await cleanup(ws);
    });

    it("GENERATED ranks before REJECTED regardless of which was created more recently", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "rankorder");
      const first = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const firstRecId = first.body.data[0].publicId as string;
      await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${firstRecId}/reject`).set(auth(ws)).send({ rejectionReason: "not now" }).expect(200);
      // The same target is eligible again (its only recommendation is now
      // REJECTED, not live) — regenerating creates a fresh GENERATED row,
      // strictly newer than the REJECTED one.
      const regen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      expect(regen.body.data).toHaveLength(2);

      const list = (await request(ctx.app.getHttpServer()).get(blogInternalLinksBase(ws, sourcePublicId)).set(auth(ws)).expect(200)).body.data as Array<{ status: string }>;
      expect(list).toHaveLength(2);
      expect(list[0].status).toBe("GENERATED"); // GENERATED ranks before REJECTED despite being newer, not older
      expect(list[1].status).toBe("REJECTED");
      await cleanup(ws);
    });

    it("suppresses an unsafe target — read-time safety transitions it to STALE rather than surfacing it as usable", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId, targetId } = await createLinkablePair(ws, "stalecheck");
      await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);

      // Target becomes ineligible AFTER the recommendation was created (Phase 8.2's own deferred invalidation-on-edit debt).
      await setStatus(targetId, "ARCHIVED");

      const res = await request(ctx.app.getHttpServer()).get(blogInternalLinksBase(ws, sourcePublicId)).set(auth(ws)).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("STALE"); // never surfaced as GENERATED/usable
      expect(res.body.data[0].staleReason).toMatch(/no longer eligible/i);

      await cleanup(ws);
    });
  });

  // -------------------------------------------------------------------
  // Anchor edit
  // -------------------------------------------------------------------
  describe("anchor edit", () => {
    it("GENERATED is editable", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "editgen");
      const gen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recId = gen.body.data[0].publicId as string;
      const patched = await request(ctx.app.getHttpServer()).patch(`${internalLinksBase(ws)}/${recId}`).set(auth(ws)).send({ anchorText: "a human-chosen anchor" }).expect(200);
      expect(patched.body.data.anchorText).toBe("a human-chosen anchor");
      await cleanup(ws);
    });

    it("ACCEPTED, REJECTED, and STALE are all blocked (409)", async () => {
      const ws = await createWorkspace();

      const accepted = await createLinkablePair(ws, "editaccepted");
      const genA = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, accepted.sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recA = genA.body.data[0].publicId as string;
      await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recA}/accept`).set(auth(ws)).expect(200);
      await request(ctx.app.getHttpServer()).patch(`${internalLinksBase(ws)}/${recA}`).set(auth(ws)).send({ anchorText: "nope" }).expect(409);

      const rejected = await createLinkablePair(ws, "editrejected");
      const genR = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, rejected.sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recR = genR.body.data[0].publicId as string;
      await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recR}/reject`).set(auth(ws)).send({ rejectionReason: "no" }).expect(200);
      await request(ctx.app.getHttpServer()).patch(`${internalLinksBase(ws)}/${recR}`).set(auth(ws)).send({ anchorText: "nope" }).expect(409);

      const stale = await createLinkablePair(ws, "editstale");
      const genS = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, stale.sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recS = genS.body.data[0].publicId as string;
      await setStatus(stale.targetId, "ARCHIVED");
      await request(ctx.app.getHttpServer()).get(blogInternalLinksBase(ws, stale.sourcePublicId)).set(auth(ws)).expect(200); // triggers the read-time STALE transition
      await request(ctx.app.getHttpServer()).patch(`${internalLinksBase(ws)}/${recS}`).set(auth(ws)).send({ anchorText: "nope" }).expect(409);

      await cleanup(ws);
    });

    it("an invalid anchor (URL) is rejected — 422", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "editinvalid");
      const gen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recId = gen.body.data[0].publicId as string;
      const res = await request(ctx.app.getHttpServer()).patch(`${internalLinksBase(ws)}/${recId}`).set(auth(ws)).send({ anchorText: "https://example.com" }).expect(422);
      expect(res.body.code).toBe("INTERNAL_LINK_ANCHOR_VALIDATION_FAILED");
      await cleanup(ws);
    });
  });

  // -------------------------------------------------------------------
  // Accept
  // -------------------------------------------------------------------
  describe("accept", () => {
    it("GENERATED -> ACCEPTED, reviewer and timestamp set", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "acceptbasic");
      const gen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recId = gen.body.data[0].publicId as string;
      const res = await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/accept`).set(auth(ws)).expect(200);
      expect(res.body.data.status).toBe("ACCEPTED");
      expect(res.body.data.reviewedAt).toBeTruthy();
      await cleanup(ws);
    });

    it("repeated accept on an already-ACCEPTED row is a typed 409 — the existing Phase 8.1 lifecycle convention, not silently idempotent", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "acceptrepeat");
      const gen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recId = gen.body.data[0].publicId as string;
      await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/accept`).set(auth(ws)).expect(200);
      const second = await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/accept`).set(auth(ws)).expect(409);
      expect(second.body.code).toBe("INTERNAL_LINK_INVALID_TRANSITION");
      await cleanup(ws);
    });
  });

  // -------------------------------------------------------------------
  // Reject
  // -------------------------------------------------------------------
  describe("reject", () => {
    it("GENERATED -> REJECTED, rejection reason persisted", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "rejectbasic");
      const gen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recId = gen.body.data[0].publicId as string;
      const res = await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/reject`).set(auth(ws)).send({ rejectionReason: "Not topically relevant." }).expect(200);
      expect(res.body.data.status).toBe("REJECTED");
      expect(res.body.data.rejectionReason).toBe("Not topically relevant.");
      await cleanup(ws);
    });

    it("an empty rejectionReason is a validation error (400)", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "rejectempty");
      const gen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recId = gen.body.data[0].publicId as string;
      await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/reject`).set(auth(ws)).send({ rejectionReason: "" }).expect(400);
      await cleanup(ws);
    });

    it("an invalid lifecycle action (reject an already-REJECTED row) is a typed 409", async () => {
      const ws = await createWorkspace();
      const { sourcePublicId } = await createLinkablePair(ws, "rejecttwice");
      const gen = await request(ctx.app.getHttpServer()).post(`${blogInternalLinksBase(ws, sourcePublicId)}/generate`).set(auth(ws)).expect(200);
      const recId = gen.body.data[0].publicId as string;
      await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/reject`).set(auth(ws)).send({ rejectionReason: "first" }).expect(200);
      const second = await request(ctx.app.getHttpServer()).post(`${internalLinksBase(ws)}/${recId}/reject`).set(auth(ws)).send({ rejectionReason: "second" }).expect(409);
      expect(second.body.code).toBe("INTERNAL_LINK_INVALID_TRANSITION");
      await cleanup(ws);
    });
  });
});
