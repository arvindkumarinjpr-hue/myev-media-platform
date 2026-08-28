import {
  addActiveMemberWithRole,
  bootstrapE2eApp,
  createActiveUserAndLogin,
  createProjectAsOwner,
  createWorkspaceAsOwner,
  loginAsPlatformOwner,
  PNG_BYTES,
  request,
  teardownE2eApp,
  uploadBytesToPresignedInstruction,
  type E2eApp,
} from "./helpers/e2e-app";

async function addMember(ctx: E2eApp, wsPublicId: string, label: string, roleName: string) {
  const user = await createActiveUserAndLogin(ctx, label);
  const workspaceRow = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: wsPublicId } });
  await addActiveMemberWithRole(ctx, workspaceRow.id, user.userId, roleName);
  return user;
}

async function createBlogItem(
  ctx: E2eApp,
  accessToken: string,
  wsPublicId: string,
  overrides: Partial<{ title: string; projectId: string; body: Record<string, unknown> }> = {},
) {
  const res = await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/content-items`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .send({
      contentType: "BLOG",
      title: overrides.title ?? "A test blog post",
      projectId: overrides.projectId,
      body: overrides.body ?? { content: "Hello world" },
    })
    .expect(201);
  return res.body.data as { publicId: string; status: string };
}

// Module 6 Phase 6.3 sealed the generic submit-for-review route against
// BLOG items (they must go through the Blog pipeline). The generic
// editorial-lifecycle tests below exercise the shared machinery with a
// VIDEO item instead — a non-BLOG type with the identical
// DRAFT→IN_PROGRESS→REVIEW→APPROVED service behaviour.
async function createVideoItem(ctx: E2eApp, accessToken: string, wsPublicId: string, overrides: Partial<{ title: string }> = {}) {
  const res = await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/content-items`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .send({ contentType: "VIDEO", title: overrides.title ?? "A test video", body: { script: "A short script about home EV charging." } })
    .expect(201);
  return res.body.data as { publicId: string; status: string };
}

async function uploadActiveAsset(ctx: E2eApp, accessToken: string, wsPublicId: string) {
  const intentRes = await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/assets/upload-intent`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .send({ assetType: "IMAGE", originalFilename: "hero.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
    .expect(201);
  const { assetPublicId, instruction } = intentRes.body.data;
  const uploadRes = await uploadBytesToPresignedInstruction(instruction, PNG_BYTES, "image/png", "hero.png");
  expect(uploadRes.ok || uploadRes.status === 204).toBe(true);
  await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/assets/${assetPublicId}/confirm`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .expect(200);
  return assetPublicId as string;
}

