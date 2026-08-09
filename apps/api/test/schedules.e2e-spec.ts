import { randomUUID } from "crypto";
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
 * Module 1F Milestone 7 (Scheduler Foundation), Revision 3. Runs against
 * the real dev Docker Compose stack — real Postgres, real Redis. Worker
 * dispatch behavior (SchedulerTickManager) is covered separately in
 * apps/worker/test/scheduler-tick.e2e-spec.ts; this suite covers the API
 * layer only: CRUD, ownership isolation, validation, preview, and
 * optimistic locking.
 */
describe("Schedules (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let workspace: { publicId: string; slug: string; name: string };
  let workspaceInternalId: string;
  const platformSchedulePublicIds: string[] = [];

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
    workspace = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const ws = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: workspace.publicId } });
    workspaceInternalId = ws.id;
  });

  afterAll(async () => {
    // Platform-level (workspaceId: null) rows aren't covered by
    // teardownE2eApp's testWorkspaceIds-scoped cleanup — cleaned up
    // explicitly here.
    if (platformSchedulePublicIds.length > 0) {
      const rows = await ctx.prisma.scheduledJob.findMany({ where: { publicId: { in: platformSchedulePublicIds } }, select: { id: true } });
      await ctx.prisma.scheduledJob.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    }
    await teardownE2eApp(ctx);
  });

  function workspacePath(suffix = "") {
    return `/api/v1/workspaces/${workspace.publicId}/schedules${suffix}`;
  }

  describe("workspace schedule CRUD", () => {
    it("creates, gets, lists, updates, enables, disables, and soft-deletes a schedule", async () => {
      const createRes = await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: { echo: "hi" }, cronExpression: "0 9 * * *", timezone: "America/New_York" })
        .expect(201);
      const created = createRes.body.data;
      expect(created.publicId).toBeDefined();
      expect(created.id).toBeUndefined();
      expect(created.enabled).toBe(true);
      expect(created.version).toBe(1);
      expect(created.nextRunAt).toBeDefined();

      const getRes = await request(ctx.app.getHttpServer())
        .get(workspacePath(`/${created.publicId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(200);
      expect(getRes.body.data.publicId).toBe(created.publicId);

      const listRes = await request(ctx.app.getHttpServer())
        .get(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(200);
      expect((listRes.body.data as Array<{ publicId: string }>).some((s) => s.publicId === created.publicId)).toBe(true);

      const updateRes = await request(ctx.app.getHttpServer())
        .patch(workspacePath(`/${created.publicId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ version: 1, cronExpression: "0 10 * * *" })
        .expect(200);
      expect(updateRes.body.data.cronExpression).toBe("0 10 * * *");
      expect(updateRes.body.data.version).toBe(2);

      const disableRes = await request(ctx.app.getHttpServer())
        .post(workspacePath(`/${created.publicId}/disable`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      expect(disableRes.body.data.enabled).toBe(false);

      const enableRes = await request(ctx.app.getHttpServer())
        .post(workspacePath(`/${created.publicId}/enable`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      expect(enableRes.body.data.enabled).toBe(true);

      await request(ctx.app.getHttpServer())
        .delete(workspacePath(`/${created.publicId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(200);

      // Soft-deleted: no longer visible via get().
      await request(ctx.app.getHttpServer())
        .get(workspacePath(`/${created.publicId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(404);
    });

    it("workspaceId in the request body is structurally ignored — the schedule always lands in the route's own workspace", async () => {
      const otherWorkspace = await createWorkspaceAsOwner(ctx, ownerAccessToken);
      const res = await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 9 * * *", workspaceId: otherWorkspace.publicId })
        .expect(201);

      const row = await ctx.prisma.scheduledJob.findUniqueOrThrow({ where: { publicId: res.body.data.publicId } });
      expect(row.workspaceId).toBe(workspaceInternalId);
    });

    it("rejects a malformed cron expression with INVALID_CRON_EXPRESSION", async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "not a cron" })
        .expect(400);
      expect(res.body).toMatchObject({ code: "INVALID_CRON_EXPRESSION" });
    });

    it("rejects an invalid timezone with INVALID_SCHEDULE_TIMEZONE", async () => {
      const res = await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 9 * * *", timezone: "EST" })
        .expect(400);
      expect(res.body).toMatchObject({ code: "INVALID_SCHEDULE_TIMEZONE" });
    });

    it("a version conflict on update returns 409 SCHEDULE_VERSION_CONFLICT, never a silent overwrite", async () => {
      const createRes = await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 9 * * *" })
        .expect(201);
      const publicId = createRes.body.data.publicId;

      await request(ctx.app.getHttpServer())
        .patch(workspacePath(`/${publicId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ version: 1, cronExpression: "0 11 * * *" })
        .expect(200);

      // Stale version (1) — the row is already at version 2.
      const conflictRes = await request(ctx.app.getHttpServer())
        .patch(workspacePath(`/${publicId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ version: 1, cronExpression: "0 12 * * *" })
        .expect(409);
      expect(conflictRes.body).toMatchObject({ code: "SCHEDULE_VERSION_CONFLICT" });
    });

    it("preview returns the requested number of future occurrences in both UTC and schedule-local form", async () => {
      const createRes = await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 9 * * *", timezone: "UTC" })
        .expect(201);

      const previewRes = await request(ctx.app.getHttpServer())
        .get(workspacePath(`/${createRes.body.data.publicId}/preview`))
        .query({ count: 3 })
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(200);

      const occurrences = previewRes.body.data as Array<{ utc: string; local: string }>;
      expect(occurrences).toHaveLength(3);
      const times = occurrences.map((o) => new Date(o.utc).getTime());
      expect(times[1]).toBeGreaterThan(times[0]);
      expect(times[2]).toBeGreaterThan(times[1]);
    });

    it("rejects a preview count outside the 1-20 range", async () => {
      const createRes = await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 9 * * *" })
        .expect(201);

      await request(ctx.app.getHttpServer())
        .get(workspacePath(`/${createRes.body.data.publicId}/preview`))
        .query({ count: 21 })
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(400);
    });

    it("a role without SYSTEM_SCHEDULES_MANAGE gets 403 attempting to create", async () => {
      const writer = await createActiveUserAndLogin(ctx, "sched-writer");
      await addActiveMemberWithRole(ctx, workspaceInternalId, writer.userId, "Content Writer");

      await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${writer.accessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 9 * * *" })
        .expect(403);
    });
  });

  describe("platform schedule CRUD", () => {
    function platformPath(suffix = "") {
      return `/api/v1/platform/schedules${suffix}`;
    }

    it("creates, gets, lists, updates, and soft-deletes a platform-level schedule (workspaceId: null)", async () => {
      const createRes = await request(ctx.app.getHttpServer())
        .post(platformPath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 3 * * *" })
        .expect(201);
      const publicId = createRes.body.data.publicId as string;
      platformSchedulePublicIds.push(publicId);

      const row = await ctx.prisma.scheduledJob.findUniqueOrThrow({ where: { publicId } });
      expect(row.workspaceId).toBeNull();

      const getRes = await request(ctx.app.getHttpServer())
        .get(platformPath(`/${publicId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .expect(200);
      expect(getRes.body.data.publicId).toBe(publicId);

      await request(ctx.app.getHttpServer())
        .patch(platformPath(`/${publicId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .send({ version: 1, cronExpression: "0 4 * * *" })
        .expect(200);

      await request(ctx.app.getHttpServer()).delete(platformPath(`/${publicId}`)).set("Authorization", `Bearer ${ownerAccessToken}`).expect(200);
    });

    it("a non-Platform-Owner is denied on every platform route", async () => {
      const nonOwner = await createActiveUserAndLogin(ctx, "not-platform-owner");
      await request(ctx.app.getHttpServer())
        .post(platformPath())
        .set("Authorization", `Bearer ${nonOwner.accessToken}`)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 9 * * *" })
        .expect(403);
      await request(ctx.app.getHttpServer()).get(platformPath()).set("Authorization", `Bearer ${nonOwner.accessToken}`).expect(403);
    });
  });

  describe("cross-scope isolation", () => {
    it("a workspace route cannot read/mutate a platform-level schedule (404, not 403)", async () => {
      const createRes = await request(ctx.app.getHttpServer())
        .post("/api/v1/platform/schedules")
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 3 * * *" })
        .expect(201);
      const platformScheduleId = createRes.body.data.publicId as string;
      platformSchedulePublicIds.push(platformScheduleId);

      await request(ctx.app.getHttpServer())
        .get(workspacePath(`/${platformScheduleId}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(404);
    });

    it("a platform route cannot read/mutate a workspace-scoped schedule (404, not 403)", async () => {
      const createRes = await request(ctx.app.getHttpServer())
        .post(workspacePath())
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .send({ jobType: "system.ping.v1", payload: {}, cronExpression: "0 9 * * *" })
        .expect(201);
      const workspaceScheduleId = createRes.body.data.publicId as string;

      await request(ctx.app.getHttpServer()).get(`/api/v1/platform/schedules/${workspaceScheduleId}`).set("Authorization", `Bearer ${ownerAccessToken}`).expect(404);
    });

    it("an unrelated schedule id looked up cross-workspace returns 404, never 403 (enumeration-safe)", async () => {
      await request(ctx.app.getHttpServer())
        .get(workspacePath(`/${randomUUID()}`))
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(404);
    });
  });
});
