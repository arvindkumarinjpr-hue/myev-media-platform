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
 * Module 2 Phase 2.3 — Knowledge Pack Validation + Activation, first-version
 * (root) only. See MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §7 and §17.
 * Version cloning / supersession / successor activation is explicitly out
 * of scope here — Phase 2.4.
 */
describe("Knowledge Pack Validation + Activation (e2e)", () => {
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

  /** Creates a Draft and, unless told otherwise, fills in every FR-KP-005 gate so it validates cleanly. */
  async function createDraftPack(
    ws: { publicId: string },
    opts: { complete?: boolean } = { complete: true },
  ): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "EV Content Pack", industryProfile: opts.complete ? { industry: "Electric Vehicles" } : undefined, publishingStrategy: opts.complete ? { cadence: "weekly" } : undefined })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;

    if (opts.complete) {
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
    }

    return packPublicId;
  }

  it("a fully-qualified Draft activates on validate — status flips to ACTIVE and an activation audit record is written", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(res.body.data.status).toBe("ACTIVE");

    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: "KNOWLEDGE_PACK_ACTIVATED", entityId: packPublicId },
    });
    expect(audit).toBeTruthy();

    await cleanupKnowledgePacks(workspace.id);
  });

  it("missing trusted source blocks activation with an itemized reason, and the pack reverts to DRAFT", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws, { complete: false });
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        industryProfile: { industry: "EV" },
        publishingStrategy: { cadence: "weekly" },
        promptTemplates: ALL_CONTENT_TYPES.map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);
    expect(res.body.code).toBe("KNOWLEDGE_VALIDATION_FAILED");
    expect(res.body.details.some((d: string) => d.includes("trusted knowledge source"))).toBe(true);

    const getRes = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(getRes.body.data.status).toBe("DRAFT");

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("prompt template coverage must span every content type — a partial set is itemized by missing type", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws, { complete: false });
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        industryProfile: { industry: "EV" },
        publishingStrategy: { cadence: "weekly" },
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: [{ contentType: "BLOG", promptBody: "Write a blog" }],
      })
      .expect(200);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);
    const reason = res.body.details.find((d: string) => d.includes("prompt template"));
    expect(reason).toBeDefined();
    for (const missing of ["VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"]) {
      expect(reason).toContain(missing);
    }
    expect(reason).not.toContain("BLOG,");

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("empty industry profile blocks activation (brand name + industry profile gate)", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws, { complete: false });
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        publishingStrategy: { cadence: "weekly" },
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ALL_CONTENT_TYPES.map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);
    expect(res.body.details.some((d: string) => d.includes("industry profile"))).toBe(true);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("empty publishing strategy blocks activation", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws, { complete: false });
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        industryProfile: { industry: "EV" },
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ALL_CONTENT_TYPES.map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);
    expect(res.body.details.some((d: string) => d.includes("publishing strategy"))).toBe(true);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("an empty Draft fails all 4 gates simultaneously — every failure is itemized in one response, and a rejection audit record is written", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws, { complete: false });

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);
    expect(res.body.details).toHaveLength(4);

    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: "KNOWLEDGE_PACK_VALIDATION_REJECTED", entityId: packPublicId },
    });
    expect(audit).toBeTruthy();

    await cleanupKnowledgePacks(workspace.id);
  });

  it("after a failed validation, the Draft remains fully editable", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws, { complete: false });
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(422);

    const editRes = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ expectedLockVersion: 1, name: "Edited after rejection" })
      .expect(200);
    expect(editRes.body.data.name).toBe("Edited after rejection");

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("validating a non-Draft Knowledge Pack is rejected", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    await ctx.prisma.knowledgePack.updateMany({ where: { workspaceId: workspace.id, publicId: packPublicId }, data: { status: "ACTIVE" } });

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(409);
    expect(res.body.code).toBe("KNOWLEDGE_CONFLICT");

    await cleanupKnowledgePacks(workspace.id);
  });

  it("a Draft that is a successor version (currentVersionOfId set) is refused — Phase 2.4's supersession workflow, not this endpoint", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const rootPackPublicId = await createDraftPack(ws);
    const successorPackPublicId = await createDraftPack(ws);

    const root = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { workspaceId: workspace.id, publicId: rootPackPublicId } });
    // No endpoint can produce this state yet (Phase 2.4) — set it directly
    // to prove the guard exists ahead of that machinery.
    await ctx.prisma.knowledgePack.updateMany({
      where: { workspaceId: workspace.id, publicId: successorPackPublicId },
      data: { currentVersionOfId: root.id },
    });

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${successorPackPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(409);
    expect(res.body.code).toBe("KNOWLEDGE_CONFLICT");
    expect(res.body.message).toMatch(/successor/i);

    // Confirm nothing was silently mutated — still DRAFT, predecessor untouched.
    const successorAfter = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: successorPackPublicId } });
    expect(successorAfter.status).toBe("DRAFT");
    const rootAfter = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: rootPackPublicId } });
    expect(rootAfter.status).toBe("DRAFT");

    await ctx.prisma.knowledgePack.updateMany({ where: { publicId: successorPackPublicId }, data: { currentVersionOfId: null } });
    await cleanupKnowledgePacks(workspace.id);
  });

  it("concurrency — two simultaneous validate calls on the same Draft: exactly one activates, the other is rejected", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(ws);

    const [first, second] = await Promise.all([
      request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", ws.publicId),
      request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", ws.publicId),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const finalState = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: packPublicId } });
    expect(finalState.status).toBe("ACTIVE");

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } })).id);
  });

  it("RBAC — Content Manager can validate; Content Writer cannot", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const { userId: managerId, accessToken: managerToken } = await createActiveUserAndLogin(ctx, "kp-content-manager");
    await addActiveMemberWithRole(ctx, workspace.id, managerId, "Content Manager");
    const { userId: writerId, accessToken: writerToken } = await createActiveUserAndLogin(ctx, "kp-content-writer-validate");
    await addActiveMemberWithRole(ctx, workspace.id, writerId, "Content Writer");

    const packA = await createDraftPack(ws);
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packA}/validate`)
      .set("Authorization", `Bearer ${writerToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(403);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packA}/validate`)
      .set("Authorization", `Bearer ${managerToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    await cleanupKnowledgePacks(workspace.id);
  });

  it("workspace isolation — validate is not reachable through another workspace's URL", async () => {
    const wsA = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const wsB = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const packPublicId = await createDraftPack(wsA);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsB.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .expect(404);

    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsA.publicId } })).id);
    await cleanupKnowledgePacks((await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsB.publicId } })).id);
  });

  it("a lineage collision at the database layer is translated into a clean 409, not a raw 500, and the Draft rolls back untouched", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const activePackPublicId = await createDraftPack(ws);
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${activePackPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    const activePack = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: activePackPublicId } });

    const collidingDraftPublicId = await createDraftPack(ws);
    // Not reachable via any endpoint yet (Phase 2.4 cloning would produce
    // this) — force the lineage collision directly to prove the DB
    // partial-unique-index backstop is actually wired through this
    // endpoint's error handling.
    await ctx.prisma.knowledgePack.updateMany({ where: { publicId: collidingDraftPublicId }, data: { lineageRootId: activePack.lineageRootId } });

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${collidingDraftPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(409);
    expect(res.body.code).toBe("KNOWLEDGE_CONFLICT");

    const collidingAfter = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: collidingDraftPublicId } });
    expect(collidingAfter.status).toBe("DRAFT");

    await ctx.prisma.knowledgePack.updateMany({ where: { publicId: collidingDraftPublicId }, data: { lineageRootId: collidingAfter.id } });
    await cleanupKnowledgePacks(workspace.id);
  });
});
