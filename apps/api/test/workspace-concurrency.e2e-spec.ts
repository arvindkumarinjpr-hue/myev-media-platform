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

async function inviteAndActivate(
  ctx: E2eApp,
  ownerAccessToken: string,
  wsPublicId: string,
  roleName: string,
): Promise<{ userId: string; publicId: string; email: string; accessToken: string }> {
  const email = uniqueEmail("concurrency-member");
  await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/invitations`)
    .set("Authorization", `Bearer ${ownerAccessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .send({ email, roleName })
    .expect(201);
  const inviteEmail = await getLatestEmailFor(email);
  await request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${extractToken(inviteEmail.body)}/accept`).expect(200);
  const activationEmail = await getLatestEmailFor(email, inviteEmail.id);
  const password = "Concurrency-Member-Password-123";
  await request(ctx.app.getHttpServer())
    .post("/api/v1/auth/reset-password")
    .send({ token: extractToken(activationEmail.body), newPassword: password })
    .expect(200);
  const login = await request(ctx.app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
  const user = await ctx.prisma.user.findFirstOrThrow({ where: { email } });
  return { userId: user.id, publicId: user.publicId, email, accessToken: login.body.data.access_token as string };
}

describe("Workspace concurrency (e2e)", () => {
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

  describe("Ownership transfer locking (mandatory safeguard 4)", () => {
    it(
      "concurrent transfer attempts cannot produce two ACTIVE Owner memberships; owner_id stays consistent",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const adminA = await inviteAndActivate(ctx, owner.accessToken, ws.publicId, "Administrator");
        const adminB = await inviteAndActivate(ctx, owner.accessToken, ws.publicId, "Administrator");

        const [resA, resB] = await Promise.all([
          request(ctx.app.getHttpServer())
            .post(`/api/v1/workspaces/${ws.publicId}/transfer-ownership`)
            .set("Authorization", `Bearer ${owner.accessToken}`)
            .set("X-Workspace-Id", ws.publicId)
            .send({ newOwnerUserPublicId: adminA.publicId }),
          request(ctx.app.getHttpServer())
            .post(`/api/v1/workspaces/${ws.publicId}/transfer-ownership`)
            .set("Authorization", `Bearer ${owner.accessToken}`)
            .set("X-Workspace-Id", ws.publicId)
            .send({ newOwnerUserPublicId: adminB.publicId }),
        ]);

        // Exactly one of the two concurrent transfer attempts can have
        // succeeded — both used the SAME (now-stale-after-the-first)
        // "current owner" precondition, so the second necessarily loses.
        const statuses = [resA.status, resB.status].sort();
        expect(statuses[0]).toBe(200);
        expect([403, 400]).toContain(statuses[1]);

        const wsRow = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId } });
        const activeOwners = await ctx.prisma.workspaceMember.findMany({
          where: { workspaceId: wsRow.id, status: "ACTIVE", role: { name: "Owner" } },
        });
        expect(activeOwners).toHaveLength(1);
        expect(activeOwners[0].userId).toBe(wsRow.ownerId);
      },
      20_000,
    );

    it("rejects transferring ownership to a non-Administrator member", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const writer = await inviteAndActivate(ctx, owner.accessToken, ws.publicId, "Content Writer");

      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/transfer-ownership`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ newOwnerUserPublicId: writer.publicId });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("TARGET_NOT_ADMIN");
    });
  });

  describe("Activation resend cross-workspace behavior (Module 1C Engineering Plan §3)", () => {
    it(
      "a user pending in two workspaces: resend from one workspace rotates the single user-level token and activates both memberships",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const wsA = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const wsB = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const sharedEmail = uniqueEmail("dual-pending");

        let lastMessageId: string | undefined;
        for (const ws of [wsA, wsB]) {
          await request(ctx.app.getHttpServer())
            .post(`/api/v1/workspaces/${ws.publicId}/invitations`)
            .set("Authorization", `Bearer ${owner.accessToken}`)
            .set("X-Workspace-Id", ws.publicId)
            .send({ email: sharedEmail, roleName: "Content Writer" })
            .expect(201);
          const invitationEmail = await getLatestEmailFor(sharedEmail, lastMessageId);
          lastMessageId = invitationEmail.id;
          await request(ctx.app.getHttpServer())
            .post(`/api/v1/invitations/${extractToken(invitationEmail.body)}/accept`)
            .expect(200);
        }

        const user = await ctx.prisma.user.findFirstOrThrow({ where: { email: sharedEmail } });
        const originalToken = await ctx.prisma.userActionToken.findFirstOrThrow({
          where: { userId: user.id, purpose: "ACCOUNT_ACTIVATION", status: "PENDING" },
        });

        // Resend, initiated from Workspace A only.
        const membersA = await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${wsA.publicId}/members`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", wsA.publicId)
          .expect(200);
        const memberInA = membersA.body.data.find((m: { userId: string }) => m.userId === user.id);

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${wsA.publicId}/members/${memberInA.publicId}/resend-activation`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", wsA.publicId)
          .expect(200);

        // The original token is now invalidated.
        const originalAfter = await ctx.prisma.userActionToken.findUniqueOrThrow({ where: { id: originalToken.id } });
        expect(originalAfter.status).toBe("INVALIDATED");

        const newToken = await ctx.prisma.userActionToken.findFirstOrThrow({
          where: { userId: user.id, purpose: "ACCOUNT_ACTIVATION", status: "PENDING" },
        });
        expect(newToken.id).not.toBe(originalToken.id);

        // The resend email names Workspace A but never mentions Workspace B.
        const resendEmail = await getLatestEmailFor(sharedEmail, lastMessageId);
        expect(resendEmail.body).toContain(wsA.name);
        expect(resendEmail.body).not.toContain(wsB.name);

        // Consuming the new token activates BOTH pending memberships atomically.
        await request(ctx.app.getHttpServer())
          .post("/api/v1/auth/reset-password")
          .send({ token: extractToken(resendEmail.body), newPassword: "Dual-Pending-Password-123" })
          .expect(200);

        const wsARow = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: wsA.publicId } });
        const wsBRow = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: wsB.publicId } });
        const membershipA = await ctx.prisma.workspaceMember.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: wsARow.id, userId: user.id } },
        });
        const membershipB = await ctx.prisma.workspaceMember.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: wsBRow.id, userId: user.id } },
        });
        expect(membershipA.status).toBe("ACTIVE");
        expect(membershipB.status).toBe("ACTIVE");

        // Audit: one global token-rotation event, one workspace-scoped resend event, scoped only to A.
        const globalEvent = await ctx.prisma.auditLog.findFirst({
          where: { action: "ACCOUNT_ACTIVATION_TOKEN_ROTATED", actorUserId: user.id, workspaceId: null },
          orderBy: { createdAt: "desc" },
        });
        expect(globalEvent).toBeTruthy();
        const workspaceScopedEvent = await ctx.prisma.auditLog.findFirst({
          where: { action: "WORKSPACE_MEMBER_ACTIVATION_RESENT", workspaceId: wsARow.id },
        });
        expect(workspaceScopedEvent).toBeTruthy();
        const wrongWorkspaceEvent = await ctx.prisma.auditLog.findFirst({
          where: { action: "WORKSPACE_MEMBER_ACTIVATION_RESENT", workspaceId: wsBRow.id },
        });
        expect(wrongWorkspaceEvent).toBeNull();

        // Mandatory safeguard 1: no audit row anywhere ever contains the
        // raw token, its hash, or any password-derived value — metadata
        // only. The authoritative hash lives solely in user_action_tokens.
        const allEventsForUser = await ctx.prisma.auditLog.findMany({ where: { actorUserId: user.id } });
        const serialized = JSON.stringify(allEventsForUser);
        for (const row of await ctx.prisma.userActionToken.findMany({ where: { userId: user.id } })) {
          expect(serialized).not.toContain(row.tokenHash);
        }
        expect(serialized).not.toContain("Dual-Pending-Password-123");
        const rotatedEvent = allEventsForUser.find((e) => e.action === "ACCOUNT_ACTIVATION_TOKEN_ROTATED");
        expect(rotatedEvent?.afterState).toMatchObject({ newTokenIssued: true, invalidatedTokenCount: expect.any(Number) });
        expect(Object.keys(rotatedEvent?.afterState as object)).not.toEqual(
          expect.arrayContaining(["tokenHash", "token", "hash", "fingerprint"]),
        );
      },
      20_000,
    );

    it(
      "concurrent resend requests produce exactly one valid final token",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const email = uniqueEmail("concurrent-resend");

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/invitations`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ email, roleName: "Content Writer" })
          .expect(201);
        const inviteEmail = await getLatestEmailFor(email);
        await request(ctx.app.getHttpServer())
          .post(`/api/v1/invitations/${extractToken(inviteEmail.body)}/accept`)
          .expect(200);

        const user = await ctx.prisma.user.findFirstOrThrow({ where: { email } });
        const membersList = await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${ws.publicId}/members`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        const memberPublicId = membersList.body.data.find((m: { userId: string }) => m.userId === user.id).publicId;

        await Promise.all(
          Array.from({ length: 3 }, () =>
            request(ctx.app.getHttpServer())
              .post(`/api/v1/workspaces/${ws.publicId}/members/${memberPublicId}/resend-activation`)
              .set("Authorization", `Bearer ${owner.accessToken}`)
              .set("X-Workspace-Id", ws.publicId),
          ),
        );

        const pendingTokens = await ctx.prisma.userActionToken.findMany({
          where: { userId: user.id, purpose: "ACCOUNT_ACTIVATION", status: "PENDING" },
        });
        expect(pendingTokens).toHaveLength(1);
      },
      20_000,
    );
  });

  describe("Concurrent invitation acceptance (Module 1C.1 defect patch)", () => {
    // Module 1C.1: two concurrent accept() calls on the same token used to
    // produce one clean 200 and one UNHANDLED 500 (a raw Prisma unique-
    // constraint exception escaping to the client). Both branches that can
    // reach a create() call racily are covered here — see the inline note
    // on why both are reachable, not just one.

    it(
      "new/PENDING_ACTIVATION-user branch: one request succeeds, the loser gets a clean 409, no duplicate state, no 500",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const email = uniqueEmail("concurrent-accept-new-user");

        // No account exists for this email yet — accept() will take the
        // case-B branch, whose tx.user.create() is the exact call site
        // that raced on users.email before this patch.
        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/invitations`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ email, roleName: "Content Writer" })
          .expect(201);
        const inviteEmail = await getLatestEmailFor(email);
        const token = extractToken(inviteEmail.body);

        const [r1, r2] = await Promise.all([
          request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${token}/accept`),
          request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${token}/accept`),
        ]);

        const statuses = [r1.status, r2.status].sort((a, b) => a - b);
        expect(statuses).toEqual([200, 409]);
        expect(statuses).not.toContain(500);

        const loser = r1.status === 409 ? r1 : r2;
        expect(loser.body.code).toBe("INVITATION_ALREADY_ACCEPTED");
        // No Prisma internals (constraint names, stack traces, "Invalid
        // `tx.user.create()` invocation", etc.) ever reach the client.
        expect(JSON.stringify(loser.body)).not.toMatch(/prisma|constraint|invocation/i);

        const wsRow = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId } });
        const user = await ctx.prisma.user.findFirstOrThrow({ where: { email } });

        // Exactly one workspace_members row.
        const memberships = await ctx.prisma.workspaceMember.findMany({ where: { workspaceId: wsRow.id, userId: user.id } });
        expect(memberships).toHaveLength(1);

        // Invitation is ACCEPTED, accepted_by is the winning user, exactly once.
        const invitationRow = await ctx.prisma.workspaceInvitation.findFirstOrThrow({ where: { invitedEmail: email } });
        expect(invitationRow.status).toBe("ACCEPTED");
        expect(invitationRow.acceptedById).toBe(user.id);

        // Exactly one USER_CREATED and one WORKSPACE_MEMBER_PENDING_ACTIVATION
        // event — the loser's transaction rolled back before writing any audit
        // row, so nothing is duplicated.
        const userCreatedEvents = await ctx.prisma.auditLog.findMany({ where: { action: "USER_CREATED", entityId: user.publicId } });
        const memberPendingEvents = await ctx.prisma.auditLog.findMany({
          where: { action: "WORKSPACE_MEMBER_PENDING_ACTIVATION", workspaceId: wsRow.id, entityId: user.publicId },
        });
        expect(userCreatedEvents).toHaveLength(1);
        expect(memberPendingEvents).toHaveLength(1);

        // A single, valid activation token exists (not zero, not two).
        const tokens = await ctx.prisma.userActionToken.findMany({
          where: { userId: user.id, purpose: "ACCOUNT_ACTIVATION", status: "PENDING" },
        });
        expect(tokens).toHaveLength(1);
      },
      20_000,
    );

    it(
      "existing-ACTIVE-user branch: one request succeeds, the loser gets a clean 409, no duplicate membership, no 500",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const member = await createActiveUserAndLogin(ctx, "concurrent-accept-existing-user");

        // Inviting an already-ACTIVE user binds invitedUserId at creation
        // (Module 1C Engineering Plan §2.C″(A)) — accept() takes the Case A
        // path, whose joinAsActive() -> tx.workspaceMember.create() is the
        // analogous racy call site for this branch (a different unique
        // constraint — workspace_members(workspace_id,user_id) — but the
        // exact same class of race, on a double-submitted accept from the
        // same session).
        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/invitations`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ email: member.email, roleName: "Content Writer" })
          .expect(201);
        const inviteEmail = await getLatestEmailFor(member.email);
        const token = extractToken(inviteEmail.body);

        const [r1, r2] = await Promise.all([
          request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${token}/accept`).set("Authorization", `Bearer ${member.accessToken}`),
          request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${token}/accept`).set("Authorization", `Bearer ${member.accessToken}`),
        ]);

        const statuses = [r1.status, r2.status].sort((a, b) => a - b);
        expect(statuses).toEqual([200, 409]);
        expect(statuses).not.toContain(500);

        const loser = r1.status === 409 ? r1 : r2;
        expect(loser.body.code).toBe("INVITATION_ALREADY_ACCEPTED");
        expect(JSON.stringify(loser.body)).not.toMatch(/prisma|constraint|invocation/i);

        const wsRow = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId } });
        const memberships = await ctx.prisma.workspaceMember.findMany({ where: { workspaceId: wsRow.id, userId: member.userId } });
        expect(memberships).toHaveLength(1);
        expect(memberships[0].status).toBe("ACTIVE");

        const invitationRow = await ctx.prisma.workspaceInvitation.findFirstOrThrow({ where: { invitedEmail: member.email } });
        expect(invitationRow.status).toBe("ACCEPTED");
        expect(invitationRow.acceptedById).toBe(member.userId);

        const joinedEvents = await ctx.prisma.auditLog.findMany({
          where: { action: "WORKSPACE_MEMBER_JOINED", workspaceId: wsRow.id, entityId: member.userId },
        });
        expect(joinedEvents).toHaveLength(1);
      },
      20_000,
    );
  });
});
