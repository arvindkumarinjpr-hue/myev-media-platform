import { addActiveMemberWithRole, bootstrapE2eApp, createActiveUserAndLogin, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 5 Phase 5.1 — Content Planner: Topic Cluster Planning
 * (FR-PLAN-002). Proves the user-facing
 * POST/GET /api/v1/workspaces/:workspaceId/topic-clusters surface:
 * promoting a completed Research run's own keywordClusters[] entry into
 * real, persisted keywords/keyword_clusters/keyword_cluster_members/
 * topic_clusters rows, idempotency, cross-workspace isolation, RBAC, and
 * that nothing here fabricates data beyond what Module 4's
 * RESEARCH_AGENT_V1 already computed. The completed Research run itself
 * is constructed directly via Prisma (not a real durable AI execution —
 * that pipeline is already proven end-to-end by apps/worker's own
 * research-agent.e2e-spec.ts); this suite only proves the Topic Cluster
 * boundary built on top of an already-completed job.
 */
describe("Topic Clusters API (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let ownerUserId: string;

  const ALL_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"];

  const SAMPLE_OUTPUT = {
    executiveSummary: "EV battery swap stations are gaining traction.",
    findings: [],
    trendSignals: [],
    keywordClusters: [
      {
        clusterTopic: "EV battery swap",
        primaryKeywords: [{ keyword: "ev battery swap station", intent: "informational", opportunityScore: 70, rationale: "High relevance." }],
        secondaryKeywords: [{ keyword: "battery swap cost", intent: "transactional", opportunityScore: 40, rationale: "Lower but real relevance." }],
      },
    ],
    contentAngles: [],
  };

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

  async function cleanup(ws: Workspace): Promise<void> {
    await ctx.prisma.topicCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.keywordClusterMember.deleteMany({ where: { keywordCluster: { workspaceId: ws.id } } });
    await ctx.prisma.keywordCluster.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.keyword.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentSeries.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.aiJobStep.deleteMany({ where: { aiJob: { workspaceId: ws.id } } });
    await ctx.prisma.aiJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.project.updateMany({ where: { workspaceId: ws.id }, data: { knowledgePackId: null } });
    const packs = await ctx.prisma.knowledgePack.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
    const packIds = packs.map((p) => p.id);
    if (packIds.length === 0) return;
    await ctx.prisma.knowledgeSource.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.promptTemplate.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.knowledgePackSeoRule.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.brandGuideline.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.keywordSet.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.competitor.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.knowledgePack.updateMany({ where: { id: { in: packIds } }, data: { currentVersionOfId: null } });
    await ctx.prisma.knowledgePack.deleteMany({ where: { id: { in: packIds } } });
  }

  async function createActivePack(ws: Workspace): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Topic Cluster Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://reachable.example/gov" }],
        promptTemplates: ALL_CONTENT_TYPES.map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    return packPublicId;
  }

  async function createResearchJob(ws: Workspace, knowledgePackPublicId: string, status: "COMPLETED" | "RUNNING", outputPayload: unknown = SAMPLE_OUTPUT): Promise<string> {
    const pack = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: knowledgePackPublicId, workspaceId: ws.id } });
    const job = await ctx.prisma.aiJob.create({
      data: {
        workspaceId: ws.id,
        agentName: "research-agent",
        agentVersion: 1,
        triggeringModule: "test-fixture",
        knowledgePackId: pack.id,
        inputPayload: { topic: "EV battery swap stations", verifiedSources: [] },
        outputPayload: status === "COMPLETED" ? (outputPayload as object) : undefined,
        status,
        correlationId: "test-correlation",
        createdById: ownerUserId,
        completedAt: status === "COMPLETED" ? new Date() : null,
      },
    });
    return job.publicId;
  }

  it("promotes a completed Research run's own keyword cluster into a real Topic Cluster — 201, materialized keywords/keyword_cluster rows", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const researchId = await createResearchJob(ws, packPublicId, "COMPLETED");

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap" })
      .expect(201);

    expect(res.body.data.name).toBe("EV battery swap");
    expect(res.body.data.clusterTopic).toBe("EV battery swap");
    expect(res.body.data.sourceResearchId).toBe(researchId);
    expect(res.body.data.primaryKeywords).toEqual([{ term: "ev battery swap station", searchIntent: "INFORMATIONAL", opportunityScore: 70, rationale: "High relevance." }]);
    expect(res.body.data.secondaryKeywords).toEqual([{ term: "battery swap cost", searchIntent: "TRANSACTIONAL", opportunityScore: 40, rationale: "Lower but real relevance." }]);
    expect(res.body.data.contentSeries).toBeNull();

    const keywordCount = await ctx.prisma.keyword.count({ where: { workspaceId: ws.id } });
    expect(keywordCount).toBe(2);

    await cleanup(ws);
  });

  it("rejects re-promoting the same keyword cluster — 409, never a silent duplicate", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const researchId = await createResearchJob(ws, packPublicId, "COMPLETED");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap" })
      .expect(201);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap" })
      .expect(409);

    const topicClusterCount = await ctx.prisma.topicCluster.count({ where: { workspaceId: ws.id } });
    expect(topicClusterCount).toBe(1);

    await cleanup(ws);
  });

  it("rejects a Research run that has not COMPLETED yet — 422, nothing materialized", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const researchId = await createResearchJob(ws, packPublicId, "RUNNING");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap" })
      .expect(422);

    const keywordClusterCount = await ctx.prisma.keywordCluster.count({ where: { workspaceId: ws.id } });
    expect(keywordClusterCount).toBe(0);

    await cleanup(ws);
  });

  it("rejects a keywordClusterTopic that does not exist in the Research run's own output — 404, never fabricated", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const researchId = await createResearchJob(ws, packPublicId, "COMPLETED");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "a topic the model never actually produced" })
      .expect(404);

    await cleanup(ws);
  });

  it("rejects a Research run belonging to a different workspace — 404, enumeration-safe", async () => {
    const ws = await createWorkspace();
    const otherWs = await createWorkspace();
    const otherPackPublicId = await createActivePack(otherWs);
    const foreignResearchId = await createResearchJob(otherWs, otherPackPublicId, "COMPLETED");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId: foreignResearchId, keywordClusterTopic: "EV battery swap" })
      .expect(404);

    await cleanup(ws);
    await cleanup(otherWs);
  });

  it("attaches to an existing Content Series when provided, and rejects one from a different workspace", async () => {
    const ws = await createWorkspace();
    const otherWs = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const researchId = await createResearchJob(ws, packPublicId, "COMPLETED");

    const seriesRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-series`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Battery Swap Series" })
      .expect(201);
    const seriesId = seriesRes.body.data.publicId as string;

    const foreignSeriesRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${otherWs.publicId}/content-series`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", otherWs.publicId)
      .send({ name: "Foreign Series" })
      .expect(201);
    const foreignSeriesId = foreignSeriesRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap", contentSeriesId: foreignSeriesId })
      .expect(404);

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap", contentSeriesId: seriesId })
      .expect(201);
    expect(created.body.data.contentSeries).toEqual({ publicId: seriesId, name: "Battery Swap Series" });

    await cleanup(ws);
    await cleanup(otherWs);
  });

  it("lists topic clusters workspace-scoped and retrieves one by id", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const researchId = await createResearchJob(ws, packPublicId, "COMPLETED");

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap" })
      .expect(201);
    const topicClusterId = created.body.data.publicId as string;

    const list = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].publicId).toBe(topicClusterId);

    const detail = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/topic-clusters/${topicClusterId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(detail.body.data.publicId).toBe(topicClusterId);

    await cleanup(ws);
  });

  it("RBAC — Analyst (no TOPIC_CLUSTER_MANAGE) is forbidden; SEO Specialist (has it) can create and list", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const researchId = await createResearchJob(ws, packPublicId, "COMPLETED");

    const analyst = await createActiveUserAndLogin(ctx, "topic-cluster-analyst");
    await addActiveMemberWithRole(ctx, ws.id, analyst.userId, "Analyst");
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${analyst.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap" })
      .expect(403);

    const seo = await createActiveUserAndLogin(ctx, "topic-cluster-seo");
    await addActiveMemberWithRole(ctx, ws.id, seo.userId, "SEO Specialist");
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${seo.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ researchId, keywordClusterTopic: "EV battery swap" })
      .expect(201);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/topic-clusters`)
      .set("Authorization", `Bearer ${seo.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    await cleanup(ws);
  });
});
