import { bootstrapE2eApp, createProjectAsOwner, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 1E Engineering Plan's mandatory regression requirement (final
 * approval round, "Concurrency Tests"): prove — against a real Postgres,
 * not a mock — that series-reassignment-vs-project-change and series-
 * deletion-vs-project-change never deadlock, and that each race resolves
 * to exactly one deterministic outcome. Both properties follow from the
 * plan's mandatory global lock order (series row(s) by id ASCENDING,
 * THEN the item row, never the reverse) being applied identically by
 * ContentItemsService.assignSeries, ContentItemsService.updateProject,
 * and ContentSeriesService.remove.
 */
describe("Content module concurrency (e2e)", () => {
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

  async function createSeries(auth: Record<string, string>, wsPublicId: string, name: string, projectId?: string) {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsPublicId}/content-series`)
      .set(auth)
      .send({ name, projectId })
      .expect(201);
    return res.body.data.publicId as string;
  }

  async function createItem(auth: Record<string, string>, wsPublicId: string, projectId?: string) {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsPublicId}/content-items`)
      .set(auth)
      .send({ contentType: "BLOG", title: "Concurrency fixture", projectId, body: { content: "x" } })
      .expect(201);
    return res.body.data.publicId as string;
  }

  it(
    "series reassignment racing a project change on the same item never deadlocks, and resolves deterministically",
    async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      const projectX = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);
      const projectY = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);

      for (let i = 0; i < 8; i++) {
        const seriesA = await createSeries(auth, ws.publicId, `Race A ${i}`);
        const seriesB = await createSeries(auth, ws.publicId, `Race B ${i}`);
        const item = await createItem(auth, ws.publicId, projectX.publicId);
        await request(ctx.app.getHttpServer())
          .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item}/series`)
          .set(auth)
          .send({ seriesId: seriesA })
          .expect(200);

        const [reassignRes, projectRes] = await Promise.all([
          request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item}/series`).set(auth).send({ seriesId: seriesB }),
          request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item}/project`).set(auth).send({ projectId: projectY.publicId }),
        ]);

        // Series reassignment never depends on the item's project (both
        // series here are workspace-level, so compatibility is never the
        // reason for failure) — it always succeeds.
        expect(reassignRes.status).toBe(200);
        expect(reassignRes.body.data.seriesId).toBe(seriesB);

        // The project change succeeds unless it lost the race against the
        // reassignment's series-row lock and its pre-transaction seriesId
        // snapshot went stale — CONTENT_ITEM_SERIES_STATE_CHANGED is the
        // only valid failure mode, never a hang or an unrelated error.
        expect([200, 409]).toContain(projectRes.status);

        const finalRow = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: item } });
        const seriesBRow = await ctx.prisma.contentSeries.findFirstOrThrow({ where: { publicId: seriesB } });
        expect(finalRow.seriesId).toBe(seriesBRow.id);

        if (projectRes.status === 200) {
          const projectYRow = await ctx.prisma.project.findFirstOrThrow({ where: { publicId: projectY.publicId } });
          expect(finalRow.projectId).toBe(projectYRow.id);
        } else {
          expect(projectRes.body.code).toBe("CONTENT_ITEM_SERIES_STATE_CHANGED");
          const projectXRow = await ctx.prisma.project.findFirstOrThrow({ where: { publicId: projectX.publicId } });
          expect(finalRow.projectId).toBe(projectXRow.id);
        }
      }
    },
    30000,
  );

  it(
    "series deletion racing a project change never deadlocks — deletion always loses since the project change never clears the reference",
    async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const auth = { Authorization: `Bearer ${owner.accessToken}`, "X-Workspace-Id": ws.publicId };
      const projectX = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);
      const projectY = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);

      for (let i = 0; i < 8; i++) {
        // Workspace-level series (no projectId) — compatible with any
        // project, isolating the lock-order property from the separate
        // project-compatibility rule.
        const series = await createSeries(auth, ws.publicId, `Delete race ${i}`);
        const item = await createItem(auth, ws.publicId, projectX.publicId);
        await request(ctx.app.getHttpServer())
          .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item}/series`)
          .set(auth)
          .send({ seriesId: series })
          .expect(200);

        const [deleteRes, projectRes] = await Promise.all([
          request(ctx.app.getHttpServer()).delete(`/api/v1/workspaces/${ws.publicId}/content-series/${series}`).set(auth),
          request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/content-items/${item}/project`).set(auth).send({ projectId: projectY.publicId }),
        ]);

        // The project change never touches seriesId, so the item keeps
        // referencing this series through the whole race — deletion must
        // be rejected regardless of interleaving, never silently orphan
        // the reference and never hang.
        expect(deleteRes.status).toBe(409);
        expect(deleteRes.body.code).toBe("CONTENT_SERIES_NOT_EMPTY");
        // The project change itself is unaffected by the deletion attempt
        // (workspace-level series is compatible with any project, and the
        // series-before-item lock order means the project change only
        // ever blocks briefly behind the deletion attempt, never fails
        // because of it).
        expect(projectRes.status).toBe(200);

        const seriesRow = await ctx.prisma.contentSeries.findFirstOrThrow({ where: { publicId: series } });
        expect(seriesRow.deletedAt).toBeNull();
      }
    },
    30000,
  );
});
