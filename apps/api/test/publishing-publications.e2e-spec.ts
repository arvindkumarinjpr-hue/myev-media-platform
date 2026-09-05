import { PublishingProviderRegistryBuilder, WordPressChannelProvider, startWordPressFixtureServer, type WordPressFixtureServer } from "@myev/shared";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/modules/publishing/publishing-provider-registry.factory";

/**
 * Module 9 Phase 9.7 — real end-to-end coverage for the Publication API
 * (create/readiness/list/detail/retry/cancel/safe-attempt-history) and
 * manual reconciliation. No live Worker runs in apps/api's own e2e
 * suite (same established precedent as publishing-dispatch.e2e-spec.ts)
 * — "immediate publish"/"retry" are proven up to QUEUED + a real
 * BackgroundJob row, never all the way to PUBLISHED (that is
 * apps/worker's own, already-covered concern).
 */
describe("Publishing publications + reconciliation (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;
  let ownerUserId: string;
  let ws: { id: string; publicId: string };
  let wordpressFixture: WordPressFixtureServer;
  let channelAccountId: string;

  beforeAll(async () => {
    wordpressFixture = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json")) return { status: 200, json: { id: 1, name: "Fixture Author" } };
      return { status: 500, json: {} };
    });

    ctx = await bootstrapE2eApp((builder) =>
      builder.overrideProvider(PUBLISHING_PROVIDER_REGISTRY).useFactory({
        factory: () => {
          const b = new PublishingProviderRegistryBuilder();
          b.register(new WordPressChannelProvider({ allowLocalTestTarget: true }));
          return b.freeze();
        },
      }),
    );
    const owner = await loginAsPlatformOwner(ctx);
    ownerToken = owner.accessToken;
    ownerUserId = (await ctx.prisma.user.findUniqueOrThrow({ where: { publicId: owner.publicId } })).id;
    const created = await createWorkspaceAsOwner(ctx, ownerToken);
    const row = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: created.publicId }, select: { id: true } });
    ws = { id: row.id, publicId: created.publicId };

    const connectRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/publishing/accounts/wordpress`)
      .set(auth())
      .send({ siteUrl: wordpressFixture.url, username: "fixture-user", applicationPassword: "fixture-password", displayName: "Fixture Blog" })
      .expect(201);
    channelAccountId = connectRes.body.data.publicId;
  });

  /**
   * Mirrors publishing-dispatch.e2e-spec.ts's own established precedent
   * exactly: this suite dispatches real durable publishing.execute.v1
   * jobs a real, already-running Worker (WORKER_QUEUES includes
   * PUBLISHING) picks up and executes asynchronously. Deleting
   * BackgroundJob/BackgroundJobHistory rows before every job this
   * workspace created has reached a terminal status races the Worker's
   * own concurrent writes — waiting first closes that race entirely
   * rather than merely narrowing it.
   */
  async function waitForAllPublishingJobsTerminal(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pending = await ctx.prisma.backgroundJob.count({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1", status: { in: ["QUEUED", "RUNNING"] } } });
      if (pending === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  afterAll(async () => {
    await waitForAllPublishingJobsTerminal();
    await ctx.prisma.publishAttempt.deleteMany({ where: { publicationTarget: { workspaceId: ws.id } } });
    await ctx.prisma.publicationTarget.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.publication.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.scheduledJob.deleteMany({ where: { workspaceId: ws.id } });
    const jobs = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
    await ctx.prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: jobs.map((j) => j.id) } } });
    await ctx.prisma.backgroundJob.deleteMany({ where: { workspaceId: ws.id } });
    await teardownE2eApp(ctx);
    await wordpressFixture.close();
  });

  function auth(workspacePublicId = ws?.publicId) {
    return { Authorization: `Bearer ${ownerToken}`, "X-Workspace-Id": workspacePublicId };
  }

  async function createApprovedBlog(title = "Approved Blog fixture", withBlogArticle = false): Promise<{ id: string; publicId: string }> {
    // A real WordPress connector requires body.blogDraft to resolve
    // BLOG_PUBLISHING_CONTENT_MISSING (Part O) — mirrors
    // publishing-readiness.e2e-spec.ts's own createItem() fixture shape.
    const body = {
      content: "Fixture content.",
      blogDraft: { introduction: "Fixture introduction.", bodySections: [{ level: 2, heading: "Fixture Section", content: "Fixture section content." }], conclusion: "Fixture conclusion.", cta: "Fixture CTA.", faqs: [] },
    };
    const res = await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items`).set(auth()).send({ contentType: "BLOG", title, body }).expect(201);
    const publicId = res.body.data.publicId as string;
    const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId }, select: { id: true } });
    await ctx.prisma.contentItem.update({ where: { id: row.id }, data: { status: "APPROVED" } });
    if (withBlogArticle) {
      await ctx.prisma.blogArticle.create({
        data: { workspaceId: ws.id, contentItemId: row.id, metaTitle: "Fixture meta title", metaDescription: "Fixture meta description", urlSlug: `fixture-${row.id}`, schemaMarkup: {}, createdById: ownerUserId },
      });
    }
    return { id: row.id, publicId };
  }

  it("readiness preview reports Ready for an approved blog + a connected WordPress account", async () => {
    const item = await createApprovedBlog("Ready readiness fixture", true);
    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/readiness`)
      .query({ contentItemId: item.publicId, channelAccountId })
      .set(auth())
      .expect(200);
    expect(res.body.data.ready).toBe(true);
    expect(res.body.data.blockingReasons).toEqual([]);
  });

  it("readiness preview reports Blocked with safe reasons for an un-approved content item, never a stack trace", async () => {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(auth())
      .send({ contentType: "BLOG", title: "Draft blog", body: { content: "x" } })
      .expect(201);
    const draftPublicId = res.body.data.publicId;
    const readiness = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/readiness`)
      .query({ contentItemId: draftPublicId, channelAccountId })
      .set(auth())
      .expect(200);
    expect(readiness.body.data.ready).toBe(false);
    expect(readiness.body.data.blockingReasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(readiness.body.data)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // no stack-trace-shaped content
  });

  let publicationId: string;
  let targetId: string;

  it("creates a publication (publish now) — target reaches QUEUED with a real durable BackgroundJob, derived summary is correct", async () => {
    const item = await createApprovedBlog("Publish now fixture");
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/publishing/publications`)
      .set(auth())
      .send({ contentItemPublicId: item.publicId, channelAccountPublicIds: [channelAccountId] })
      .expect(201);
    publicationId = res.body.data.publicId;
    targetId = res.body.data.targets[0].publicId;
    expect(res.body.data.targets[0].status).toBe("QUEUED");
    expect(res.body.data.summary.totalTargets).toBe(1);
    expect(res.body.data.summary.liveCount).toBe(1);

    const job = await ctx.prisma.backgroundJob.findFirst({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
    expect(job).not.toBeNull();
  });

  it("creating a publication with an unapproved content item is rejected before any target/job is created", async () => {
    const draft = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(auth())
      .send({ contentType: "BLOG", title: "Unapproved", body: { content: "x" } })
      .expect(201);
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/publishing/publications`)
      .set(auth())
      .send({ contentItemPublicId: draft.body.data.publicId, channelAccountPublicIds: [channelAccountId] })
      .expect(422);
  });

  it("creates a SCHEDULED publication — target reaches SCHEDULED, no immediate BackgroundJob dispatched, a ScheduledJob row exists", async () => {
    const item = await createApprovedBlog("Scheduled fixture");
    const scheduledFor = new Date(Date.now() + 3_600_000).toISOString();
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/publishing/publications`)
      .set(auth())
      .send({ contentItemPublicId: item.publicId, channelAccountPublicIds: [channelAccountId], scheduledFor })
      .expect(201);
    expect(res.body.data.targets[0].status).toBe("SCHEDULED");
    const scheduledJob = await ctx.prisma.scheduledJob.findFirst({ where: { workspaceId: ws.id, jobType: "publishing.dispatch.v1" } });
    expect(scheduledJob).not.toBeNull();
  });

  it("lists publications for this workspace, including the ones just created", async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/publishing/publications`).set(auth()).expect(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.data.find((p: { publicId: string }) => p.publicId === publicationId)).toBeDefined();
  });

  it("returns publication detail with per-target state, never the encrypted checkpoint/detail internals", async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/${publicationId}`).set(auth()).expect(200);
    expect(res.body.data.targets[0].publicId).toBe(targetId);
    expect(JSON.stringify(res.body.data)).not.toContain("ciphertext");
  });

  it("returns a SAFE attempt projection for the target — real transitions, never a raw provider/internal detail blob", async () => {
    const res = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${targetId}/attempts`).set(auth()).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toHaveProperty("attemptNumber", 1);
    expect(res.body.data[0]).toHaveProperty("toStatus");
    expect(JSON.stringify(res.body.data)).not.toContain("ciphertext");
  });

  it("cancel transitions an eligible (SCHEDULED) target to CANCELLED and disables its ScheduledJob", async () => {
    // SCHEDULED (not "publish now") deliberately — a QUEUED target racing
    // against a REAL, already-running Worker (this suite's own
    // publish-now tests above already prove real BackgroundJob dispatch)
    // would non-deterministically flip to PUBLISHING/FAILED before this
    // test's own cancel call lands, since the Worker's own production
    // registry has no allowLocalTestTarget escape hatch for this
    // fixture's loopback URL. A SCHEDULED target is never auto-dispatched
    // by the Worker at all (only a real ScheduledJob tick would do that,
    // far in the future here) — deterministic by construction, while
    // still exercising the real create -> cancel HTTP flow end to end.
    const item = await createApprovedBlog("Cancel-me fixture");
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/publishing/publications`)
      .set(auth())
      .send({ contentItemPublicId: item.publicId, channelAccountPublicIds: [channelAccountId], scheduledFor: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(201);
    const cancelTargetId = createRes.body.data.targets[0].publicId;
    expect(createRes.body.data.targets[0].status).toBe("SCHEDULED");
    const res = await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${cancelTargetId}/cancel`).set(auth()).expect(201);
    expect(res.body.data.status).toBe("CANCELLED");
  });

  it("rejects cross-workspace access to a publication/target — a second workspace cannot see or act on the first workspace's data", async () => {
    const otherWs = await createWorkspaceAsOwner(ctx, ownerToken);
    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${otherWs.publicId}/publishing/publications/${publicationId}`)
      .set({ Authorization: `Bearer ${ownerToken}`, "X-Workspace-Id": otherWs.publicId })
      .expect(404);
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${otherWs.publicId}/publishing/publications/targets/${targetId}/cancel`)
      .set({ Authorization: `Bearer ${ownerToken}`, "X-Workspace-Id": otherWs.publicId })
      .expect(404);
  });

  describe("manual reconciliation", () => {
    async function seedAmbiguousTarget(errorCode: string): Promise<{ targetId: string; publicationId: string }> {
      const item = await createApprovedBlog("Ambiguous outcome fixture");
      const publication = await ctx.prisma.publication.create({ data: { workspaceId: ws.id, contentItemId: item.id, requestedById: ownerUserId } });
      const target = await ctx.prisma.publicationTarget.create({
        data: {
          workspaceId: ws.id,
          publicationId: publication.id,
          contentItemId: item.id,
          channelAccountId: (await ctx.prisma.publishingChannelAccount.findUniqueOrThrow({ where: { publicId: channelAccountId } })).id,
          status: "FAILED",
          lastErrorCode: errorCode,
          lastErrorMessageSafe: "Simulated ambiguous external outcome for reconciliation testing.",
          idempotencyKey: `publish:reconcile-test:${item.publicId}:${errorCode}`,
        },
      });
      return { targetId: target.publicId, publicationId: publication.publicId };
    }

    it("ordinary retry is BLOCKED for a target awaiting reconciliation (Facebook ambiguous outcome)", async () => {
      const { targetId: ambiguousTargetId } = await seedAmbiguousTarget("FACEBOOK_PUBLISH_OUTCOME_UNKNOWN");
      const res = await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${ambiguousTargetId}/retry`).set(auth()).expect(409);
      expect(res.body.code).toBe("PUBLISHING_RECONCILIATION_REQUIRED");
    });

    it("an ordinary FAILED target (unrelated error code) is NOT reconciliation-blocked and can retry normally", async () => {
      const { targetId: ordinaryTargetId } = await seedAmbiguousTarget("WORDPRESS_UNAUTHORIZED");
      const res = await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${ordinaryTargetId}/retry`).set(auth()).expect(201);
      expect(res.body.data.status).toBe("QUEUED");
    });

    it("mark-externally-published transitions FAILED -> PUBLISHED with the operator-supplied external id, preserving the original ambiguous PublishAttempt untouched", async () => {
      const { targetId: ambiguousTargetId } = await seedAmbiguousTarget("INSTAGRAM_PUBLISHED_ID_UNRECOVERABLE");
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${ambiguousTargetId}/reconcile/mark-published`)
        .set(auth())
        .send({ externalContentId: "ig-media-verified-manually-123", externalUrl: "https://www.instagram.com/reel/verified123/", note: "Verified directly on Instagram by the operator." })
        .expect(201);
      expect(res.body.data.status).toBe("PUBLISHED");
      expect(res.body.data.externalContentId).toBe("ig-media-verified-manually-123");

      const attempts = await ctx.prisma.publishAttempt.findMany({ where: { publicationTarget: { publicId: ambiguousTargetId } }, orderBy: { occurredAt: "asc" } });
      expect(attempts.some((a) => a.fromStatus === "FAILED" && a.toStatus === "PUBLISHED")).toBe(true);
    });

    it("mark-externally-published is rejected for a target that is NOT awaiting reconciliation", async () => {
      const { targetId: ordinaryTargetId } = await seedAmbiguousTarget("WORDPRESS_UNAUTHORIZED");
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${ordinaryTargetId}/reconcile/mark-published`)
        .set(auth())
        .send({ externalContentId: "should-not-be-accepted", note: "attempted misuse" })
        .expect(409);
      expect(res.body.code).toBe("PUBLISHING_RECONCILIATION_NOT_APPLICABLE");
    });

    it("confirm-not-published clears the ambiguity WITHOUT retrying — and ordinary retry becomes possible only afterward", async () => {
      const { targetId: ambiguousTargetId } = await seedAmbiguousTarget("FACEBOOK_PUBLISH_OUTCOME_UNKNOWN");

      const blockedRetry = await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${ambiguousTargetId}/retry`).set(auth()).expect(409);
      expect(blockedRetry.body.code).toBe("PUBLISHING_RECONCILIATION_REQUIRED");

      const confirmRes = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${ambiguousTargetId}/reconcile/confirm-not-published`)
        .set(auth())
        .send({ note: "Verified directly — this was never actually published on Facebook." })
        .expect(201);
      expect(confirmRes.body.data.status).toBe("FAILED"); // still FAILED — confirm-not-published never auto-retries

      const retryRes = await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/publishing/publications/targets/${ambiguousTargetId}/retry`).set(auth()).expect(201);
      expect(retryRes.body.data.status).toBe("QUEUED");
    });
  });
});
