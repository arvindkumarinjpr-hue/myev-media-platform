import * as crypto from "crypto";
import { PublishingPersistenceService } from "../src/modules/publishing/publishing-persistence.service";
import { InternalLinksService } from "../src/modules/internal-links/internal-links.service";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 9 Phase 9.1 — Publishing / Content Distribution Engine: Domain +
 * Persistence Foundation. No controller exists yet (Architecture
 * Checkpoint's own Phase 9.1 scope), so this suite exercises
 * PublishingPersistenceService directly — the same `ctx.app.get(Service)`
 * pattern internal-links-foundation.e2e-spec.ts uses — against a real,
 * migrated Postgres database. Proves: content publish eligibility (Blog
 * and Video), workspace isolation, the live-target-uniqueness DB
 * invariant, idempotency-key uniqueness, history preservation across a
 * terminal-then-new-publication sequence, append-only PublishAttempt
 * semantics, and that Module 8's ACCEPTED internal-link state has zero
 * bearing on publish eligibility. No provider/worker/scheduling/OAuth
 * code exists yet — explicitly not this phase's scope.
 */
describe("Publishing — Phase 9.1 Domain + Persistence Foundation (e2e)", () => {
  let ctx: E2eApp;
  let service: PublishingPersistenceService;
  let internalLinks: InternalLinksService;
  let ownerAccessToken: string;
  let ownerUserId: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    service = ctx.app.get(PublishingPersistenceService);
    internalLinks = ctx.app.get(InternalLinksService);
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

  async function createItem(ws: Workspace, contentType: "BLOG" | "VIDEO", title: string): Promise<{ id: string; publicId: string }> {
    const body = contentType === "VIDEO" ? { script: "Fixture script for Module 9 Phase 9.1 tests." } : { content: "Fixture content for Module 9 Phase 9.1 tests." };
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/content-items`)
      .set(auth(ws))
      .send({ contentType, title, body })
      .expect(201);
    const publicId = res.body.data.publicId as string;
    const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId }, select: { id: true } });
    return { id: row.id, publicId };
  }

  /**
   * VIDEO only — mirrors internal-links-foundation.e2e-spec.ts's own
   * `moveTo` exactly (its own fixtures are VIDEO-only for the same
   * reason discovered here). BLOG cannot use `POST .../submit-for-review`
   * at all: the generic content-items route unconditionally returns
   * `CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE` for any Blog item (Module 6's
   * own "generic content-item lifecycle route cannot bypass Blog gates"
   * review-gate seal) — a real product invariant this suite has no
   * reason to route around by standing up a full Blog pipeline (brief/
   * outline/draft/SEO/QA/score) just to reach APPROVED. See
   * setContentItemStatusDirectly for how Blog fixtures reach REVIEW/
   * APPROVED instead.
   */
  async function moveTo(ws: Workspace, itemPublicId: string, status: "IN_PROGRESS" | "REVIEW" | "APPROVED" | "ARCHIVED" | "DELETED"): Promise<void> {
    const base = `/api/v1/workspaces/${ws.publicId}/content-items/${itemPublicId}`;
    if (status === "IN_PROGRESS" || status === "REVIEW" || status === "APPROVED") {
      await request(ctx.app.getHttpServer()).post(`${base}/start`).set(auth(ws)).expect(200);
    }
    if (status === "REVIEW" || status === "APPROVED") {
      await request(ctx.app.getHttpServer()).post(`${base}/submit-for-review`).set(auth(ws)).send({}).expect(200);
    }
    if (status === "APPROVED") {
      await request(ctx.app.getHttpServer()).post(`${base}/approve`).set(auth(ws)).send({}).expect(200);
    }
    if (status === "ARCHIVED") {
      await request(ctx.app.getHttpServer()).post(`${base}/archive`).set(auth(ws)).expect(200);
    }
    if (status === "DELETED") {
      await request(ctx.app.getHttpServer()).delete(base).set(auth(ws)).expect(200);
    }
  }

  /** BLOG fixtures only — sets status directly, sidestepping the Blog-pipeline-only review gate (see moveTo's own doc comment). Testing Publishing's own eligibility logic here, not re-deriving Module 6's already-proven pipeline gate. */
  async function setContentItemStatusDirectly(itemId: string, status: "REVIEW" | "APPROVED" | "DELETED"): Promise<void> {
    await ctx.prisma.contentItem.update({ where: { id: itemId }, data: { status, ...(status === "DELETED" ? { deletedAt: new Date() } : {}) } });
  }

  async function createRenderJob(ws: Workspace, contentItemId: string, status: "FAILED" | "COMPLETED" | "QUEUED" | "RUNNING" | "TIMED_OUT"): Promise<void> {
    await ctx.prisma.videoRenderJob.create({
      data: {
        workspaceId: ws.id,
        contentItemId,
        status,
        targetPlatform: "YOUTUBE_LONG",
        exportProfileId: "fixture-export-profile",
        renderInputSnapshot: {},
        scriptVersionHash: "fixture-script-hash",
        sceneAssetFingerprint: "fixture-scene-fingerprint",
        voiceAudioAssetPublicId: crypto.randomUUID(),
        renderEngine: "deterministic-test",
        renderEngineVersion: "1",
        correlationId: crypto.randomUUID(),
      },
    });
  }

  async function createApprovedBlog(ws: Workspace, title = "Approved Blog fixture"): Promise<{ id: string; publicId: string }> {
    const item = await createItem(ws, "BLOG", title);
    await setContentItemStatusDirectly(item.id, "APPROVED");
    return item;
  }

  /** Raw fixture insert — Phase 9.1's persistence service never creates ChannelCredential/PublishingChannelAccount rows itself (no connect flow exists yet), so tests seed them directly, matching internal-links-foundation.e2e-spec.ts's own "resolve fixtures directly via ctx.prisma" convention. */
  async function createChannelAccount(ws: Workspace, channelType: "WORDPRESS" | "YOUTUBE" | "FACEBOOK" | "INSTAGRAM" = "WORDPRESS"): Promise<{ id: string; publicId: string }> {
    const credential = await ctx.prisma.channelCredential.create({
      data: { workspaceId: ws.id, ciphertext: "fixture-ciphertext", nonce: "fixture-nonce", authTag: "fixture-auth-tag", keyVersion: 1 },
    });
    const account = await ctx.prisma.publishingChannelAccount.create({
      data: {
        workspaceId: ws.id,
        channelType,
        displayName: `Fixture ${channelType} account`,
        externalAccountId: `ext-${credential.id}`,
        credentialId: credential.id,
        connectedById: ownerUserId,
      },
    });
    return { id: account.id, publicId: account.publicId };
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await ctx.prisma.publishAttempt.deleteMany({ where: { publicationTarget: { workspaceId: ws.id } } });
    await ctx.prisma.publicationTarget.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.publication.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.publishingChannelAccount.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.channelCredential.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.internalLink.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentItem.updateMany({ where: { workspaceId: ws.id }, data: { currentVersionId: null, featuredMediaAssetId: null, seriesId: null, deletedAt: new Date() } });
    await ctx.prisma.contentReviewEvent.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.videoRenderJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.blogArticle.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentVersion.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentItem.deleteMany({ where: { workspaceId: ws.id } });
  }

  describe("content eligibility", () => {
    it("creates a Publication + PublicationTarget for an APPROVED Blog", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);

      const { publication, targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      expect(publication.contentItemId).toBe(blog.id);
      expect(targets).toHaveLength(1);
      expect(targets[0].status).toBe("PENDING");
      expect(targets[0].contentItemId).toBe(blog.id);

      await cleanup(ws);
    });

    it.each(["DRAFT", "IN_PROGRESS", "REVIEW", "ARCHIVED", "DELETED"] as const)("rejects a %s Blog — 422, nothing created", async (status) => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "BLOG", "Not yet approved");
      if (status === "IN_PROGRESS") await moveTo(ws, item.publicId, "IN_PROGRESS");
      else if (status === "ARCHIVED") await moveTo(ws, item.publicId, "ARCHIVED");
      else if (status === "REVIEW" || status === "DELETED") await setContentItemStatusDirectly(item.id, status);
      const channel = await createChannelAccount(ws);

      await expect(service.createPublication(ws.id, ownerUserId, { contentItemPublicId: item.publicId, channelAccountPublicIds: [channel.publicId] })).rejects.toMatchObject({ status: 422 });
      expect(await ctx.prisma.publication.count({ where: { workspaceId: ws.id } })).toBe(0);

      await cleanup(ws);
    });

    it("rejects an APPROVED Video with no render job at all", async () => {
      const ws = await createWorkspace();
      const video = await createItem(ws, "VIDEO", "Video without a render job");
      await moveTo(ws, video.publicId, "APPROVED");
      const channel = await createChannelAccount(ws, "YOUTUBE");

      await expect(service.createPublication(ws.id, ownerUserId, { contentItemPublicId: video.publicId, channelAccountPublicIds: [channel.publicId] })).rejects.toMatchObject({ status: 422 });

      await cleanup(ws);
    });

    it("rejects an APPROVED Video whose latest render job is not COMPLETED", async () => {
      const ws = await createWorkspace();
      const video = await createItem(ws, "VIDEO", "Video with a failed render");
      await moveTo(ws, video.publicId, "APPROVED");
      await createRenderJob(ws, video.id, "FAILED");
      const channel = await createChannelAccount(ws, "YOUTUBE");

      await expect(service.createPublication(ws.id, ownerUserId, { contentItemPublicId: video.publicId, channelAccountPublicIds: [channel.publicId] })).rejects.toMatchObject({ status: 422 });

      await cleanup(ws);
    });

    it("accepts an APPROVED Video whose latest render job is COMPLETED", async () => {
      const ws = await createWorkspace();
      const video = await createItem(ws, "VIDEO", "Video ready to publish");
      await moveTo(ws, video.publicId, "APPROVED");
      await createRenderJob(ws, video.id, "COMPLETED");
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const { targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: video.publicId, channelAccountPublicIds: [channel.publicId] });
      expect(targets).toHaveLength(1);

      await cleanup(ws);
    });

    it("uses the MOST RECENT render job's status, not an earlier one", async () => {
      const ws = await createWorkspace();
      const video = await createItem(ws, "VIDEO", "Video re-rendered after a failure");
      await moveTo(ws, video.publicId, "APPROVED");
      await createRenderJob(ws, video.id, "FAILED");
      await new Promise((r) => setTimeout(r, 5));
      await createRenderJob(ws, video.id, "COMPLETED");
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const { targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: video.publicId, channelAccountPublicIds: [channel.publicId] });
      expect(targets).toHaveLength(1);

      await cleanup(ws);
    });
  });

  describe("Module 8 boundary", () => {
    it("an ACCEPTED internal-link recommendation on the Blog has zero bearing on publish eligibility or content", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws, "Blog with an accepted internal link");
      const draftSource = await createItem(ws, "BLOG", "Draft source linking to it");
      const link = await internalLinks.create(ws.id, null, {
        sourceContentItemPublicId: draftSource.publicId,
        targetContentItemPublicId: blog.publicId,
        anchorText: "this guide",
        relevanceScore: 80,
        evidence: { note: "fixture" },
      });
      await internalLinks.accept(ws.id, link.publicId, ownerUserId);

      const beforeVersion = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: blog.id }, select: { currentVersionId: true } });

      const channel = await createChannelAccount(ws);
      const { targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      expect(targets).toHaveLength(1);

      // Publishing never touches Blog content, accepted-link status or not.
      const afterVersion = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: blog.id }, select: { currentVersionId: true } });
      expect(afterVersion.currentVersionId).toBe(beforeVersion.currentVersionId);
      const stillAccepted = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { id: link.id } });
      expect(stillAccepted.status).toBe("ACCEPTED");

      await cleanup(ws);
    });
  });

  describe("workspace isolation", () => {
    it("rejects a content item from a different workspace — enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const foreignBlog = await createApprovedBlog(other);
      const channel = await createChannelAccount(ws);

      await expect(service.createPublication(ws.id, ownerUserId, { contentItemPublicId: foreignBlog.publicId, channelAccountPublicIds: [channel.publicId] })).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });

    it("rejects a channel account from a different workspace — enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const foreignChannel = await createChannelAccount(other);

      await expect(service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [foreignChannel.publicId] })).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });

    it("a Publication/PublicationTarget row's workspace always matches its content item and channel account", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { publication, targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });

      expect(publication.workspaceId).toBe(ws.id);
      expect(targets[0].workspaceId).toBe(ws.id);

      await cleanup(ws);
    });
  });

  describe("live-target uniqueness invariant", () => {
    it("a second createPublication() for the same (content item, channel account) pair is rejected with a typed conflict, never a raw Prisma error, while the first is still live", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });

      await expect(service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] })).rejects.toMatchObject({
        status: 409,
        response: { code: "PUBLISHING_LIVE_TARGET_EXISTS" },
      });

      expect(await ctx.prisma.publicationTarget.count({ where: { workspaceId: ws.id } })).toBe(1);
      await cleanup(ws);
    });

    it("concurrent createPublication() for the same fresh pair: exactly one succeeds, the loser gets a typed conflict", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);

      const results = await Promise.allSettled([
        service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] }),
        service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 409, response: { code: "PUBLISHING_LIVE_TARGET_EXISTS" } });

      expect(await ctx.prisma.publicationTarget.count({ where: { workspaceId: ws.id } })).toBe(1);
      await cleanup(ws);
    });

    it("after the first target reaches a TERMINAL status (CANCELLED), a new publication to the same pair is allowed — history preserved, exactly one live row", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const first = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      await service.transitionTarget(ws.id, first.targets[0].publicId, "CANCELLED");

      const second = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      expect(second.targets[0].id).not.toBe(first.targets[0].id);

      const all = await ctx.prisma.publicationTarget.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: "asc" } });
      expect(all).toHaveLength(2);
      expect(all[0].status).toBe("CANCELLED");
      expect(all[1].status).toBe("PENDING");
      const live = all.filter((t) => t.status === "PENDING" || t.status === "SCHEDULED" || t.status === "QUEUED" || t.status === "PUBLISHING");
      expect(live).toHaveLength(1);

      await cleanup(ws);
    });
  });

  describe("idempotency-key uniqueness (schema-level)", () => {
    it("the database rejects a second PublicationTarget row sharing an idempotency key — proven at the schema level, independent of any service", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const publication = await ctx.prisma.publication.create({ data: { workspaceId: ws.id, contentItemId: blog.id, requestedById: ownerUserId } });
      const sharedKey = `manual-fixture-key-${publication.publicId}`;
      await ctx.prisma.publicationTarget.create({ data: { workspaceId: ws.id, publicationId: publication.id, contentItemId: blog.id, channelAccountId: channel.id, idempotencyKey: sharedKey } });

      const secondChannel = await createChannelAccount(ws, "YOUTUBE");
      await expect(
        ctx.prisma.publicationTarget.create({ data: { workspaceId: ws.id, publicationId: publication.id, contentItemId: blog.id, channelAccountId: secondChannel.id, idempotencyKey: sharedKey } }),
      ).rejects.toThrow();

      await cleanup(ws);
    });
  });

  describe("PublicationTarget lifecycle transitions", () => {
    it("PENDING -> QUEUED -> PUBLISHING -> PUBLISHED, each step appending a PublishAttempt row, publishedAt set", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      const targetId = targets[0].publicId;

      await service.transitionTarget(ws.id, targetId, "QUEUED");
      await service.transitionTarget(ws.id, targetId, "PUBLISHING");
      const published = await service.transitionTarget(ws.id, targetId, "PUBLISHED");

      expect(published.status).toBe("PUBLISHED");
      expect(published.publishedAt).not.toBeNull();

      const attempts = await ctx.prisma.publishAttempt.findMany({ where: { publicationTarget: { publicId: targetId } }, orderBy: { occurredAt: "asc" } });
      expect(attempts.map((a) => a.toStatus)).toEqual(["QUEUED", "PUBLISHING", "PUBLISHED"]);
      expect(attempts[0].fromStatus).toBe("PENDING");

      await cleanup(ws);
    });

    it("rejects every invalid transition with a typed 409, valid state never changes", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      const targetId = targets[0].publicId;

      // PENDING -> PUBLISHED is not allowed (must pass through QUEUED/PUBLISHING).
      await expect(service.transitionTarget(ws.id, targetId, "PUBLISHED")).rejects.toMatchObject({ status: 409 });

      await service.transitionTarget(ws.id, targetId, "CANCELLED");
      // No resurrection from a terminal state.
      await expect(service.transitionTarget(ws.id, targetId, "QUEUED")).rejects.toMatchObject({ status: 409 });

      const stillCancelled = await service.findTarget(ws.id, targetId);
      expect(stillCancelled.status).toBe("CANCELLED");

      await cleanup(ws);
    });

    it("FAILED -> QUEUED is an explicit, allowed retry that never silently resets to PENDING", async () => {
      const ws = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });
      const targetId = targets[0].publicId;

      await service.transitionTarget(ws.id, targetId, "QUEUED");
      await service.transitionTarget(ws.id, targetId, "PUBLISHING");
      await service.transitionTarget(ws.id, targetId, "FAILED");
      const retried = await service.transitionTarget(ws.id, targetId, "QUEUED");

      expect(retried.status).toBe("QUEUED");
      expect(retried.retryCount).toBe(1);

      const attempts = await ctx.prisma.publishAttempt.findMany({ where: { publicationTarget: { publicId: targetId } }, orderBy: { occurredAt: "asc" } });
      // Full history preserved -- the FAILED attempt is never deleted or overwritten.
      expect(attempts.map((a) => a.toStatus)).toEqual(["QUEUED", "PUBLISHING", "FAILED", "QUEUED"]);

      await cleanup(ws);
    });

    it("rejects a transition on a target from a different workspace — enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const blog = await createApprovedBlog(ws);
      const channel = await createChannelAccount(ws);
      const { targets } = await service.createPublication(ws.id, ownerUserId, { contentItemPublicId: blog.publicId, channelAccountPublicIds: [channel.publicId] });

      await expect(service.transitionTarget(other.id, targets[0].publicId, "QUEUED")).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });
  });
});