// Deliberately never confirmed — stays PENDING_UPLOAD, for exercising
// setFeaturedMedia's MEDIA_ASSET_NOT_ACTIVE rejection.
async function createPendingUploadAsset(ctx: E2eApp, accessToken: string, wsPublicId: string) {
  const intentRes = await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/assets/upload-intent`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .send({ assetType: "IMAGE", originalFilename: "pending.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
    .expect(201);
  return intentRes.body.data.assetPublicId as string;
}

describe("Content items (e2e)", () => {
  let ctx: E2eApp;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
  });

  beforeEach(async () => {
    await ctx.redis.flushdb();
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  describe("Update (title/metadata)", () => {
    it("updates title and metadata, and rejects an update for a role without edit access", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };

      const updated = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}`)
        .set(auth)
        .send({ title: "Updated title", metadata: { seoScore: 88 } })
        .expect(200);
      expect(updated.body.data.title).toBe("Updated title");
      expect(updated.body.data.metadata).toEqual({ seoScore: 88 });

      const videoEditor = await addMember(ctx, ws.publicId, "video-editor-update", "Video Editor");
      const denied = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}`)
        .set("Authorization", `Bearer ${videoEditor.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ title: "Should be denied" });
      expect(denied.status).toBe(404);
    });
  });

  describe("Creation", () => {
    it("creates a BLOG item in DRAFT with a linked version 1", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      expect(item.status).toBe("DRAFT");

      const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId: item.publicId } });
      expect(row.currentVersionId).not.toBeNull();
      const version = await ctx.prisma.contentVersion.findUniqueOrThrow({ where: { id: row.currentVersionId! } });
      expect(version.versionNumber).toBe(1);
      expect((version.body as Record<string, unknown>).content).toBe("Hello world");
    });

    it("rejects an unsupported content type with 400 before authorization or body validation", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ contentType: "NEWSLETTER", title: "Not supported yet", body: { content: "x" } });
      expect(res.status).toBe(400);
    });

    it("rejects a body missing the required per-type field", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ contentType: "BLOG", title: "Missing content field", body: { wrongField: "x" } });
      expect(res.status).toBe(400);
    });

    it("denies creation for a role without BLOG_CREATE", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const analyst = await addMember(ctx, ws.publicId, "analyst-create", "Analyst");
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
        .set("Authorization", `Bearer ${analyst.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ contentType: "BLOG", title: "Should be denied", body: { content: "x" } });
      expect(res.status).toBe(403);
    });
  });

  describe("Type-aware, enumeration-safe authorization", () => {
    it("a caller without view access to an item's type gets 404, never 403", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const videoEditor = await addMember(ctx, ws.publicId, "video-editor-view", "Video Editor");

      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}`)
        .set("Authorization", `Bearer ${videoEditor.accessToken}`)
        .set("X-Workspace-Id", ws.publicId);
      expect(res.status).toBe(404);
    });

    it("a genuinely nonexistent item also returns 404 — indistinguishable from the wrong-type case", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}/content-items/00000000-0000-0000-0000-000000000000`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId);
      expect(res.status).toBe(404);
    });

    it("list returns 403 only when the caller can view no content type at all", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const analyst = await addMember(ctx, ws.publicId, "analyst-list", "Analyst");
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}/content-items`)
        .set("Authorization", `Bearer ${analyst.accessToken}`)
        .set("X-Workspace-Id", ws.publicId);
      expect(res.status).toBe(403);
    });

    it("a caller with only VIDEO_VIEW never sees BLOG items in an unfiltered list", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const videoEditor = await addMember(ctx, ws.publicId, "video-editor-list", "Video Editor");

      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}/content-items`)
        .set("Authorization", `Bearer ${videoEditor.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });

    it("an explicitly out-of-scope type filter yields an empty result, never an error", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const videoEditor = await addMember(ctx, ws.publicId, "video-editor-filter", "Video Editor");

      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}/content-items`)
        .query({ contentType: "BLOG" })
        .set("Authorization", `Bearer ${videoEditor.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe("Editorial lifecycle and review events", () => {
    it("walks DRAFT -> IN_PROGRESS -> REVIEW -> APPROVED, writing a review event at each review step", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createVideoItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/start`).set(auth).expect(200);
      const submit = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/submit-for-review`)
        .set(auth)
        .send({ comment: "Ready for review" })
        .expect(200);
      expect(submit.body.data.status).toBe("REVIEW");

      const approve = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/approve`)
        .set(auth)
        .send({})
        .expect(200);
      expect(approve.body.data.status).toBe("APPROVED");

      const itemRow = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId: item.publicId } });
      const events = await ctx.prisma.contentReviewEvent.findMany({ where: { contentItemId: itemRow.id }, orderBy: { createdAt: "asc" } });
      expect(events.map((e) => e.action)).toEqual(["SUBMITTED", "APPROVED"]);
      expect(events[0].comment).toBe("Ready for review");
    });

    it("reject requires a non-empty comment and returns the item to IN_PROGRESS", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createVideoItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/start`).set(auth).expect(200);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/submit-for-review`).set(auth).send({}).expect(200);

      const blank = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/reject`)
        .set(auth)
        .send({ comment: "   " });
      expect(blank.status).toBe(400);

      const reject = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/reject`)
        .set(auth)
        .send({ comment: "Needs more detail in the intro." })
        .expect(200);
      expect(reject.body.data.status).toBe("IN_PROGRESS");
    });

    it("a role with VIDEO_EDIT but not VIDEO_APPROVE cannot approve — enumeration-safe 404, not 403", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createVideoItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/start`).set(auth).expect(200);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/submit-for-review`).set(auth).send({}).expect(200);

      const editor = await addMember(ctx, ws.publicId, "video-editor-approve", "Video Editor");
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/approve`)
        .set("Authorization", `Bearer ${editor.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({});
      expect(res.status).toBe(404);
    });

    it("archive stores the exact prior status and restore returns to it, not always DRAFT", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/start`).set(auth).expect(200);

      const archive = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/archive`)
        .set(auth)
        .expect(200);
      expect(archive.body.data.status).toBe("ARCHIVED");
      expect(archive.body.data.archivedFromStatus).toBe("IN_PROGRESS");

      const restore = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/restore`)
        .set(auth)
        .expect(200);
      expect(restore.body.data.status).toBe("IN_PROGRESS");
      expect(restore.body.data.archivedFromStatus).toBeNull();
    });

    it("soft delete makes the item subsequently invisible (404)", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      await request(ctx.app.getHttpServer()).delete(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}`).set(auth).expect(200);
      await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}`).set(auth).expect(404);
    });

    // Module 6 Phase 6.3 review-gate seal.
    it("a BLOG item cannot enter REVIEW through the generic content-items route — it is directed to the Blog pipeline", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/start`).set(auth).expect(200);

      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/submit-for-review`)
        .set(auth)
        .send({})
        .expect(409);
      expect(res.body.code).toBe("CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE");

      const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId: item.publicId } });
      expect(row.status).toBe("IN_PROGRESS");
    });

    it("a BLOG item that is not in REVIEW cannot be forced to APPROVED through the generic approve route", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/start`).set(auth).expect(200);

      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/approve`)
        .set(auth)
        .send({})
        .expect(409);
      expect(res.body.code).toBe("CONTENT_ITEM_INVALID_TRANSITION");
      const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId: item.publicId } });
      expect(row.status).toBe("IN_PROGRESS");
    });
  });

  describe("Immutable versioning", () => {
    it("a new version can be added while DRAFT/IN_PROGRESS but not once in REVIEW", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const item = await createVideoItem(ctx, owner.accessToken, ws.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };

      const v2 = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/versions`)
        .set(auth)
        .send({ body: { script: "Revised script" } })
        .expect(201);
      const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId: v2.body.data.publicId } });
      const version = await ctx.prisma.contentVersion.findUniqueOrThrow({ where: { id: row.currentVersionId! } });
      expect(version.versionNumber).toBe(2);

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/start`).set(auth).expect(200);
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/submit-for-review`).set(auth).send({}).expect(200);

      const blocked = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/versions`)
        .set(auth)
        .send({ body: { script: "Should be blocked" } });
      expect(blocked.status).toBe(409);
    });
  });

  describe("Project reassignment", () => {
    it("reassigns to a project in the same workspace, and rejects a cross-workspace project", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const wsA = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const wsB = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const projectInA = await createProjectAsOwner(ctx, owner.accessToken, wsA.publicId);
      const projectInB = await createProjectAsOwner(ctx, owner.accessToken, wsB.publicId);
      const item = await createBlogItem(ctx, owner.accessToken, wsA.publicId);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": wsA.publicId };

      const ok = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${wsA.publicId}/content-items/${item.publicId}/project`)
        .set(auth)
        .send({ projectId: projectInA.publicId })
        .expect(200);
      expect(ok.body.data.projectId).toBe(projectInA.publicId);

      const cross = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${wsA.publicId}/content-items/${item.publicId}/project`)
        .set(auth)
        .send({ projectId: projectInB.publicId });
      expect(cross.status).toBe(404);

      const unassign = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${wsA.publicId}/content-items/${item.publicId}/project`)
        .set(auth)
        .send({ projectId: null })
        .expect(200);
      expect(unassign.body.data.projectId).toBeNull();
    });
  });

  describe("Series assignment and project compatibility", () => {
    it("assigns, reassigns, and unassigns a workspace-level series freely", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const seriesA = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-series`)
        .set(auth)
        .send({ name: "Series A" })
        .expect(201);
      const seriesB = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-series`)
        .set(auth)
        .send({ name: "Series B" })
        .expect(201);

      const assign = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/series`)
        .set(auth)
        .send({ seriesId: seriesA.body.data.publicId })
        .expect(200);
      expect(assign.body.data.seriesId).toBe(seriesA.body.data.publicId);

      const reassign = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/series`)
        .set(auth)
        .send({ seriesId: seriesB.body.data.publicId })
        .expect(200);
      expect(reassign.body.data.seriesId).toBe(seriesB.body.data.publicId);

      const unassign = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/series`)
        .set(auth)
        .send({ seriesId: null })
        .expect(200);
      expect(unassign.body.data.seriesId).toBeNull();
    });

    it("a project-specific series rejects an item whose project doesn't match, including a null-project item", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      const projectX = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);
      const projectY = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);
      const seriesForX = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-series`)
        .set(auth)
        .send({ name: "X-only series", projectId: projectX.publicId })
        .expect(201);

      const itemInY = await createBlogItem(ctx, owner.accessToken, ws.publicId, { projectId: projectY.publicId });
      const mismatch = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemInY.publicId}/series`)
        .set(auth)
        .send({ seriesId: seriesForX.body.data.publicId });
      expect(mismatch.status).toBe(409);

      const itemNoProject = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const nullMismatch = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemNoProject.publicId}/series`)
        .set(auth)
        .send({ seriesId: seriesForX.body.data.publicId });
      expect(nullMismatch.status).toBe(409);

      const itemInX = await createBlogItem(ctx, owner.accessToken, ws.publicId, { projectId: projectX.publicId });
      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemInX.publicId}/series`)
        .set(auth)
        .send({ seriesId: seriesForX.body.data.publicId })
        .expect(200);
    });

    it("changing an item's project to one incompatible with its current series is rejected", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      const projectX = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);
      const projectY = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);
      const seriesForX = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-series`)
        .set(auth)
        .send({ name: "X-only series", projectId: projectX.publicId })
        .expect(201);
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId, { projectId: projectX.publicId });
      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/series`)
        .set(auth)
        .send({ seriesId: seriesForX.body.data.publicId })
        .expect(200);

      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/project`)
        .set(auth)
        .send({ projectId: projectY.publicId });
      expect(res.status).toBe(409);
    });
  });

  describe("Featured media", () => {
    it("attaches an unassigned ACTIVE asset as featured media, and rejects one already attached elsewhere", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      const itemA = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const itemB = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const assetId = await uploadActiveAsset(ctx, owner.accessToken, ws.publicId);

      const set = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemA.publicId}/featured-media`)
        .set(auth)
        .send({ mediaAssetId: assetId })
        .expect(200);
      expect(set.body.data.featuredMediaAssetId).toBe(assetId);

      const conflict = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemB.publicId}/featured-media`)
        .set(auth)
        .send({ mediaAssetId: assetId });
      expect(conflict.status).toBe(409);

      // Re-featuring on the SAME item it already belongs to is allowed.
      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemA.publicId}/featured-media`)
        .set(auth)
        .send({ mediaAssetId: assetId })
        .expect(200);

      const clear = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemA.publicId}/featured-media`)
        .set(auth)
        .send({ mediaAssetId: null })
        .expect(200);
      expect(clear.body.data.featuredMediaAssetId).toBeNull();
    });

    it("rejects a non-ACTIVE asset as featured media", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      const item = await createBlogItem(ctx, owner.accessToken, ws.publicId);
      const pendingAssetId = await createPendingUploadAsset(ctx, owner.accessToken, ws.publicId);

      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/featured-media`)
        .set(auth)
        .send({ mediaAssetId: pendingAssetId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("MEDIA_ASSET_NOT_ACTIVE");
    });
  });
});
