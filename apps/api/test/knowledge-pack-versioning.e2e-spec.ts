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
 * Module 2 Phase 2.4 — Knowledge Pack Versioning (full snapshot cloning)
 * and Supersession (successor validation/activation, predecessor RESTRICT
 * and archival). See MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §7-§10.
 * Explicit out-of-scope items proven absent: no automatic Project
 * reassignment, no archive-management endpoints beyond supersession.
 */
describe("Knowledge Pack Versioning + Supersession (e2e)", () => {
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
        seoRules: [{ primaryKeywords: ["ev"], secondaryKeywords: ["electric"], internalLinkingPolicy: { maxLinks: 5 }, schemaPreferences: { type: "Article" } }],
        brandGuidelines: [{ toneOfVoice: "confident", terminology: { ev: "electric vehicle" }, ctaRules: "always link pricing" }],
        keywordSets: [{ name: "core", keywords: ["ev", "electric vehicle"] }],
        competitors: [{ domain: "rival.example", notes: "cheaper pricing" }],
      })
      .expect(200);

    const validateRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(validateRes.body.data.status).toBe("ACTIVE");

    return packPublicId;
  }

  it("creates a Draft V2 from Active V1: V1 stays ACTIVE, V2 is DRAFT, lineage/predecessor/version_number are correct", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(ws);

    const versionRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(201);
    expect(versionRes.body.data.status).toBe("DRAFT");
    expect(versionRes.body.data.versionNumber).toBe(2);
    const v2PublicId = versionRes.body.data.publicId as string;

    const v1After = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: v1PublicId } });
    const v2After = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: v2PublicId } });
    expect(v1After.status).toBe("ACTIVE");
    expect(v2After.status).toBe("DRAFT");
    expect(v2After.lineageRootId).toBe(v1After.lineageRootId);
    expect(v2After.currentVersionOfId).toBe(v1After.id);
    expect(v2After.versionNumber).toBe(v1After.versionNumber + 1);
    expect(v2After.id).not.toBe(v1After.id);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("cloning copies root config and every child collection, each child getting a new row identity never shared with V1", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(ws);

    const versionRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(201);
    const v2 = versionRes.body.data;

    const v1Res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    const v1 = v1Res.body.data;

    expect(v2.industryProfile).toEqual(v1.industryProfile);
    expect(v2.publishingStrategy).toEqual(v1.publishingStrategy);
    expect(v2.sources).toEqual(v1.sources);
    expect(v2.promptTemplates).toEqual(v1.promptTemplates);
    expect(v2.seoRules).toEqual(v1.seoRules);
    expect(v2.brandGuidelines).toEqual(v1.brandGuidelines);
    expect(v2.keywordSets).toEqual(v1.keywordSets);
    expect(v2.competitors).toEqual(v1.competitors);

    // Physical row independence — internal ids differ across every child table, never shared.
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const [v1Row, v2Row] = await Promise.all([
      ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v1PublicId } }),
      ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v2.publicId } }),
    ]);
    const [v1Sources, v2Sources] = await Promise.all([
      ctx.prisma.knowledgeSource.findMany({ where: { knowledgePackId: v1Row.id } }),
      ctx.prisma.knowledgeSource.findMany({ where: { knowledgePackId: v2Row.id } }),
    ]);
    expect(v1Sources).toHaveLength(1);
    expect(v2Sources).toHaveLength(1);
    expect(v1Sources[0].id).not.toBe(v2Sources[0].id);
    const [v1Templates, v2Templates] = await Promise.all([
      ctx.prisma.promptTemplate.findMany({ where: { knowledgePackId: v1Row.id } }),
      ctx.prisma.promptTemplate.findMany({ where: { knowledgePackId: v2Row.id } }),
    ]);
    const v1TemplateIds = new Set(v1Templates.map((t) => t.id));
    for (const t of v2Templates) expect(v1TemplateIds.has(t.id)).toBe(false);
    // Template-level version_number carries forward unchanged by cloning (§6 two-layer model).
    expect(v2Templates.map((t) => t.versionNumber).sort()).toEqual(v1Templates.map((t) => t.versionNumber).sort());

    await cleanupKnowledgePacks(workspace.id);
  });

  it("editing V2 cannot mutate V1, and ACTIVE V1 remains immutable through the existing Draft-only update guard", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(ws);

    const versionRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(201);
    const v2PublicId = versionRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ expectedLockVersion: 1, name: "V2 renamed" })
      .expect(200);

    const v1Res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(v1Res.body.data.name).toBe("EV Content Pack");
    expect(v1Res.body.data.status).toBe("ACTIVE");

    const v1EditAttempt = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ expectedLockVersion: 1, name: "Should be rejected" })
      .expect(409);
    expect(v1EditAttempt.body.code).toBe("KNOWLEDGE_CONFLICT");

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("a version can only be created from an Active predecessor — not from Draft or Archived", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const draftRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Still a Draft" })
      .expect(201);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${draftRes.body.data.publicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(409);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("concurrency — two simultaneous version-creation calls on the same Active predecessor: exactly one succeeds, no duplicate/divergent version_number", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(ws);

    const [first, second] = await Promise.all([
      request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", ws.publicId),
      request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", ws.publicId),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const v1 = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v1PublicId } });
    const successors = await ctx.prisma.knowledgePack.findMany({ where: { currentVersionOfId: v1.id, deletedAt: null } });
    expect(successors).toHaveLength(1);
    expect(successors[0].versionNumber).toBe(2);

    await cleanupKnowledgePacks(workspace.id);
  });

  it("successor validation fails and returns V2 to DRAFT if required data is missing, leaving V1 untouched", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(ws);
    const versionRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(201);
    const v2PublicId = versionRes.body.data.publicId as string;

    // Break gate 1 (trusted source) on the otherwise-valid clone.
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ expectedLockVersion: 1, sources: [] })
      .expect(200);

    const validateRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);
    expect(validateRes.body.details.some((d: string) => d.includes("trusted knowledge source"))).toBe(true);

    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const [v1After, v2After] = await Promise.all([
      ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v1PublicId } }),
      ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v2PublicId } }),
    ]);
    expect(v2After.status).toBe("DRAFT");
    expect(v1After.status).toBe("ACTIVE");

    await cleanupKnowledgePacks(workspace.id);
  });

  it("supersession is blocked by the Project RESTRICT rule: V2 stays DRAFT, V1 stays ACTIVE, the Project FK is never touched — no automatic reassignment", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(ws);
    const project = await createProjectAsOwner(ctx, ownerAccessToken, ws.publicId);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const v1 = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v1PublicId } });
    // Project reassignment has no production endpoint yet (§8/§20 — out of
    // Phase 2.4 scope) — set the reference directly, matching the
    // minimum-test-setup instruction, not a production capability.
    await ctx.prisma.project.updateMany({ where: { publicId: project.publicId, workspaceId: workspace.id }, data: { knowledgePackId: v1.id } });

    const versionRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(201);
    const v2PublicId = versionRes.body.data.publicId as string;

    const validateRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);
    expect(validateRes.body.details.some((d: string) => /RESTRICT/.test(d))).toBe(true);

    const [v1After, v2After, projectAfter] = await Promise.all([
      ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v1PublicId } }),
      ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v2PublicId } }),
      ctx.prisma.project.findFirstOrThrow({ where: { publicId: project.publicId, workspaceId: workspace.id } }),
    ]);
    expect(v1After.status).toBe("ACTIVE");
    expect(v1After.archivedAt).toBeNull();
    expect(v2After.status).toBe("DRAFT");
    expect(projectAfter.knowledgePackId).toBe(v1.id);

    await ctx.prisma.project.updateMany({ where: { publicId: project.publicId, workspaceId: workspace.id }, data: { knowledgePackId: null } });
    await cleanupKnowledgePacks(workspace.id);
  });

  it("successful supersession archives V1 and activates V2 atomically; the DB still enforces exactly one ACTIVE row per lineage; no VALIDATING row survives", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(ws);
    const versionRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(201);
    const v2PublicId = versionRes.body.data.publicId as string;

    const validateRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(validateRes.body.data.status).toBe("ACTIVE");

    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const v1After = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: v1PublicId } });
    expect(v1After.status).toBe("ARCHIVED");
    expect(v1After.archivedAt).not.toBeNull();

    const lineageRows = await ctx.prisma.knowledgePack.findMany({ where: { lineageRootId: v1After.lineageRootId, deletedAt: null } });
    const activeCount = lineageRows.filter((r) => r.status === "ACTIVE").length;
    const validatingCount = lineageRows.filter((r) => r.status === "VALIDATING").length;
    expect(activeCount).toBe(1);
    expect(validatingCount).toBe(0);

    const archiveAudit = await ctx.prisma.auditLog.findFirst({ where: { workspaceId: workspace.id, action: "KNOWLEDGE_PACK_ARCHIVED", entityId: v1PublicId } });
    expect(archiveAudit).toBeTruthy();
    const activateAudit = await ctx.prisma.auditLog.findFirst({ where: { workspaceId: workspace.id, action: "KNOWLEDGE_PACK_ACTIVATED", entityId: v2PublicId } });
    expect(activateAudit).toBeTruthy();

    await cleanupKnowledgePacks(workspace.id);
  });

  it("RBAC — creating a version requires KP_UPDATE; Content Writer is forbidden", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const v1PublicId = await createActivePack(ws);
    const { userId, accessToken } = await createActiveUserAndLogin(ctx, "kp-versioning-writer");
    await addActiveMemberWithRole(ctx, workspace.id, userId, "Content Writer");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(403);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    await cleanupKnowledgePacks(workspace.id);
  });

  it("workspace isolation — version endpoints are not reachable through another workspace's URL", async () => {
    const wsA = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const wsB = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(wsA);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsB.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .expect(404);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${wsB.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .expect(404);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsA.publicId } })).id);
    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsB.publicId } })).id);
  });

  it("version-history query lists every version in a lineage, oldest first, with each row's predecessor and status correct", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const v1PublicId = await createActivePack(ws);
    const versionRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(201);
    const v2PublicId = versionRes.body.data.publicId as string;
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    const historyRes = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v1PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(historyRes.body.data).toHaveLength(2);
    expect(historyRes.body.data[0].publicId).toBe(v1PublicId);
    expect(historyRes.body.data[0].versionNumber).toBe(1);
    expect(historyRes.body.data[0].status).toBe("ARCHIVED");
    expect(historyRes.body.data[0].currentVersionOfPublicId).toBeNull();
    expect(historyRes.body.data[1].publicId).toBe(v2PublicId);
    expect(historyRes.body.data[1].versionNumber).toBe(2);
    expect(historyRes.body.data[1].status).toBe("ACTIVE");
    expect(historyRes.body.data[1].currentVersionOfPublicId).toBe(v1PublicId);

    // Querying via either version's publicId resolves to the same lineage.
    const historyViaV2 = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${v2PublicId}/versions`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(historyViaV2.body.data.map((v: { publicId: string }) => v.publicId).sort()).toEqual([v1PublicId, v2PublicId].sort());

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });
});
