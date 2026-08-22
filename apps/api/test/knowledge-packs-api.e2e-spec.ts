import {
  addActiveMemberWithRole,
  bootstrapE2eApp,
  createActiveUserAndLogin,
  createProjectAsOwner,
  createWorkspaceAsOwner,
  loginAsPlatformOwner,
  request,
  teardownE2eApp,
  type E2eApp,
} from "./helpers/e2e-app";

/**
 * Module 2 Phase 2.2 — Knowledge Pack Engine Core CRUD (Draft only). No
 * validate/activate/archive/versioning here — Phase 2.3+, per
 * MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §17.
 */
describe("Knowledge Packs API (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  async function cleanupKnowledgePacks(workspaceId: string): Promise<void> {
    await ctx.prisma.project.updateMany({ where: { workspaceId }, data: { knowledgePackId: null } });
    const packs = await ctx.prisma.knowledgePack.findMany({ where: { workspaceId }, select: { id: true } });
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

  it("Owner can create, list, get, update, and delete a workspace-wide Draft Knowledge Pack", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);

    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "EV Content Pack", industryProfile: { industry: "Electric Vehicles" } })
      .expect(201);
    expect(createRes.body.data.status).toBe("DRAFT");
    expect(createRes.body.data.lockVersion).toBe(1);
    expect(createRes.body.data.name).toBe("EV Content Pack");
    const packPublicId = createRes.body.data.publicId as string;

    const listRes = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(listRes.body.data.some((p: { publicId: string }) => p.publicId === packPublicId)).toBe(true);

    const getRes = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(getRes.body.data.publicId).toBe(packPublicId);

    const updateRes = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        name: "EV Content Pack v2",
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: [{ contentType: "BLOG", promptBody: "Write about {{topic}}" }],
        keywordSets: [{ name: "core", keywords: ["ev", "electric vehicle"] }],
      })
      .expect(200);
    expect(updateRes.body.data.name).toBe("EV Content Pack v2");
    expect(updateRes.body.data.lockVersion).toBe(2);
    expect(updateRes.body.data.sources).toHaveLength(1);
    expect(updateRes.body.data.promptTemplates).toHaveLength(1);
    expect(updateRes.body.data.keywordSets).toHaveLength(1);

    await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(404);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("stale expectedLockVersion is rejected with a deterministic conflict, not silently applied", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Concurrency Test Pack" })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ expectedLockVersion: 1, name: "First edit" })
      .expect(200);

    // Same expectedLockVersion (1) used again — the row is now at 2.
    const conflict = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ expectedLockVersion: 1, name: "Stale edit — must be rejected" })
      .expect(409);
    expect(conflict.body.code).toBe("KNOWLEDGE_CONFLICT");

    const finalState = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(finalState.body.data.name).toBe("First edit");
    expect(finalState.body.data.lockVersion).toBe(2);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("a Knowledge Pack can be scoped to a Project, and rejects a cross-workspace projectId", async () => {
    const wsA = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const wsB = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const projectA = await createProjectAsOwner(ctx, ownerAccessToken, wsA.publicId);
    const projectB = await createProjectAsOwner(ctx, ownerAccessToken, wsB.publicId);

    const okRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsA.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsA.publicId)
      .send({ name: "Project-scoped pack", projectId: projectA.publicId })
      .expect(201);
    expect(okRes.body.data.publicId).toBeDefined();

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsA.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsA.publicId)
      .send({ name: "Cross-workspace attempt", projectId: projectB.publicId })
      .expect(422);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsA.publicId } })).id);
    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsB.publicId } })).id);
  });

  it("editing a non-Draft Knowledge Pack is rejected — Phase 2.2 never activates a pack, but the guard is proven directly against the database state", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com" } });
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Will be forced Active" })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;
    // No activation endpoint exists yet (Phase 2.3) — force the state
    // directly to prove the API-layer guard, not just the service's own
    // Draft-only check in isolation.
    await ctx.prisma.knowledgePack.updateMany({ where: { workspaceId: workspace.id, publicId: packPublicId }, data: { status: "ACTIVE" } });

    const updateAttempt = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ expectedLockVersion: 1, name: "Should be rejected" })
      .expect(409);
    expect(updateAttempt.body.code).toBe("KNOWLEDGE_CONFLICT");

    const deleteAttempt = await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(409);
    expect(deleteAttempt.body.code).toBe("KNOWLEDGE_CONFLICT");

    // Manually reset to DRAFT so cleanup's own delete path works normally.
    await ctx.prisma.knowledgePack.updateMany({ where: { id: (await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: packPublicId } })).id }, data: { status: "DRAFT" } });
    void user;
    await cleanupKnowledgePacks(workspace.id);
  });

  it("RBAC — exact KP_* permission mapping: Content Writer can view but not create, update, or delete", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const { userId, accessToken } = await createActiveUserAndLogin(ctx, "kp-content-writer");
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    await addActiveMemberWithRole(ctx, workspace.id, userId, "Content Writer");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Should be forbidden" })
      .expect(403);

    const ownerCreated = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Owner-created pack" })
      .expect(201);
    const packPublicId = ownerCreated.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ expectedLockVersion: 1, name: "Forbidden edit" })
      .expect(403);

    await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(403);

    await cleanupKnowledgePacks(workspace.id);
  });

  it("workspace isolation — a Knowledge Pack from one workspace is not reachable through another workspace's URL", async () => {
    const wsA = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const wsB = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsA.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsA.publicId)
      .send({ name: "Workspace A pack" })
      .expect(201);
    const packPublicId = created.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${wsB.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .expect(404);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsA.publicId } })).id);
    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsB.publicId } })).id);
  });
});
