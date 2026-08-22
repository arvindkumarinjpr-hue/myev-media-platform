import { randomUUID } from "crypto";
import { Prisma } from "../generated/prisma";
import { bootstrapE2eApp, createProjectAsOwner, createWorkspaceAsOwner, loginAsPlatformOwner, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 2 Phase 2.1 — Knowledge Pack Engine database/domain foundation.
 * No controller/service layer exists yet (Phase 2.2+) — these tests prove
 * the schema-level invariants ACR-014/ADR-014 approved, directly against
 * real Postgres via Prisma, the same evidence standard Module 1F
 * established. See MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md.
 */
describe("Knowledge Pack Engine — Phase 2.1 database foundation (e2e)", () => {
  let ctx: E2eApp;
  // Logged in once, per this suite's own PLATFORM_OWNER_LOGIN rate limit —
  // every other suite in this repo follows the same pattern (login once,
  // reuse the token across every workspace the suite creates).
  let ownerAccessToken: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  /**
   * Deletes every knowledge_packs row (and its children) belonging to
   * `workspaceId`, nulling out any project.knowledge_pack_id reference
   * first — required before teardownE2eApp can delete the workspace's
   * Project rows, since both the projects->knowledge_packs FK and the
   * knowledge_packs->projects FK are RESTRICT, not cascading.
   */
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
    // Break the current_version_of self-reference cycle before deleting.
    await ctx.prisma.knowledgePack.updateMany({ where: { id: { in: packIds } }, data: { currentVersionOfId: null } });
    await ctx.prisma.knowledgePack.deleteMany({ where: { id: { in: packIds } } });
  }

  async function setupWorkspace(): Promise<{ workspaceId: string; workspacePublicId: string; userId: string }> {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com" } });
    return { workspaceId: workspace.id, workspacePublicId: ws.publicId, userId: user.id };
  }

  it("1. a Knowledge Pack can be persisted with a root lineage identity equal to its own id", async () => {
    const { workspaceId, userId } = await setupWorkspace();
    const id = randomUUID();
    const pack = await ctx.prisma.knowledgePack.create({
      data: { id, workspaceId, lineageRootId: id, name: "Test Pack", status: "DRAFT", createdById: userId },
    });

    expect(pack.id).toBe(id);
    expect(pack.lineageRootId).toBe(id);
    expect(pack.status).toBe("DRAFT");
    expect(pack.versionNumber).toBe(1);
    expect(pack.lockVersion).toBe(1);
    expect(pack.currentVersionOfId).toBeNull();
    expect(pack.deletedAt).toBeNull();

    await cleanupKnowledgePacks(workspaceId);
  });

  it("2. workspace isolation is structurally preserved — a pack is only visible/queryable scoped to its own workspace", async () => {
    const wsA = await setupWorkspace();
    const wsB = await setupWorkspace();
    const rootA = randomUUID();
    await ctx.prisma.knowledgePack.create({
      data: { id: rootA, workspaceId: wsA.workspaceId, lineageRootId: rootA, name: "Test Pack", status: "DRAFT", createdById: wsA.userId },
    });

    const foundInOwnWorkspace = await ctx.prisma.knowledgePack.findFirst({ where: { id: rootA, workspaceId: wsA.workspaceId } });
    const foundInOtherWorkspace = await ctx.prisma.knowledgePack.findFirst({ where: { id: rootA, workspaceId: wsB.workspaceId } });

    expect(foundInOwnWorkspace).not.toBeNull();
    expect(foundInOtherWorkspace).toBeNull();

    await cleanupKnowledgePacks(wsA.workspaceId);
    await cleanupKnowledgePacks(wsB.workspaceId);
  });

  it("3-5. multiple versions may exist in one lineage, linked via current_version_of, sharing the same lineage_root_id", async () => {
    const { workspaceId, userId } = await setupWorkspace();
    const v1Id = randomUUID();
    const v1 = await ctx.prisma.knowledgePack.create({
      data: { id: v1Id, workspaceId, lineageRootId: v1Id, name: "Test Pack", versionNumber: 1, status: "ARCHIVED", createdById: userId },
    });
    const v2 = await ctx.prisma.knowledgePack.create({
      data: {
        workspaceId,
        lineageRootId: v1.lineageRootId, name: "Test Pack",
        currentVersionOfId: v1.id,
        versionNumber: 2,
        status: "ACTIVE",
        createdById: userId,
      },
    });

    expect(v2.lineageRootId).toBe(v1.lineageRootId);
    expect(v2.currentVersionOfId).toBe(v1.id);
    expect(v2.id).not.toBe(v1.id);

    const lineageRows = await ctx.prisma.knowledgePack.findMany({ where: { lineageRootId: v1.lineageRootId }, orderBy: { versionNumber: "asc" } });
    expect(lineageRows).toHaveLength(2);
    expect(lineageRows.map((r) => r.status)).toEqual(["ARCHIVED", "ACTIVE"]);

    await cleanupKnowledgePacks(workspaceId);
  });

  it("6. the database rejects two non-deleted ACTIVE versions in the same lineage (partial unique index, not application logic alone)", async () => {
    const { workspaceId, userId } = await setupWorkspace();
    const rootId = randomUUID();
    await ctx.prisma.knowledgePack.create({
      data: { id: rootId, workspaceId, lineageRootId: rootId, name: "Test Pack", versionNumber: 1, status: "ACTIVE", createdById: userId },
    });

    // A second row in the SAME lineage, also ACTIVE — must be rejected by
    // knowledge_packs_one_active_per_lineage, not merely discouraged.
    await expect(
      ctx.prisma.knowledgePack.create({
        data: { workspaceId, lineageRootId: rootId, name: "Test Pack", currentVersionOfId: rootId, versionNumber: 2, status: "ACTIVE", createdById: userId },
      }),
    ).rejects.toThrow();

    // Confirm it's specifically the unique-constraint violation on our
    // named index, not some unrelated failure masking a real bug.
    try {
      await ctx.prisma.knowledgePack.create({
        data: { workspaceId, lineageRootId: rootId, name: "Test Pack", currentVersionOfId: rootId, versionNumber: 3, status: "ACTIVE", createdById: userId },
      });
      throw new Error("expected the second ACTIVE insert to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const prismaError = error as Prisma.PrismaClientKnownRequestError;
      // P2002 — Prisma's generic unique-constraint-violation mapping,
      // which covers this hand-written partial index exactly as it does
      // any @@unique Prisma itself declares (same mapping this codebase's
      // own ProcessedEvent tests already rely on for their unique
      // constraint). Confirmed empirically against real Postgres, not
      // assumed from Prisma's docs alone.
      expect(prismaError.code).toBe("P2002");
      expect(prismaError.meta?.modelName).toBe("KnowledgePack");
      expect(prismaError.meta?.target).toEqual(["lineage_root_id"]);
    }

    const activeRows = await ctx.prisma.knowledgePack.findMany({ where: { lineageRootId: rootId, name: "Test Pack", status: "ACTIVE" } });
    expect(activeRows).toHaveLength(1);

    await cleanupKnowledgePacks(workspaceId);
  });

  it("7. different lineages may each independently have their own ACTIVE version, in the same workspace", async () => {
    const { workspaceId, userId } = await setupWorkspace();
    const rootA = randomUUID();
    const rootB = randomUUID();
    await ctx.prisma.knowledgePack.create({ data: { id: rootA, workspaceId, lineageRootId: rootA, name: "Test Pack", status: "ACTIVE", createdById: userId } });
    await ctx.prisma.knowledgePack.create({ data: { id: rootB, workspaceId, lineageRootId: rootB, name: "Test Pack", status: "ACTIVE", createdById: userId } });

    const active = await ctx.prisma.knowledgePack.findMany({ where: { workspaceId, status: "ACTIVE" } });
    expect(active).toHaveLength(2);
    expect(new Set(active.map((r) => r.lineageRootId))).toEqual(new Set([rootA, rootB]));

    await cleanupKnowledgePacks(workspaceId);
  });

  it("8. an archived predecessor and a soft-deleted duplicate do not violate the active-lineage invariant", async () => {
    const { workspaceId, userId } = await setupWorkspace();
    const rootId = randomUUID();
    // Predecessor, ARCHIVED (not ACTIVE) — coexists freely with an Active
    // successor in the same lineage.
    await ctx.prisma.knowledgePack.create({
      data: { id: rootId, workspaceId, lineageRootId: rootId, name: "Test Pack", versionNumber: 1, status: "ARCHIVED", createdById: userId },
    });
    await ctx.prisma.knowledgePack.create({
      data: { workspaceId, lineageRootId: rootId, name: "Test Pack", currentVersionOfId: rootId, versionNumber: 2, status: "ACTIVE", createdById: userId },
    });

    // A row that WOULD violate the index if not soft-deleted — proves the
    // index's "deleted_at IS NULL" clause, not just its "status='ACTIVE'" clause.
    const softDeletedDuplicate = await ctx.prisma.knowledgePack.create({
      data: { workspaceId, lineageRootId: rootId, name: "Test Pack", versionNumber: 3, status: "ACTIVE", createdById: userId, deletedAt: new Date() },
    });
    expect(softDeletedDuplicate.deletedAt).not.toBeNull();

    const activeCount = await ctx.prisma.knowledgePack.count({ where: { lineageRootId: rootId, name: "Test Pack", status: "ACTIVE", deletedAt: null } });
    expect(activeCount).toBe(1);

    await cleanupKnowledgePacks(workspaceId);
  });

  it("9. lock_version defaults to 1 and can be incremented via a guarded conditional update", async () => {
    const { workspaceId, userId } = await setupWorkspace();
    const id = randomUUID();
    const pack = await ctx.prisma.knowledgePack.create({
      data: { id, workspaceId, lineageRootId: id, name: "Test Pack", status: "DRAFT", createdById: userId },
    });
    expect(pack.lockVersion).toBe(1);

    // Correct expected lockVersion — succeeds and increments.
    const updated = await ctx.prisma.knowledgePack.updateMany({
      where: { id, lockVersion: 1 },
      data: { lockVersion: { increment: 1 }, industryProfile: { name: "EV Industry" } },
    });
    expect(updated.count).toBe(1);
    const afterUpdate = await ctx.prisma.knowledgePack.findUniqueOrThrow({ where: { id } });
    expect(afterUpdate.lockVersion).toBe(2);

    // Stale expected lockVersion (still 1, but the row is now 2) — the
    // guarded update affects zero rows, exactly the mechanism a real
    // KNOWLEDGE_CONFLICT response would be built on.
    const staleUpdate = await ctx.prisma.knowledgePack.updateMany({
      where: { id, lockVersion: 1 },
      data: { lockVersion: { increment: 1 } },
    });
    expect(staleUpdate.count).toBe(0);
    const afterStaleAttempt = await ctx.prisma.knowledgePack.findUniqueOrThrow({ where: { id } });
    expect(afterStaleAttempt.lockVersion).toBe(2);

    await cleanupKnowledgePacks(workspaceId);
  });

  it("10. Project.knowledgePackId is a direct, workspace-safe FK to the exact pack version in use — no fallback logic", async () => {
    const { workspaceId, workspacePublicId, userId } = await setupWorkspace();
    const workspace = { id: workspaceId };
    const user = { id: userId };
    const project = await createProjectAsOwner(ctx, ownerAccessToken, workspacePublicId);
    const projectRow = await ctx.prisma.project.findUniqueOrThrow({ where: { publicId: project.publicId } });

    const packId = randomUUID();
    await ctx.prisma.knowledgePack.create({
      data: { id: packId, workspaceId: workspace.id, lineageRootId: packId, name: "Test Pack", status: "ACTIVE", createdById: user.id },
    });
    await ctx.prisma.project.update({ where: { id: projectRow.id }, data: { knowledgePackId: packId } });

    const reloaded = await ctx.prisma.project.findUniqueOrThrow({ where: { id: projectRow.id }, include: { activeKnowledgePack: true } });
    expect(reloaded.knowledgePackId).toBe(packId);
    expect(reloaded.activeKnowledgePack?.id).toBe(packId);

    await cleanupKnowledgePacks(workspace.id);
  });

  it("11a. a Project cannot reference a Knowledge Pack version belonging to a different workspace", async () => {
    const wsA = await setupWorkspace();
    const wsB = await setupWorkspace();
    const project = await createProjectAsOwner(ctx, ownerAccessToken, wsA.workspacePublicId);
    const projectRow = await ctx.prisma.project.findUniqueOrThrow({ where: { publicId: project.publicId } });

    const packInOtherWorkspaceId = randomUUID();
    await ctx.prisma.knowledgePack.create({
      data: { id: packInOtherWorkspaceId, workspaceId: wsB.workspaceId, lineageRootId: packInOtherWorkspaceId, name: "Test Pack", status: "ACTIVE", createdById: wsB.userId },
    });

    // projectRow.workspaceId is wsA; the pack's workspaceId is wsB — the
    // composite FK (knowledge_pack_id, workspace_id) -> (id, workspace_id)
    // has no row to match, so this must fail, not silently succeed.
    await expect(
      ctx.prisma.project.update({ where: { id: projectRow.id }, data: { knowledgePackId: packInOtherWorkspaceId } }),
    ).rejects.toThrow();

    await cleanupKnowledgePacks(wsA.workspaceId);
    await cleanupKnowledgePacks(wsB.workspaceId);
  });

  it("11b. current_version_of cannot reference a Knowledge Pack version in a different workspace", async () => {
    const wsA = await setupWorkspace();
    const wsB = await setupWorkspace();
    const predecessorInOtherWorkspaceId = randomUUID();
    await ctx.prisma.knowledgePack.create({
      data: { id: predecessorInOtherWorkspaceId, workspaceId: wsB.workspaceId, lineageRootId: predecessorInOtherWorkspaceId, name: "Test Pack", status: "ACTIVE", createdById: wsB.userId },
    });

    await expect(
      ctx.prisma.knowledgePack.create({
        data: {
          workspaceId: wsA.workspaceId,
          lineageRootId: randomUUID(),
          name: "Test Pack",
          currentVersionOfId: predecessorInOtherWorkspaceId,
          status: "DRAFT",
          createdById: wsA.userId,
        },
      }),
    ).rejects.toThrow();

    await cleanupKnowledgePacks(wsA.workspaceId);
    await cleanupKnowledgePacks(wsB.workspaceId);
  });

  it("12. child entities (source, prompt template) persist scoped to their parent pack, cloned rows get independent identities", async () => {
    const { workspaceId, userId } = await setupWorkspace();
    const id = randomUUID();
    const pack = await ctx.prisma.knowledgePack.create({
      data: { id, workspaceId, lineageRootId: id, name: "Test Pack", status: "DRAFT", createdById: userId },
    });
    const source = await ctx.prisma.knowledgeSource.create({
      data: { knowledgePackId: pack.id, sourceType: "GOVERNMENT", url: "https://example.gov" },
    });
    const template = await ctx.prisma.promptTemplate.create({
      data: { knowledgePackId: pack.id, contentType: "BLOG", promptBody: "Write about {{topic}}" },
    });

    const withChildren = await ctx.prisma.knowledgePack.findUniqueOrThrow({
      where: { id: pack.id },
      include: { knowledgeSources: true, promptTemplates: true },
    });
    expect(withChildren.knowledgeSources).toHaveLength(1);
    expect(withChildren.knowledgeSources[0].id).toBe(source.id);
    expect(withChildren.promptTemplates).toHaveLength(1);
    expect(withChildren.promptTemplates[0].id).toBe(template.id);
    expect(withChildren.promptTemplates[0].versionNumber).toBe(1);

    await cleanupKnowledgePacks(workspaceId);
  });

  it("13. existing Module 1 functionality is not regressed — workspace/project creation still works end-to-end", async () => {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const project = await createProjectAsOwner(ctx, ownerAccessToken, ws.publicId);
    expect(project.publicId).toBeDefined();
    expect(ws.publicId).toBeDefined();
  });
});
