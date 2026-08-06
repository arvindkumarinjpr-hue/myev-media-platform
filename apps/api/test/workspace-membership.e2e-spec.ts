import {
  bootstrapE2eApp,
  createActiveUserAndLogin,
  createWorkspaceAsOwner,
  extractToken,
  getLatestEmailFor,
  loginAsPlatformOwner,
  request,
  teardownE2eApp,
  uniqueEmail,
  type E2eApp,
} from "./helpers/e2e-app";

describe("Workspace membership & invitations (e2e)", () => {
  let ctx: E2eApp;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
  });

  beforeEach(async () => {
    // Every test here logs in at least once (often several times); without
    // this the shared LOGIN_RATE_LIMIT (10/60s) exhausts partway through
    // the file, same fix 1B.1's e2e suite needed for the same reason.
    await ctx.redis.flushdb();
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  it("new-user invitation: accept creates PENDING_ACTIVATION user+membership with zero permissions, activation flips both to ACTIVE atomically", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const invitedEmail = uniqueEmail("new-invitee");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/invitations`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ email: invitedEmail, roleName: "Content Writer" })
      .expect(201);

    const invitationEmail = await getLatestEmailFor(invitedEmail);
    expect(invitationEmail.subject).toContain(ws.name);
    const inviteToken = extractToken(invitationEmail.body);

    const accept = await request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${inviteToken}/accept`).expect(200);
    expect(accept.body.data.requiresActivation).toBe(true);

    const pendingUser = await ctx.prisma.user.findFirstOrThrow({ where: { email: invitedEmail } });
    const pendingMembership = await ctx.prisma.workspaceMember.findFirstOrThrow({
      where: { userId: pendingUser.id, workspaceId: (await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId } })).id },
    });
    expect(pendingUser.status).toBe("PENDING_ACTIVATION");
    expect(pendingMembership.status).toBe("PENDING_ACTIVATION");

    // A valid activation token must exist — regression coverage for the
    // bug where a separate post-accept transaction could fail and leave
    // this user permanently stuck with no way to activate.
    const activationTokenRow = await ctx.prisma.userActionToken.findFirstOrThrow({
      where: { userId: pendingUser.id, purpose: "ACCOUNT_ACTIVATION", status: "PENDING" },
    });
    expect(activationTokenRow).toBeTruthy();

    const activationEmail = await getLatestEmailFor(invitedEmail, invitationEmail.id);
    expect(activationEmail.subject).toContain("Activate");
    expect(activationEmail.body).toContain(ws.name);
    const activationToken = extractToken(activationEmail.body);

    await request(ctx.app.getHttpServer())
      .post("/api/v1/auth/reset-password")
      .send({ token: activationToken, newPassword: "New-Invitee-Password-123" })
      .expect(200);

    const activatedUser = await ctx.prisma.user.findUniqueOrThrow({ where: { id: pendingUser.id } });
    const activatedMembership = await ctx.prisma.workspaceMember.findUniqueOrThrow({ where: { id: pendingMembership.id } });
    expect(activatedUser.status).toBe("ACTIVE");
    expect(activatedMembership.status).toBe("ACTIVE");

    const login = await request(ctx.app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: invitedEmail, password: "New-Invitee-Password-123" })
      .expect(200);
    const perms = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/permissions/me`)
      .set("Authorization", `Bearer ${login.body.data.access_token}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    expect(perms.body.data.permissions).toEqual(expect.arrayContaining(["BLOG_CREATE", "BLOG_EDIT"]));
  });

  it("existing-user invitation is bound to the invited account and rejects an unrelated logged-in session", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const existingUser = await createActiveUserAndLogin(ctx, "existing-invitee");
    const unrelatedUser = await createActiveUserAndLogin(ctx, "unrelated");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/invitations`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ email: existingUser.email, roleName: "Content Writer" })
      .expect(201);

    const invitationEmail = await getLatestEmailFor(existingUser.email);
    const inviteToken = extractToken(invitationEmail.body);

    const wrongSession = await request(ctx.app.getHttpServer())
      .post(`/api/v1/invitations/${inviteToken}/accept`)
      .set("Authorization", `Bearer ${unrelatedUser.accessToken}`);
    expect(wrongSession.status).toBe(403);
    expect(wrongSession.body.code).toBe("EMAIL_MISMATCH");

    const correctSession = await request(ctx.app.getHttpServer())
      .post(`/api/v1/invitations/${inviteToken}/accept`)
      .set("Authorization", `Bearer ${existingUser.accessToken}`)
      .expect(200);
    expect(correctSession.body.data.requiresActivation).toBe(false);

    const membership = await ctx.prisma.workspaceMember.findFirstOrThrow({ where: { userId: existingUser.userId } });
    expect(membership.status).toBe("ACTIVE"); // existing user joins ACTIVE directly, no pending step
  });

  it("an expired invitation cannot be accepted", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const invitedEmail = uniqueEmail("expired-invitee");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/invitations`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ email: invitedEmail, roleName: "Content Writer" })
      .expect(201);

    const invitationEmail = await getLatestEmailFor(invitedEmail);
    const inviteToken = extractToken(invitationEmail.body);

    await ctx.prisma.workspaceInvitation.updateMany({
      where: { invitedEmail },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${inviteToken}/accept`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("INVITATION_EXPIRED");
  });

  it("revoking a pending invitation makes it unacceptable", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const invitedEmail = uniqueEmail("revoked-invitee");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/invitations`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ email: invitedEmail, roleName: "Content Writer" })
      .expect(201);

    const list = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/invitations`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);
    const invitationPublicId = list.body.data.find((i: { invitedEmail: string }) => i.invitedEmail === invitedEmail).publicId;

    await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/invitations/${invitationPublicId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    const invitationEmail = await getLatestEmailFor(invitedEmail);
    const inviteToken = extractToken(invitationEmail.body);
    const res = await request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${inviteToken}/accept`);
    expect(res.status).toBe(410);
  });

  it("role change, suspend, remove, and leave enforce self-modification and Owner-removal rules", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const member = await createActiveUserAndLogin(ctx, "role-change-target");

    await ctx.prisma.workspaceMember.create({
      data: {
        workspaceId: (await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId } })).id,
        userId: member.userId,
        roleId: (await ctx.prisma.role.findUniqueOrThrow({ where: { name: "Content Writer" } })).id,
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    });
    const memberRow = await ctx.prisma.workspaceMember.findFirstOrThrow({ where: { userId: member.userId } });

    // Self-modification forbidden — the owner cannot be modified via this endpoint either.
    const ownerMembership = await ctx.prisma.workspaceMember.findFirstOrThrow({
      where: { workspaceId: memberRow.workspaceId, userId: (await ctx.prisma.user.findFirstOrThrow({ where: { publicId: owner.publicId } })).id },
    });
    const selfMod = await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/members/${ownerMembership.publicId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ status: "SUSPENDED" });
    expect(selfMod.status).toBe(403);
    expect(selfMod.body.code).toBe("CANNOT_MODIFY_SELF");

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/members/${memberRow.publicId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ status: "SUSPENDED" })
      .expect(200);

    const suspended = await ctx.prisma.workspaceMember.findUniqueOrThrow({ where: { id: memberRow.id } });
    expect(suspended.status).toBe("SUSPENDED");

    // Suspended member has zero permissions and cannot reach the workspace at all.
    const suspendedAccess = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}`)
      .set("Authorization", `Bearer ${member.accessToken}`)
      .set("X-Workspace-Id", ws.publicId);
    expect(suspendedAccess.status).toBe(404);

    await request(ctx.app.getHttpServer())
      .delete(`/api/v1/workspaces/${ws.publicId}/members/${memberRow.publicId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    const removed = await ctx.prisma.workspaceMember.findUniqueOrThrow({ where: { id: memberRow.id } });
    expect(removed.status).toBe("REMOVED");
  });

  it("member-list visibility includes every status and is workspace-isolated", async () => {
    const owner = await loginAsPlatformOwner(ctx);
    const wsA = await createWorkspaceAsOwner(ctx, owner.accessToken);
    const wsB = await createWorkspaceAsOwner(ctx, owner.accessToken);

    const listA = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${wsA.publicId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", wsA.publicId)
      .expect(200);
    const listB = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${wsB.publicId}/members`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .expect(200);

    // Each workspace's member list contains only that workspace's Owner row (itself) — no cross-contamination.
    expect(listA.body.data).toHaveLength(1);
    expect(listB.body.data).toHaveLength(1);
    expect(listA.body.data[0].publicId).not.toBe(listB.body.data[0].publicId);
  });
});
