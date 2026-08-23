import { addActiveMemberWithRole, bootstrapE2eApp, createActiveUserAndLogin, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * CI test-infrastructure fix — regression proof for the
 * loginAsPlatformOwner()/createActiveUserAndLogin() helpers now calling
 * AuthService.login() directly instead of the real, rate-limited
 * `POST /api/v1/auth/login` HTTP endpoint (see test/helpers/e2e-app.ts's
 * own doc comment for the full root-cause/rationale).
 *
 * Dedicated auth/login/rate-limit behavior itself remains fully covered
 * by auth.e2e-spec.ts, which this fix does not touch — it still exercises
 * the real HTTP endpoint (rate limit included) end-to-end. Nothing here
 * duplicates that coverage; this file only proves the NEW helper
 * mechanism produces sessions the real backend cannot distinguish from
 * ones minted through HTTP.
 */
describe("E2E auth fixture — direct-AuthService session helpers (e2e)", () => {
  let ctx: E2eApp;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  it("loginAsPlatformOwner() produces a token real SessionGuard-protected, permission-checked endpoints accept", async () => {
    const owner = await loginAsPlatformOwner(ctx);

    const res = await request(ctx.app.getHttpServer())
      .post("/api/v1/workspaces")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: "Auth fixture proof workspace", slug: `auth-fixture-${Date.now()}` })
      .expect(201);

    expect(res.body.data.publicId).toBeTruthy();
  });

  it("loginAsPlatformOwner() mints a fresh, independently-valid session on every call — not cached/reused across calls", async () => {
    const first = await loginAsPlatformOwner(ctx);
    const second = await loginAsPlatformOwner(ctx);

    // Two distinct sessions for the identical owner — deliberately not
    // memoized (see this helper's own doc comment: a cached session was
    // tried and reverted after it surfaced a real mid-file token-expiry
    // regression). Same user, same email, but each call is a real,
    // independent login.
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.publicId).toBe(first.publicId);

    await request(ctx.app.getHttpServer())
      .post("/api/v1/workspaces")
      .set("Authorization", `Bearer ${first.accessToken}`)
      .send({ name: "First session still valid", slug: `auth-fixture-first-${Date.now()}` })
      .expect(201);

    await request(ctx.app.getHttpServer())
      .post("/api/v1/workspaces")
      .set("Authorization", `Bearer ${second.accessToken}`)
      .send({ name: "Second session still valid", slug: `auth-fixture-second-${Date.now()}` })
      .expect(201);
  });

  it("createActiveUserAndLogin() sessions still flow through real workspace membership and PermissionGuard — Content Writer can view but not create Knowledge Packs", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const { userId, accessToken } = await createActiveUserAndLogin(ctx, "auth-fixture-writer");
    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: ws.publicId } });
    await addActiveMemberWithRole(ctx, workspace.id, userId, "Content Writer");

    // Real membership — WorkspaceContextGuard resolves this session's
    // actual seeded role, not a shortcut.
    const membership = await ctx.prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace.id, userId } });
    expect(membership.status).toBe("ACTIVE");

    // KP_VIEW: Content Writer has it — real PermissionGuard allow path.
    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    // KP_CREATE: Content Writer does not have it — real PermissionGuard deny path.
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Should be forbidden" })
      .expect(403);
  });

  it("logout on a directly-minted session revokes the real underlying UserSession row — session/logout semantics unaltered", async () => {
    const { accessToken, publicId } = await createActiveUserAndLogin(ctx, "auth-fixture-logout");

    await request(ctx.app.getHttpServer()).post("/api/v1/auth/logout").set("Authorization", `Bearer ${accessToken}`).expect(200);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { publicId } });
    const session = await ctx.prisma.userSession.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    expect(session.status).toBe("REVOKED");
  });
});
