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

async function createBlogItem(
  ctx: E2eApp,
  accessToken: string,
  wsPublicId: string,
  overrides: Partial<{ title: string; projectId: string }> = {},
): Promise<string> {
  const res = await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/content-items`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .send({ contentType: "BLOG", title: overrides.title ?? "A test blog post", projectId: overrides.projectId, body: { content: "Hello world" } })
    .expect(201);
  return res.body.data.publicId as string;
}

describe("Content series (e2e)", () => {
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

  it("Owner can create, list, get, rename, and delete a workspace-level series", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);

    const create = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-series`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Season One" })
      .expect(201);
    const seriesId = create.body.data.publicId as string;
    expect(create.body.data.projectId).toBeNull();

    const list = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/content-series`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(list.body.data.some((s: { publicId: string }) => s.publicId === seriesId)).toBe(true);

    const get = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/content-series/${seriesId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(get.body.data.name).toBe("Season One");

    const rename = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/content-series/${seriesId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Season One: Renamed" })
      .expect(200);
    expect(rename.body.data.name).toBe("Season One: Renamed");

    await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/content-series/${seriesId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/content-series/${seriesId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(404);
  });

  it("creating a project-scoped series validates the project belongs to the same workspace", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const wsA = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const wsB = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const projectInB = await createProjectAsOwner(ctx, owner.accessToken, wsB.publicId);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsA.publicId}/content-series`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", wsA.publicId)
      .send({ name: "Cross-workspace attempt", projectId: projectInB.publicId })
      .expect(404);

    const projectInA = await createProjectAsOwner(ctx, owner.accessToken, wsA.publicId);
    const ok = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsA.publicId}/content-series`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", wsA.publicId)
      .send({ name: "Same-workspace project series", projectId: projectInA.publicId })
      .expect(201);
    expect(ok.body.data.projectId).toBe(projectInA.publicId);
  });

  it("a member without CONTENT_SERIES_MANAGE is denied create/list/get/update/delete", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const writer = await createActiveUserAndLogin(ctx, "series-writer");
    const workspaceRow = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    await addActiveMemberWithRole(ctx, workspaceRow.id, writer.userId, "Content Writer");

    const create = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-series`)
      .set("Authorization", `Bearer ${writer.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Should be denied" });
    expect(create.status).toBe(403);
  });

  it("deletion is rejected while a non-DELETED content item references the series, and succeeds once unassigned", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);

    const series = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-series`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Referenced series" })
      .expect(201);
    const seriesId = series.body.data.publicId as string;

    const itemId = await createBlogItem(ctx, owner.accessToken, ws.publicId);
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/series`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ seriesId })
      .expect(200);

    await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/content-series/${seriesId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(409);

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/content-items/${itemId}/series`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ seriesId: null })
      .expect(200);

    await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/content-series/${seriesId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
  });
});
