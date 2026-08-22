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
 * Module 2 Phase 2.5 — explicit archive (§8/§12) and the Project ->
 * Knowledge Pack reassignment capability §8 named as a dependency and left
 * "NOT YET DESIGNED" until now. See
 * MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §7/§8/§12/§17.
 */
describe("Knowledge Pack Lifecycle — Archive + Project Reassignment (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;

  const ALL_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"];

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

  /** Creates a Draft with every FR-KP-005 gate satisfied, then validates it to ACTIVE. Returns its publicId. */
  async function createActivePack(ws: { publicId: string }): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "EV Content Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
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

  it("archive succeeds on an unreferenced Active version, remains queryable, and cannot be hard-deleted or re-deleted", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createActivePack(ws);

    const archiveRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/archive`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(archiveRes.body.data.status).toBe("ARCHIVED");

    // Remains queryable — GET still works, row is not gone.
    const getRes = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(getRes.body.data.status).toBe("ARCHIVED");

    const dbRow = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: packPublicId } });
    expect(dbRow.deletedAt).toBeNull();
    expect(dbRow.archivedAt).not.toBeNull();

    // KP_DELETE (soft delete) is still Draft-only — an Archived row cannot be deleted this way.
    const deleteAttempt = await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(409);
    expect(deleteAttempt.body.code).toBe("KNOWLEDGE_CONFLICT");

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("archive is blocked while a Project references the version — no automatic reassignment, nothing changes", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createActivePack(ws);
    const project = await createProjectAsOwner(ctx, ownerAccessToken, ws.publicId);
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/projects/${project.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ knowledgePackId: packPublicId })
      .expect(200);

    const archiveAttempt = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/archive`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(409);
    expect(archiveAttempt.body.code).toBe("KNOWLEDGE_CONFLICT");
    expect(archiveAttempt.body.message).toMatch(/RESTRICT|Project/i);

    const packAfter = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: packPublicId } });
    expect(packAfter.status).toBe("ACTIVE");
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const projectAfter = await ctx.prisma.project.findFirstOrThrow({ where: { publicId: project.publicId, workspaceId: workspace.id } });
    expect(projectAfter.knowledgePackId).toBe(packAfter.id);

    await ctx.prisma.project.updateMany({ where: { publicId: project.publicId, workspaceId: workspace.id }, data: { knowledgePackId: null } });
    await cleanupKnowledgePacks(workspace.id);
  });

  it("Project reassignment: succeeds to an Active pack, is reflected on read, rejects cross-workspace and non-Active targets, and is RBAC-gated", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const wsOther = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createActivePack(ws);
    const otherWorkspacePackPublicId = await createActivePack(wsOther);
    const project = await createProjectAsOwner(ctx, ownerAccessToken, ws.publicId);

    const assignRes = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/projects/${project.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ knowledgePackId: packPublicId })
      .expect(200);
    expect(assignRes.body.data.knowledgePackPublicId).toBe(packPublicId);

    const readRes = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/projects/${project.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(readRes.body.data.knowledgePackPublicId).toBe(packPublicId);

    // Cross-workspace target rejected.
    const crossWorkspaceAttempt = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/projects/${project.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ knowledgePackId: otherWorkspacePackPublicId })
      .expect(422);
    expect(crossWorkspaceAttempt.body.code).toBe("PROJECT_VALIDATION_FAILED");

    // Non-Active target (a fresh Draft) rejected.
    const draftRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Still a Draft" })
      .expect(201);
    const draftAttempt = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/projects/${project.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ knowledgePackId: draftRes.body.data.publicId })
      .expect(422);
    expect(draftAttempt.body.code).toBe("PROJECT_VALIDATION_FAILED");

    // Unaffected by the two rejected attempts.
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const projectAfter = await ctx.prisma.project.findFirstOrThrow({ where: { publicId: project.publicId, workspaceId: workspace.id } });
    const packRow = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: packPublicId, workspaceId: workspace.id } });
    expect(projectAfter.knowledgePackId).toBe(packRow.id);

    // RBAC — Content Writer (view-only on Projects, no PROJECT_UPDATE) is forbidden.
    const { userId, accessToken } = await createActiveUserAndLogin(ctx, "kp-lifecycle-writer");
    await addActiveMemberWithRole(ctx, workspace.id, userId, "Content Writer");
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/projects/${project.publicId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ knowledgePackId: null })
      .expect(403);

    await ctx.prisma.project.updateMany({ where: { publicId: project.publicId, workspaceId: workspace.id }, data: { knowledgePackId: null } });
    await cleanupKnowledgePacks(workspace.id);
    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsOther.publicId } })).id);
  });

  it("RESTRICT end-to-end: blocked supersession stays blocked, reassignment never happens automatically, and the same supersession succeeds once reassigned", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const v1PublicId = await createActivePack(ws);
    const project = await createProjectAsOwner(ctx, ownerAccessToken, ws.publicId);
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/projects/${project.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ knowledgePackId: v1PublicId })
      .expect(200);

    const versionRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(201);
    const v2PublicId = versionRes.body.data.publicId as string;

    // First attempt: blocked. V1 stays Active, V2 returns to Draft, P1 stays on V1.
    const blockedRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);
    expect(blockedRes.body.details.some((d: string) => /RESTRICT/.test(d))).toBe(true);

    let v1Row = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: v1PublicId, workspaceId: workspace.id } });
    let v2Row = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: v2PublicId, workspaceId: workspace.id } });
    let projectRow = await ctx.prisma.project.findFirstOrThrow({ where: { publicId: project.publicId, workspaceId: workspace.id } });
    expect(v1Row.status).toBe("ACTIVE");
    expect(v2Row.status).toBe("DRAFT");
    // No automatic FK mutation — Knowledge Pack validation never touches Projects.
    expect(projectRow.knowledgePackId).toBe(v1Row.id);

    // Explicit reassignment — the only place the FK is allowed to move.
    const reassignRes = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/projects/${project.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ knowledgePackId: null })
      .expect(200);
    expect(reassignRes.body.data.knowledgePackPublicId).toBeNull();

    // Retry: succeeds. V1 archived, V2 active.
    const retryRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(retryRes.body.data.status).toBe("ACTIVE");

    v1Row = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: v1PublicId, workspaceId: workspace.id } });
    v2Row = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: v2PublicId, workspaceId: workspace.id } });
    projectRow = await ctx.prisma.project.findFirstOrThrow({ where: { publicId: project.publicId, workspaceId: workspace.id } });
    expect(v1Row.status).toBe("ARCHIVED");
    expect(v2Row.status).toBe("ACTIVE");
    // Retrying validation doesn't itself reassign the Project either.
    expect(projectRow.knowledgePackId).toBeNull();

    // Audit trail: creation/validation-rejection/archival/activation/reassignment all present.
    const archiveAudit = await ctx.prisma.auditLog.findFirst({ where: { workspaceId: workspace.id, action: "KNOWLEDGE_PACK_ARCHIVED", entityId: v1PublicId } });
    const activateAudit = await ctx.prisma.auditLog.findFirst({ where: { workspaceId: workspace.id, action: "KNOWLEDGE_PACK_ACTIVATED", entityId: v2PublicId } });
    const rejectedAudit = await ctx.prisma.auditLog.findFirst({ where: { workspaceId: workspace.id, action: "KNOWLEDGE_PACK_VALIDATION_REJECTED", entityId: v2PublicId } });
    const reassignAudit = await ctx.prisma.auditLog.findFirst({ where: { workspaceId: workspace.id, action: "PROJECT_UPDATED", entityId: project.publicId } });
    expect(archiveAudit).toBeTruthy();
    expect(activateAudit).toBeTruthy();
    expect(rejectedAudit).toBeTruthy();
    expect(reassignAudit).toBeTruthy();

    await cleanupKnowledgePacks(workspace.id);
  });

  it("workspace isolation — the archive endpoint and Project reassignment are both scoped correctly", async () => {
    const wsA = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const wsB = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createActivePack(wsA);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsB.publicId}/knowledge-packs/${packPublicId}/archive`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .expect(404);

    const projectB = await createProjectAsOwner(ctx, ownerAccessToken, wsB.publicId);
    // packPublicId belongs to wsA — attempting to assign it to a wsB Project
    // (correct URL/workspace, wrong pack) must be rejected as unresolvable.
    const crossAttempt = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${wsB.publicId}/projects/${projectB.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .send({ knowledgePackId: packPublicId })
      .expect(422);
    expect(crossAttempt.body.code).toBe("PROJECT_VALIDATION_FAILED");

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsA.publicId } })).id);
    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsB.publicId } })).id);
  });
});
