import {
  bootstrapE2eApp,
  createActiveUserAndLogin,
  createWorkspaceAsOwner,
  loginAsPlatformOwner,
  request,
  teardownE2eApp,
  uniqueSlug,
  type E2eApp,
} from "./helpers/e2e-app";

/**
 * Module 1C Engineering Plan — workspace lifecycle, settings/platform
 * defaults, and slug reservation. Runs against real Postgres/Redis inside
 * the Docker network, same discipline as Module 1B.1's e2e suite.
 */
describe("Workspace lifecycle & slug reservation (e2e)", () => {
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

  describe("Platform Owner authority", () => {
    it("denies workspace creation to an ordinary authenticated user", async () => {
      const user = await createActiveUserAndLogin(ctx, "ordinary");
      const res = await request(ctx.app.getHttpServer())
        .post("/api/v1/workspaces")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ name: "Rogue", slug: uniqueSlug("rogue") })
        .expect(403);
      expect(res.body.code).toBe("NOT_PLATFORM_OWNER");
    });

    it("allows the sole Platform Owner to create a workspace, becoming its Owner member", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      expect(ws.publicId).toEqual(expect.any(String));

      const view = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      expect(view.body.data.myRole).toBe("Owner");
    });
  });

  describe("Workspace settings & platform defaults", () => {
    it("applies platform-configurable defaults when no overrides are given, and accepts valid overrides", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);

      const view = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      expect(view.body.data.settings).toEqual({ timezone: "UTC", locale: "en-US", currency: "USD", dateFormat: "YYYY-MM-DD" });
      expect(view.body.data.featureFlags).toEqual({});

      const updated = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ timezone: "Asia/Kolkata", currency: "INR" })
        .expect(200);
      expect(updated.body.data.slug).toBe(ws.slug);

      const reView = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      expect(reView.body.data.settings.timezone).toBe("Asia/Kolkata");
      expect(reView.body.data.settings.currency).toBe("INR");
      expect(reView.body.data.settings.locale).toBe("en-US"); // untouched fields survive the partial update
    });

    it("rejects an invalid timezone override and never writes feature_flags through this endpoint", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);

      const res = await request(ctx.app.getHttpServer())
        .post("/api/v1/workspaces")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ name: "Bad TZ", slug: uniqueSlug("badtz"), timezone: "Not/A/Real/Zone" })
        .expect(400);
      expect(res.body.code).toBe("INVALID_TIMEZONE");

      const patched = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ name: "Renamed", featureFlags: { sneaky: true } })
        .expect(200);
      expect(patched.body.data).not.toHaveProperty("featureFlags");
      const view = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      expect(view.body.data.featureFlags).toEqual({}); // whitelist:true silently dropped the unknown field — never reached the service
    });
  });

  describe("Archive / restore / delete lifecycle", () => {
    it("archive blocks further access except view/restore/delete, and delete requires prior archive", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);

      const deleteBeforeArchive = await request(ctx.app.getHttpServer())
        .delete(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId);
      expect(deleteBeforeArchive.status).toBe(409);
      expect(deleteBeforeArchive.body.code).toBe("WORKSPACE_NOT_ARCHIVED");

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/archive`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);

      const blockedUpdate = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ name: "Should not apply" });
      expect(blockedUpdate.status).toBe(403);
      expect(blockedUpdate.body.code).toBe("WORKSPACE_ARCHIVED");

      // View still works while archived.
      await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/restore`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/archive`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);

      await request(ctx.app.getHttpServer())
        .delete(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);

      // Deleted workspace is enumeration-safe 404, not 403.
      const afterDelete = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId);
      expect(afterDelete.status).toBe(404);
    });
  });

  describe("Slug reservation (Module 1C Engineering Plan §1)", () => {
    it("old slug remains unavailable after rename", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const originalSlug = uniqueSlug("rename-from");
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken, { slug: originalSlug });

      const newSlug = uniqueSlug("rename-to");
      await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ slug: newSlug })
        .expect(200);

      const collision = await request(ctx.app.getHttpServer())
        .post("/api/v1/workspaces")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ name: "Squatter", slug: originalSlug });
      expect(collision.status).toBe(409);
      expect(collision.body.code).toBe("SLUG_ALREADY_RESERVED");
    });

    it("deleted resource's slug remains unavailable", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const slug = uniqueSlug("delete-me");
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken, { slug });

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/archive`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      await request(ctx.app.getHttpServer())
        .delete(`/api/v1/workspaces/${ws.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);

      const reuse = await request(ctx.app.getHttpServer())
        .post("/api/v1/workspaces")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ name: "Reviver", slug });
      expect(reuse.status).toBe(409);
      expect(reuse.body.code).toBe("SLUG_ALREADY_RESERVED");
    });

    it(
      "concurrent slug claims: exactly one winner",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const contestedSlug = uniqueSlug("contested");

        const attempts = await Promise.all(
          Array.from({ length: 5 }, () =>
            request(ctx.app.getHttpServer())
              .post("/api/v1/workspaces")
              .set("Authorization", `Bearer ${owner.accessToken}`)
              .send({ name: "Contender", slug: contestedSlug }),
          ),
        );

        const succeeded = attempts.filter((r) => r.status === 201);
        const conflicted = attempts.filter((r) => r.status === 409);
        expect(succeeded).toHaveLength(1);
        expect(conflicted).toHaveLength(4);
        for (const r of conflicted) expect(r.body.code).toBe("SLUG_ALREADY_RESERVED");
      },
      15_000,
    );
  });

  describe("Projects foundation", () => {
    it("creates, views, updates, archives, and restores a project; cross-workspace access is 404", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const wsA = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const wsB = await createWorkspaceAsOwner(ctx, owner.accessToken);

      const created = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${wsA.publicId}/projects`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", wsA.publicId)
        .send({ name: "Launch Campaign", slug: "launch" })
        .expect(201);

      // Same slug in a DIFFERENT workspace is allowed.
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${wsB.publicId}/projects`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", wsB.publicId)
        .send({ name: "Launch Campaign B", slug: "launch" })
        .expect(201);

      // Cross-workspace read is 404, not 403.
      const crossRead = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${wsB.publicId}/projects/${created.body.data.publicId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", wsB.publicId);
      expect(crossRead.status).toBe(404);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${wsA.publicId}/projects/${created.body.data.publicId}/archive`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", wsA.publicId)
        .expect(200);
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${wsA.publicId}/projects/${created.body.data.publicId}/restore`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", wsA.publicId)
        .expect(200);

      // Same slug rejected within the SAME workspace, even after archive/rename attempts on the original.
      const sameWorkspaceCollision = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${wsA.publicId}/projects`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", wsA.publicId)
        .send({ name: "Duplicate", slug: "launch" });
      expect(sameWorkspaceCollision.status).toBe(409);
    });
  });
});
