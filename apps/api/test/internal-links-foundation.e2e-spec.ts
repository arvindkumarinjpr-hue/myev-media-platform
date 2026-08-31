import { InternalLinksService } from "../src/modules/internal-links/internal-links.service";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 8 Phase 8.1 — AI Internal Linking Engine: Domain + Persistence
 * Foundation. No controller exists yet (Module 8 Architecture Checkpoint
 * Correction, Phase 8.1 scope), so this suite exercises InternalLinksService
 * directly — the same `ctx.app.get(Service)` pattern used by
 * agent-executor.e2e-spec.ts / background-jobs.e2e-spec.ts — against a
 * real, migrated Postgres database. Proves: self-link rejection, source/
 * target eligibility against the verified real ContentItemStatus values,
 * lifecycle-transition validity, the partial-unique-index-backed
 * duplicate/regeneration/history invariants, concurrent-duplicate race
 * safety, and workspace isolation. Candidate discovery, scoring, anchor
 * generation, and any HTTP surface are explicitly NOT this phase's scope.
 */
describe("Internal Links — Phase 8.1 Domain + Persistence Foundation (e2e)", () => {
  let ctx: E2eApp;
  let service: InternalLinksService;
  let ownerAccessToken: string;
  let ownerUserId: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    service = ctx.app.get(InternalLinksService);
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

  async function createItem(ws: Workspace, title = "Internal link fixture item"): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(auth(ws))
      .send({ contentType: "VIDEO", title, body: { script: "Fixture content for Module 8 Phase 8.1 tests." } })
      .expect(201);
    return res.body.data.publicId as string;
  }

  async function moveTo(ws: Workspace, itemPublicId: string, status: "IN_PROGRESS" | "REVIEW" | "APPROVED" | "ARCHIVED" | "DELETED"): Promise<void> {
    const base = `/api/v1/workspaces/${ws.publicId}/content-items/${itemPublicId}`;
    if (status === "IN_PROGRESS" || status === "REVIEW" || status === "APPROVED") {
      await request(ctx.app.getHttpServer()).post(`${base}/start`).set(auth(ws)).expect(200);
    }
    if (status === "REVIEW" || status === "APPROVED") {
      await request(ctx.app.getHttpServer()).post(`${base}/submit-for-review`).set(auth(ws)).send({}).expect(200);
    }
    if (status === "APPROVED") {
      await request(ctx.app.getHttpServer()).post(`${base}/approve`).set(auth(ws)).send({}).expect(200);
    }
    if (status === "ARCHIVED") {
      await request(ctx.app.getHttpServer()).post(`${base}/archive`).set(auth(ws)).expect(200);
    }
    if (status === "DELETED") {
      await request(ctx.app.getHttpServer()).delete(base).set(auth(ws)).expect(200);
    }
  }

  async function createDraftSource(ws: Workspace): Promise<string> {
    return createItem(ws, "Draft source");
  }

  async function createApprovedTarget(ws: Workspace): Promise<string> {
    const id = await createItem(ws, "Approved target");
    await moveTo(ws, id, "APPROVED");
    return id;
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await ctx.prisma.internalLink.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentItem.updateMany({ where: { workspaceId: ws.id }, data: { currentVersionId: null, featuredMediaAssetId: null, seriesId: null, deletedAt: new Date() } });
    await ctx.prisma.contentReviewEvent.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentVersion.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentItem.deleteMany({ where: { workspaceId: ws.id } });
  }

  const baseInput = (sourceId: string, targetId: string) => ({
    sourceContentItemPublicId: sourceId,
    targetContentItemPublicId: targetId,
    anchorText: "our EV charging guide",
    relevanceScore: 72,
    evidence: { sharedKeywords: ["ev charging"] },
  });

  it("creates a GENERATED recommendation for an eligible DRAFT source -> APPROVED target", async () => {
    const ws = await createWorkspace();
    const source = await createDraftSource(ws);
    const target = await createApprovedTarget(ws);

    const created = await service.create(ws.id, null, baseInput(source, target));
    expect(created.status).toBe("GENERATED");
    expect(created.anchorText).toBe("our EV charging guide");
    expect(created.relevanceScore).toBe(72);

    await cleanup(ws);
  });

  it("accepts IN_PROGRESS as an eligible source too", async () => {
    const ws = await createWorkspace();
    const source = await createItem(ws, "In-progress source");
    await moveTo(ws, source, "IN_PROGRESS");
    const target = await createApprovedTarget(ws);

    const created = await service.create(ws.id, null, baseInput(source, target));
    expect(created.status).toBe("GENERATED");

    await cleanup(ws);
  });

  it("rejects a self-link before persistence — 422, nothing created", async () => {
    const ws = await createWorkspace();
    const item = await createDraftSource(ws);

    await expect(service.create(ws.id, null, baseInput(item, item))).rejects.toMatchObject({ status: 422 });

    const count = await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);

    await cleanup(ws);
  });

  describe("source eligibility", () => {
    it.each(["REVIEW", "APPROVED", "ARCHIVED", "DELETED"] as const)("rejects a %s source — 422, nothing created", async (status) => {
      const ws = await createWorkspace();
      const source = await createItem(ws);
      await moveTo(ws, source, status);
      const target = await createApprovedTarget(ws);

      await expect(service.create(ws.id, null, baseInput(source, target))).rejects.toMatchObject({ status: 422 });
      expect(await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id } })).toBe(0);

      await cleanup(ws);
    });
  });

  describe("target eligibility", () => {
    it.each(["DRAFT", "IN_PROGRESS", "REVIEW", "ARCHIVED", "DELETED"] as const)("rejects a %s target — 422, nothing created", async (status) => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createItem(ws);
      if (status !== "DRAFT") await moveTo(ws, target, status);

      await expect(service.create(ws.id, null, baseInput(source, target))).rejects.toMatchObject({ status: 422 });
      expect(await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id } })).toBe(0);

      await cleanup(ws);
    });
  });

  it("rejects an invalid relevance score before any lookup — 422", async () => {
    const ws = await createWorkspace();
    const source = await createDraftSource(ws);
    const target = await createApprovedTarget(ws);

    await expect(service.create(ws.id, null, { ...baseInput(source, target), relevanceScore: 101 })).rejects.toMatchObject({ status: 422 });
    await expect(service.create(ws.id, null, { ...baseInput(source, target), relevanceScore: -1 })).rejects.toMatchObject({ status: 422 });

    await cleanup(ws);
  });

  describe("workspace isolation", () => {
    it("rejects a source from a different workspace — enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const foreignSource = await createDraftSource(other);
      const target = await createApprovedTarget(ws);

      await expect(service.create(ws.id, null, baseInput(foreignSource, target))).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });

    it("rejects a target from a different workspace — enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const source = await createDraftSource(ws);
      const foreignTarget = await createApprovedTarget(other);

      await expect(service.create(ws.id, null, baseInput(source, foreignTarget))).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });

    it("an InternalLink row's workspace always matches both its source and target content items", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      const created = await service.create(ws.id, null, baseInput(source, target));

      const row = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { id: created.id }, include: { sourceContentItem: true, targetContentItem: true } });
      expect(row.sourceContentItem.workspaceId).toBe(ws.id);
      expect(row.targetContentItem.workspaceId).toBe(ws.id);
      expect(row.workspaceId).toBe(ws.id);

      await cleanup(ws);
    });
  });

  describe("lifecycle transitions", () => {
    it("GENERATED -> ACCEPTED: same row remains active, reviewedBy/reviewedAt set", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      const created = await service.create(ws.id, null, baseInput(source, target));

      const accepted = await service.accept(ws.id, created.publicId, ownerUserId);
      expect(accepted.id).toBe(created.id);
      expect(accepted.status).toBe("ACCEPTED");
      expect(accepted.reviewedById).toBe(ownerUserId);
      expect(accepted.reviewedAt).not.toBeNull();

      expect(await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id } })).toBe(1);
      await cleanup(ws);
    });

    it("GENERATED -> REJECTED stores the rejection reason", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      const created = await service.create(ws.id, null, baseInput(source, target));

      const rejected = await service.reject(ws.id, created.publicId, ownerUserId, "Not topically relevant enough.");
      expect(rejected.status).toBe("REJECTED");
      expect(rejected.rejectionReason).toBe("Not topically relevant enough.");

      await cleanup(ws);
    });

    it("rejects every invalid transition with a typed 409, valid state never changes", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      const created = await service.create(ws.id, null, baseInput(source, target));
      const rejectedRow = await service.reject(ws.id, created.publicId, ownerUserId, "no");

      // ACCEPTED -> REJECTED is not allowed.
      const acceptedElsewhere = await service.create(ws.id, null, baseInput(source, await createApprovedTarget(ws)));
      await service.accept(ws.id, acceptedElsewhere.publicId, ownerUserId);
      await expect(service.reject(ws.id, acceptedElsewhere.publicId, ownerUserId, "changed my mind")).rejects.toMatchObject({ status: 409 });

      // No resurrection from REJECTED.
      await expect(service.accept(ws.id, rejectedRow.publicId, ownerUserId)).rejects.toMatchObject({ status: 409 });
      await expect(service.markStale(ws.id, rejectedRow.publicId, "edited")).rejects.toMatchObject({ status: 409 });

      const stillRejected = await service.findOne(ws.id, rejectedRow.publicId);
      expect(stillRejected.status).toBe("REJECTED");

      await cleanup(ws);
    });
  });

  describe("duplicate / race safety", () => {
    it("a second create() for the same live pair is rejected with a typed conflict, never a raw Prisma error", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      await service.create(ws.id, null, baseInput(source, target));

      await expect(service.create(ws.id, null, baseInput(source, target))).rejects.toMatchObject({
        status: 409,
        response: { code: "INTERNAL_LINK_ACTIVE_RECOMMENDATION_EXISTS" },
      });

      expect(await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id } })).toBe(1);
      await cleanup(ws);
    });

    it("concurrent create() for the same fresh pair: exactly one succeeds, the loser gets a typed conflict, no raw Prisma error leaks", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);

      const results = await Promise.allSettled([
        service.create(ws.id, null, baseInput(source, target)),
        service.create(ws.id, null, baseInput(source, target)),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 409, response: { code: "INTERNAL_LINK_ACTIVE_RECOMMENDATION_EXISTS" } });

      expect(await ctx.prisma.internalLink.count({ where: { workspaceId: ws.id } })).toBe(1);
      await cleanup(ws);
    });
  });

  describe("history / regeneration behavior (Correction §5-6, all four sequences)", () => {
    it("sequence 1: GENERATED -> ACCEPTED — same row remains the sole active row for the pair", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      const first = await service.create(ws.id, null, baseInput(source, target));
      await service.accept(ws.id, first.publicId, ownerUserId);

      const live = await ctx.prisma.internalLink.findMany({ where: { workspaceId: ws.id, status: { in: ["GENERATED", "ACCEPTED"] } } });
      expect(live).toHaveLength(1);
      expect(live[0].status).toBe("ACCEPTED");

      await cleanup(ws);
    });

    it("sequence 2: GENERATED -> REJECTED -> new GENERATED — rejected history remains, exactly one live row", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      const first = await service.create(ws.id, null, baseInput(source, target));
      await service.reject(ws.id, first.publicId, ownerUserId, "not relevant yet");

      const second = await service.create(ws.id, null, baseInput(source, target));
      expect(second.id).not.toBe(first.id);

      const all = await ctx.prisma.internalLink.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: "asc" } });
      expect(all).toHaveLength(2);
      expect(all[0].status).toBe("REJECTED");
      expect(all[1].status).toBe("GENERATED");
      const live = all.filter((r) => r.status === "GENERATED" || r.status === "ACCEPTED");
      expect(live).toHaveLength(1);

      await cleanup(ws);
    });

    it("sequence 3: GENERATED -> STALE -> new GENERATED — stale history remains, exactly one live row", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      const first = await service.create(ws.id, null, baseInput(source, target));
      await service.markStale(ws.id, first.publicId, "source content edited");

      const second = await service.create(ws.id, null, baseInput(source, target));
      expect(second.id).not.toBe(first.id);

      const all = await ctx.prisma.internalLink.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: "asc" } });
      expect(all).toHaveLength(2);
      expect(all[0].status).toBe("STALE");
      expect(all[0].staleReason).toBe("source content edited");
      expect(all[1].status).toBe("GENERATED");

      await cleanup(ws);
    });

    it("sequence 4: ACCEPTED -> STALE -> new GENERATED — accepted-then-staled history remains, exactly one live row", async () => {
      const ws = await createWorkspace();
      const source = await createDraftSource(ws);
      const target = await createApprovedTarget(ws);
      const first = await service.create(ws.id, null, baseInput(source, target));
      await service.accept(ws.id, first.publicId, ownerUserId);
      await service.markStale(ws.id, first.publicId, "target archived");

      const second = await service.create(ws.id, null, baseInput(source, target));
      expect(second.id).not.toBe(first.id);

      const all = await ctx.prisma.internalLink.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: "asc" } });
      expect(all).toHaveLength(2);
      expect(all[0].status).toBe("STALE");
      expect(all[0].reviewedById).toBe(ownerUserId); // ACCEPTED review history preserved even after staling
      expect(all[1].status).toBe("GENERATED");

      // At no point did two live rows for the same pair coexist — proven
      // structurally by the partial unique index itself (a violation
      // would have thrown above), and confirmed here on the final state.
      const live = all.filter((r) => r.status === "GENERATED" || r.status === "ACCEPTED");
      expect(live).toHaveLength(1);

      await cleanup(ws);
    });
  });
});
