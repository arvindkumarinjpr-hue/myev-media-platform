import { PublishingDispatchService } from "../src/modules/publishing/publishing-dispatch.service";
import { PublishingPersistenceService } from "../src/modules/publishing/publishing-persistence.service";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 9 Phase 9.3 — proves apps/api's own manual-dispatch/cancel
 * primitives (PublishingDispatchService) and the scheduled-Publication
 * creation path (PublishingPersistenceService.createPublication() with
 * `scheduledFor` set) against real Postgres. No controller exists yet
 * (same Phase 9.1/9.2 precedent) — services are called directly via
 * `ctx.app.get(Service)`.
 */
describe("Publishing — Phase 9.3 Dispatch + Scheduling (e2e)", () => {
  let ctx: E2eApp;
  let persistence: PublishingPersistenceService;
  let dispatchService: PublishingDispatchService;
  let ownerAccessToken: string;
  let ownerUserId: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    persistence = ctx.app.get(PublishingPersistenceService);
    dispatchService = ctx.app.get(PublishingDispatchService);
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

  async function createApprovedBlog(ws: Workspace, title = "Approved Blog fixture"): Promise<{ id: string; publicId: string }> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(auth(ws))
      .send({ contentType: "BLOG", title, body: { content: "Fixture content." } })
      .expect(201);
    const publicId = res.body.data.publicId as string;
    const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId }, select: { id: true } });
    await ctx.prisma.contentItem.update({ where: { id: row.id }, data: { status: "APPROVED" } });
    return { id: row.id, publicId };
  }

  async function createChannelAccount(ws: Workspace): Promise<{ id: string; publicId: string }> {
    const credential = await ctx.prisma.channelCredential.create({
      data: { workspaceId: ws.id, ciphertext: "fixture-ciphertext", nonce: "fixture-nonce", authTag: "fixture-auth-tag", keyVersion: 1 },
    });
    const account = await ctx.prisma.publishingChannelAccount.create({
      data: { workspaceId: ws.id, channelType: "WORDPRESS", displayName: "Fixture WordPress account", externalAccountId: `ext-${credential.id}`, credentialId: credential.id, connectedById: ownerUserId },
    });
    return { id: account.id, publicId: account.publicId };
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await ctx.prisma.publishAttempt.deleteMany({ where: { publicationTarget: { workspaceId: ws.id } } });
    await ctx.prisma.publicationTarget.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.publication.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.scheduledJob.deleteMany({ where: { workspaceId: ws.id } });
    const jobs = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
    await ctx.prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: jobs.map((j) => j.id) } } });
    await ctx.prisma.backgroundJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.publishingChannelAccount.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.channelCredential.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentItem.updateMany({ where: { workspaceId: ws.id }, data: { currentVersionId: null, featuredMediaAssetId: null, seriesId: null, deletedAt: new Date() } });
    await ctx.prisma.blogArticle.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentVersion.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentItem.deleteMany({ where: { workspaceId: ws.id } });
  }

  describe("manual dispatch", () => {
    it("creates exactly one BackgroundJob and transitions PENDING -> QUEUED", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });

      const { target, job } = await dispatchService.dispatchTarget(ws.id, ownerUserId, targets[0].publicId);
      expect(target.status).toBe("QUEUED");
      expect(job.jobType).toBe("publishing.execute.v1");

      const jobs = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(jobs).toHaveLength(1);

      await cleanup(ws);
    });

    it("a second dispatch of the same (already-QUEUED) target is rejected — no duplicate BackgroundJob", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      await dispatchService.dispatchTarget(ws.id, ownerUserId, targets[0].publicId);

      await expect(dispatchService.dispatchTarget(ws.id, ownerUserId, targets[0].publicId)).rejects.toMatchObject({ status: 409 });

      const jobs = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(jobs).toHaveLength(1);

      await cleanup(ws);
    });

    it("a PUBLISHED target cannot be dispatched", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      await persistence.transitionTarget(ws.id, targets[0].publicId, "QUEUED");
      await persistence.transitionTarget(ws.id, targets[0].publicId, "PUBLISHING");
      await persistence.transitionTarget(ws.id, targets[0].publicId, "PUBLISHED");

      await expect(dispatchService.dispatchTarget(ws.id, ownerUserId, targets[0].publicId)).rejects.toMatchObject({ status: 409 });

      await cleanup(ws);
    });

    it("a CANCELLED target cannot be dispatched", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      await persistence.transitionTarget(ws.id, targets[0].publicId, "CANCELLED");

      await expect(dispatchService.dispatchTarget(ws.id, ownerUserId, targets[0].publicId)).rejects.toMatchObject({ status: 409 });

      await cleanup(ws);
    });

    it("a FAILED target retries — QUEUED with retryCount incremented, a distinct BackgroundJob generation", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      await persistence.transitionTarget(ws.id, targets[0].publicId, "QUEUED");
      await persistence.transitionTarget(ws.id, targets[0].publicId, "PUBLISHING");
      await persistence.transitionTarget(ws.id, targets[0].publicId, "FAILED");

      const { target } = await dispatchService.dispatchTarget(ws.id, ownerUserId, targets[0].publicId);
      expect(target.status).toBe("QUEUED");
      expect(target.retryCount).toBe(1);

      const jobs = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(jobs).toHaveLength(1);

      await cleanup(ws);
    });

    it("rejects dispatch of a target from a different workspace — enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const blog = await createApprovedBlog(other);
      const channel = await createChannelAccount(other);
      const { targets } = await persistence.createPublication(other.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });

      await expect(dispatchService.dispatchTarget(ws.id, ownerUserId, targets[0].publicId)).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });
  });

  describe("cancel", () => {
    it("cancels a PENDING target, preserves history", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });

      const cancelled = await dispatchService.cancelTarget(ws.id, ownerUserId, targets[0].publicId);
      expect(cancelled.status).toBe("CANCELLED");
      expect(cancelled.cancelledAt).not.toBeNull();

      const attempts = await ctx.prisma.publishAttempt.findMany({ where: { publicationTargetId: targets[0].id } });
      expect(attempts.length).toBeGreaterThan(0);

      await cleanup(ws);
    });

    it("a CANCELLED target cannot be cancelled again", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      await dispatchService.cancelTarget(ws.id, ownerUserId, targets[0].publicId);

      await expect(dispatchService.cancelTarget(ws.id, ownerUserId, targets[0].publicId)).rejects.toMatchObject({ status: 409 });

      await cleanup(ws);
    });

    it("cancelling a SCHEDULED target disables its ScheduledJob and prevents future dispatch", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const scheduledFor = new Date(Date.now() + 3_600_000);
      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId], scheduledFor });
      expect(targets[0].status).toBe("SCHEDULED");

      const scheduledJobsBefore = await ctx.prisma.scheduledJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.dispatch.v1" } });
      expect(scheduledJobsBefore).toHaveLength(1);
      expect(scheduledJobsBefore[0].enabled).toBe(true);

      await dispatchService.cancelTarget(ws.id, ownerUserId, targets[0].publicId);

      const scheduledJobsAfter = await ctx.prisma.scheduledJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.dispatch.v1" } });
      expect(scheduledJobsAfter[0].enabled).toBe(false);

      await cleanup(ws);
    });
  });

  describe("scheduled Publication creation", () => {
    it("creating a Publication with scheduledFor produces a SCHEDULED target and a matching, enabled ScheduledJob", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const scheduledFor = new Date(Date.now() + 3_600_000);

      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId], scheduledFor });
      expect(targets[0].status).toBe("SCHEDULED");

      const scheduledJobs = await ctx.prisma.scheduledJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.dispatch.v1" } });
      expect(scheduledJobs).toHaveLength(1);
      expect(scheduledJobs[0].enabled).toBe(true);
      expect(scheduledJobs[0].payloadMetadata).toMatchObject({ publicationTargetPublicId: targets[0].publicId });
      expect(scheduledJobs[0].nextRunAt).not.toBeNull();

      await cleanup(ws);
    });

    it("without scheduledFor, no ScheduledJob is created and the target starts PENDING", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);

      const { targets } = await persistence.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      expect(targets[0].status).toBe("PENDING");

      const scheduledJobs = await ctx.prisma.scheduledJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.dispatch.v1" } });
      expect(scheduledJobs).toHaveLength(0);

      await cleanup(ws);
    });
  });
});
