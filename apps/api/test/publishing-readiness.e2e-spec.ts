import * as crypto from "crypto";
import { InternalLinksService } from "../src/modules/internal-links/internal-links.service";
import { FixturePublishingChannelProvider } from "../src/modules/publishing/fixture-publishing-provider";
import { PublishingCredentialCryptoService } from "../src/modules/publishing/publishing-credential-crypto.service";
import { PublishingProviderRegistryBuilder } from "../src/modules/publishing/publishing-provider-registry";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/modules/publishing/publishing-provider-registry.factory";
import type { PublishingConnectionCheckInput, PublishingConnectionValidationResult } from "../src/modules/publishing/publishing-provider.interface";
import { PublishingProviderResolverService } from "../src/modules/publishing/publishing-provider-resolver.service";
import { PublishingReadinessService } from "../src/modules/publishing/publishing-readiness.service";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 9 Phase 9.2 — Publishing Provider Abstraction + Readiness. No
 * controller exists yet (same Phase 9.1 precedent), so this suite
 * exercises PublishingReadinessService/PublishingProviderResolverService
 * directly against a real, migrated Postgres database.
 *
 * PUBLISHING_PROVIDER_REGISTRY is overridden (same established pattern
 * as RESEARCH_SOURCE_PROVIDER in research.e2e-spec.ts) with two
 * deterministic fixture providers — WORDPRESS (BLOG only) and YOUTUBE
 * (VIDEO only) — plus FACEBOOK/INSTAGRAM deliberately left unregistered
 * to prove PROVIDER_NOT_CONFIGURED behavior. connectionHealthByAccountId
 * lets individual tests simulate a provider-reported unhealthy
 * connection (revoked/invalid/unavailable) independent of the stored
 * PublishingConnectionStatus column.
 */
describe("Publishing — Phase 9.2 Provider Abstraction + Readiness (e2e)", () => {
  let ctx: E2eApp;
  let readiness: PublishingReadinessService;
  let resolver: PublishingProviderResolverService;
  let cryptoService: PublishingCredentialCryptoService;
  let ownerAccessToken: string;
  let ownerUserId: string;

  const connectionHealthByAccountId = new Map<string, PublishingConnectionValidationResult>();

  function wordpressProvider(): FixturePublishingChannelProvider {
    return new FixturePublishingChannelProvider({
      channelType: "WORDPRESS",
      capabilities: { supportedContentTypes: ["BLOG"], requiresRenderedMedia: false },
      resolveConnectionHealth: (input: PublishingConnectionCheckInput) => connectionHealthByAccountId.get(input.channelAccountId) ?? { healthy: true },
    });
  }

  function youtubeProvider(): FixturePublishingChannelProvider {
    return new FixturePublishingChannelProvider({
      channelType: "YOUTUBE",
      capabilities: { supportedContentTypes: ["VIDEO"], requiresRenderedMedia: true },
      resolveConnectionHealth: (input: PublishingConnectionCheckInput) => connectionHealthByAccountId.get(input.channelAccountId) ?? { healthy: true },
    });
  }

  beforeAll(async () => {
    ctx = await bootstrapE2eApp((builder) =>
      builder.overrideProvider(PUBLISHING_PROVIDER_REGISTRY).useFactory({
        factory: () => {
          const b = new PublishingProviderRegistryBuilder();
          b.register(wordpressProvider());
          b.register(youtubeProvider());
          // FACEBOOK / INSTAGRAM deliberately unregistered.
          return b.freeze();
        },
      }),
    );
    readiness = ctx.app.get(PublishingReadinessService);
    resolver = ctx.app.get(PublishingProviderResolverService);
    cryptoService = ctx.app.get(PublishingCredentialCryptoService);
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
    const body = contentType === "VIDEO" ? { script: "Fixture script for Module 9 Phase 9.2 tests." } : { content: "Fixture content for Module 9 Phase 9.2 tests." };
    const res = await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/content-items`).set(auth(ws)).send({ contentType, title, body }).expect(201);
    const publicId = res.body.data.publicId as string;
    const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { publicId }, select: { id: true } });
    return { id: row.id, publicId };
  }

  /** VIDEO only — see publishing-foundation.e2e-spec.ts's own moveTo doc comment for why BLOG cannot use this route. */
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

  async function setContentItemStatusDirectly(itemId: string, status: "REVIEW" | "APPROVED" | "DELETED"): Promise<void> {
    await ctx.prisma.contentItem.update({ where: { id: itemId }, data: { status, ...(status === "DELETED" ? { deletedAt: new Date() } : {}) } });
  }

  async function createBlogArticle(ws: Workspace, contentItemId: string, overrides: Partial<{ metaTitle: string; metaDescription: string }> = {}): Promise<void> {
    await ctx.prisma.blogArticle.create({
      data: {
        workspaceId: ws.id,
        contentItemId,
        metaTitle: overrides.metaTitle ?? "Fixture meta title",
        metaDescription: overrides.metaDescription ?? "Fixture meta description",
        urlSlug: `fixture-${crypto.randomUUID()}`,
        schemaMarkup: {},
        createdById: ownerUserId,
      },
    });
  }

  /** APPROVED Blog + a real BlogArticle row + a current version — the full "ready" happy-path fixture. */
  async function createReadyBlog(ws: Workspace, title = "Ready blog fixture"): Promise<{ id: string; publicId: string }> {
    const item = await createItem(ws, "BLOG", title);
    await setContentItemStatusDirectly(item.id, "APPROVED");
    await createBlogArticle(ws, item.id);
    return item;
  }

  async function createRenderJob(ws: Workspace, contentItemId: string, status: "FAILED" | "COMPLETED" | "QUEUED" | "RUNNING" | "TIMED_OUT", outputMediaAssetPublicId?: string): Promise<void> {
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
        outputMediaAssetPublicId,
        renderEngine: "deterministic-test",
        renderEngineVersion: "1",
        correlationId: crypto.randomUUID(),
      },
    });
  }

  async function createMediaAsset(ws: Workspace, status: "ACTIVE" | "QUARANTINED" | "PENDING_UPLOAD" = "ACTIVE"): Promise<{ id: string; publicId: string }> {
    const key = `fixture/${crypto.randomUUID()}.mp4`;
    const asset = await ctx.prisma.mediaAsset.create({
      data: {
        workspaceId: ws.id,
        assetType: "VIDEO",
        originalFilename: "fixture.mp4",
        normalizedFilename: "fixture.mp4",
        storageProviderIdentity: "MINIO",
        bucket: "fixture-bucket",
        objectKey: key,
        declaredMimeType: "video/mp4",
        declaredSizeBytes: 1024,
        extension: "mp4",
        assetGroupId: crypto.randomUUID(),
        status,
        createdById: ownerUserId,
      },
    });
    return { id: asset.id, publicId: asset.publicId };
  }

  /**
   * APPROVED Video + a COMPLETED render job + an ACTIVE output MediaAsset
   * + a pre-written description in the generic metadata.publishing bag
   * (see PublishingReadinessService's own resolvePlatformMetadata doc
   * comment — VIDEO has no BlogArticle-equivalent metadata table, so a
   * description exists only if this bag carries one) — the full "ready"
   * happy-path fixture.
   */
  async function createReadyVideo(ws: Workspace, title = "Ready video fixture"): Promise<{ id: string; publicId: string }> {
    const item = await createItem(ws, "VIDEO", title);
    await moveTo(ws, item.publicId, "APPROVED");
    await ctx.prisma.contentItem.update({
      where: { id: item.id },
      data: { metadata: { publishing: { description: "Fixture video description", tags: ["fixture"], caption: "Fixture caption" } } },
    });
    const asset = await createMediaAsset(ws, "ACTIVE");
    await createRenderJob(ws, item.id, "COMPLETED", asset.publicId);
    return item;
  }

  async function createChannelAccount(
    ws: Workspace,
    channelType: "WORDPRESS" | "YOUTUBE" | "FACEBOOK" | "INSTAGRAM",
    overrides: Partial<{ connectionStatus: "CONNECTED" | "EXPIRED" | "REVOKED" | "ERROR"; tokenExpiresAt: Date | null; secretPayload: Record<string, unknown>; rawCiphertext: boolean }> = {},
  ): Promise<{ id: string; publicId: string }> {
    const encrypted = overrides.rawCiphertext
      ? { ciphertext: "not-real-ciphertext", nonce: "not-real-nonce", authTag: "not-real-auth-tag", keyVersion: 1 }
      : cryptoService.encrypt(overrides.secretPayload ?? { apiKey: "fixture-secret-value-should-never-leak" });
    const credential = await ctx.prisma.channelCredential.create({
      data: { workspaceId: ws.id, ...encrypted, tokenExpiresAt: overrides.tokenExpiresAt ?? null },
    });
    const account = await ctx.prisma.publishingChannelAccount.create({
      data: {
        workspaceId: ws.id,
        channelType,
        displayName: `Fixture ${channelType} account`,
        externalAccountId: `ext-${credential.id}`,
        credentialId: credential.id,
        connectedById: ownerUserId,
        connectionStatus: overrides.connectionStatus ?? "CONNECTED",
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
    await ctx.prisma.scheduledJob.deleteMany({ where: { workspaceId: ws.id } });
    const jobs = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
    await ctx.prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: jobs.map((j) => j.id) } } });
    await ctx.prisma.backgroundJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.mediaAsset.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentItem.updateMany({ where: { workspaceId: ws.id }, data: { currentVersionId: null, featuredMediaAssetId: null, seriesId: null, deletedAt: new Date() } });
    await ctx.prisma.contentReviewEvent.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.videoRenderJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.blogArticle.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.contentVersion.deleteMany({ where: { contentItem: { workspaceId: ws.id } } });
    await ctx.prisma.contentItem.deleteMany({ where: { workspaceId: ws.id } });
  }

  describe("provider registry & resolver", () => {
    it("resolves a valid, configured channel to its provider", async () => {
      const ws = await createWorkspace();
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const context = await resolver.resolveChannelContext(ws.id, channel.publicId);
      expect(context.channelType).toBe("WORDPRESS");
      expect(context.provider.channelType).toBe("WORDPRESS");

      await cleanup(ws);
    });

    it("an unregistered channel type (FACEBOOK) is a typed 422, never a crash", async () => {
      const ws = await createWorkspace();
      const channel = await createChannelAccount(ws, "FACEBOOK");

      await expect(resolver.resolveChannelContext(ws.id, channel.publicId)).rejects.toMatchObject({
        status: 422,
        response: { code: "PUBLISHING_PROVIDER_NOT_CONFIGURED" },
      });

      await cleanup(ws);
    });

    it("a channel account from a different workspace is an enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const foreignChannel = await createChannelAccount(other, "WORDPRESS");

      await expect(resolver.resolveChannelContext(ws.id, foreignChannel.publicId)).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });

    it("validateConnection() maps a tampered/undecryptable credential to a typed, safe result — never a raw crypto error", async () => {
      const ws = await createWorkspace();
      const channel = await createChannelAccount(ws, "WORDPRESS", { rawCiphertext: true });

      const result = await resolver.validateConnection(ws.id, channel.publicId);
      expect(result.healthy).toBe(false);
      expect(result.reasonCode).toBe("CREDENTIAL_INVALID");

      await cleanup(ws);
    });

    it("validateConnection() reflects a provider-reported unhealthy connection (e.g. revoked)", async () => {
      const ws = await createWorkspace();
      const channel = await createChannelAccount(ws, "WORDPRESS");
      connectionHealthByAccountId.set(channel.id, { healthy: false, reasonCode: "CREDENTIAL_REVOKED", detail: "simulated revoke" });

      const result = await resolver.validateConnection(ws.id, channel.publicId);
      expect(result.healthy).toBe(false);
      expect(result.reasonCode).toBe("CREDENTIAL_REVOKED");

      connectionHealthByAccountId.delete(channel.id);
      await cleanup(ws);
    });

    it("decrypted credential material never appears in a resolveChannelContext() result", async () => {
      const ws = await createWorkspace();
      const secretMarker = `super-secret-${crypto.randomUUID()}`;
      const channel = await createChannelAccount(ws, "WORDPRESS", { secretPayload: { apiKey: secretMarker } });

      const context = await resolver.resolveChannelContext(ws.id, channel.publicId);
      expect(JSON.stringify(context)).not.toContain(secretMarker);

      await cleanup(ws);
    });
  });

  describe("Blog readiness", () => {
    it("an APPROVED Blog with a BlogArticle and a healthy, connected WORDPRESS account is ready", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(true);
      expect(result.blockingReasons).toEqual([]);
      expect(result.metadata.title).toBeTruthy();
      expect(result.metadata.description).toBeTruthy();

      await cleanup(ws);
    });

    it.each(["DRAFT", "REVIEW"] as const)("a %s Blog is not ready — CONTENT_NOT_APPROVED", async (status) => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "BLOG", "Not approved");
      if (status === "REVIEW") await setContentItemStatusDirectly(item.id, "REVIEW");
      await createBlogArticle(ws, item.id);
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CONTENT_NOT_APPROVED");

      await cleanup(ws);
    });

    it("an ARCHIVED Blog is not ready — CONTENT_NOT_APPROVED", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "BLOG", "Archived blog");
      await setContentItemStatusDirectly(item.id, "APPROVED");
      await createBlogArticle(ws, item.id);
      await ctx.prisma.contentItem.update({ where: { id: item.id }, data: { status: "ARCHIVED", archivedAt: new Date(), archivedFromStatus: "APPROVED" } });
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CONTENT_NOT_APPROVED");

      await cleanup(ws);
    });

    it("a DELETED Blog is not ready — CONTENT_DELETED", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "BLOG", "Deleted blog");
      await setContentItemStatusDirectly(item.id, "APPROVED");
      await createBlogArticle(ws, item.id);
      await setContentItemStatusDirectly(item.id, "DELETED");
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CONTENT_DELETED");

      await cleanup(ws);
    });

    it("an APPROVED Blog with no BlogArticle row is not ready — BLOG_ARTICLE_MISSING", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "BLOG", "No article row");
      await setContentItemStatusDirectly(item.id, "APPROVED");
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("BLOG_ARTICLE_MISSING");

      await cleanup(ws);
    });

    // No "missing current version/body" test: Module 1E's own deferred DB
    // trigger guarantees a non-deleted ContentItem always has a
    // currentVersionId at commit — confirmed live (see
    // PublishingReadinessService.evaluateBlogReadiness's own doc
    // comment), so that state is unreachable through any legal DB
    // mutation and there is nothing to test.

    it("a channel that does not support BLOG (YOUTUBE) is not ready — CHANNEL_NOT_SUPPORTED", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CHANNEL_NOT_SUPPORTED");

      await cleanup(ws);
    });

    it("a disconnected account (EXPIRED connectionStatus) is not ready — CHANNEL_ACCOUNT_NOT_CONNECTED", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const channel = await createChannelAccount(ws, "WORDPRESS", { connectionStatus: "EXPIRED" });

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CHANNEL_ACCOUNT_NOT_CONNECTED");

      await cleanup(ws);
    });

    it("an expired credential (past tokenExpiresAt) is not ready — CREDENTIAL_EXPIRED, decrypt never attempted", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const channel = await createChannelAccount(ws, "WORDPRESS", { tokenExpiresAt: new Date(Date.now() - 1000) });

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CREDENTIAL_EXPIRED");

      await cleanup(ws);
    });

    it("a provider-reported invalid/revoked connection is not ready — CREDENTIAL_INVALID", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const channel = await createChannelAccount(ws, "WORDPRESS");
      connectionHealthByAccountId.set(channel.id, { healthy: false, reasonCode: "CREDENTIAL_INVALID" });

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CREDENTIAL_INVALID");

      connectionHealthByAccountId.delete(channel.id);
      await cleanup(ws);
    });

    it("an unconfigured channel (FACEBOOK) is not ready — PROVIDER_NOT_CONFIGURED, no crash", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const channel = await createChannelAccount(ws, "FACEBOOK");

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toEqual(["PROVIDER_NOT_CONFIGURED"]);

      await cleanup(ws);
    });

    it("required metadata missing (empty meta description) is not ready — REQUIRED_METADATA_MISSING", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "BLOG", "Missing description");
      await setContentItemStatusDirectly(item.id, "APPROVED");
      await createBlogArticle(ws, item.id, { metaDescription: "" });
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("REQUIRED_METADATA_MISSING");

      await cleanup(ws);
    });

    it("Module 8 ACCEPTED internal-link recommendations have zero bearing on Blog readiness", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws, "Blog with accepted link");
      const source = await createItem(ws, "BLOG", "Draft source");
      const internalLinksService = ctx.app.get(InternalLinksService);
      const link = await internalLinksService.create(ws.id, null, {
        sourceContentItemPublicId: source.publicId,
        targetContentItemPublicId: blog.publicId,
        anchorText: "read more",
        relevanceScore: 75,
        evidence: { note: "fixture" },
      });
      await internalLinksService.accept(ws.id, link.publicId, ownerUserId);
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(true);

      await cleanup(ws);
    });
  });

  describe("Video readiness", () => {
    it("an APPROVED Video with a COMPLETED render + ACTIVE MediaAsset on a healthy, connected YOUTUBE account is ready", async () => {
      const ws = await createWorkspace();
      const video = await createReadyVideo(ws);
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const result = await readiness.evaluateReadiness(ws.id, video.publicId, channel.publicId);
      expect(result.ready).toBe(true);
      expect(result.blockingReasons).toEqual([]);
      expect(result.resolvedArtifact?.mediaAssetPublicId).toBeTruthy();

      await cleanup(ws);
    });

    it("no render job at all is not ready — RENDER_NOT_READY", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "VIDEO", "No render");
      await moveTo(ws, item.publicId, "APPROVED");
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("RENDER_NOT_READY");

      await cleanup(ws);
    });

    it("a FAILED render is not ready — RENDER_NOT_READY", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "VIDEO", "Failed render");
      await moveTo(ws, item.publicId, "APPROVED");
      await createRenderJob(ws, item.id, "FAILED");
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("RENDER_NOT_READY");

      await cleanup(ws);
    });

    it("a COMPLETED render whose output MediaAsset is missing is not ready — MEDIA_ASSET_MISSING", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "VIDEO", "Completed but no asset pointer");
      await moveTo(ws, item.publicId, "APPROVED");
      await createRenderJob(ws, item.id, "COMPLETED", undefined);
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("MEDIA_ASSET_MISSING");

      await cleanup(ws);
    });

    it("a COMPLETED render whose output MediaAsset exists but is not ACTIVE is not ready — MEDIA_ASSET_INELIGIBLE", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "VIDEO", "Quarantined asset");
      await moveTo(ws, item.publicId, "APPROVED");
      const asset = await createMediaAsset(ws, "QUARANTINED");
      await createRenderJob(ws, item.id, "COMPLETED", asset.publicId);
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("MEDIA_ASSET_INELIGIBLE");

      await cleanup(ws);
    });

    it("a channel that does not support VIDEO (WORDPRESS) is not ready — CHANNEL_NOT_SUPPORTED", async () => {
      const ws = await createWorkspace();
      const video = await createReadyVideo(ws);
      const channel = await createChannelAccount(ws, "WORDPRESS");

      const result = await readiness.evaluateReadiness(ws.id, video.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CHANNEL_NOT_SUPPORTED");

      await cleanup(ws);
    });

    it("a provider/account failure (disconnected) is not ready", async () => {
      const ws = await createWorkspace();
      const video = await createReadyVideo(ws);
      const channel = await createChannelAccount(ws, "YOUTUBE", { connectionStatus: "REVOKED" });

      const result = await readiness.evaluateReadiness(ws.id, video.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CHANNEL_ACCOUNT_NOT_CONNECTED");

      await cleanup(ws);
    });

    it("uses the MOST RECENT render job, not an earlier COMPLETED one that is no longer current", async () => {
      const ws = await createWorkspace();
      const item = await createItem(ws, "VIDEO", "Re-rendered video");
      await moveTo(ws, item.publicId, "APPROVED");
      const oldAsset = await createMediaAsset(ws, "ACTIVE");
      await createRenderJob(ws, item.id, "COMPLETED", oldAsset.publicId);
      await new Promise((r) => setTimeout(r, 5));
      await createRenderJob(ws, item.id, "FAILED");
      const channel = await createChannelAccount(ws, "YOUTUBE");

      const result = await readiness.evaluateReadiness(ws.id, item.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("RENDER_NOT_READY");

      await cleanup(ws);
    });
  });

  describe("side-effect safety", () => {
    it("evaluating readiness repeatedly creates zero Publication/PublicationTarget/PublishAttempt/BackgroundJob/ScheduledJob rows and mutates nothing", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const video = await createReadyVideo(ws);
      const wordpress = await createChannelAccount(ws, "WORDPRESS");
      const youtube = await createChannelAccount(ws, "YOUTUBE");

      const beforeBlog = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: blog.id }, select: { status: true, currentVersionId: true, updatedAt: true } });
      const beforeVideo = await ctx.prisma.videoRenderJob.findMany({ where: { contentItemId: video.id } });
      const beforeBlogArticle = await ctx.prisma.blogArticle.findFirstOrThrow({ where: { contentItemId: blog.id } });

      for (let i = 0; i < 3; i++) {
        await readiness.evaluateReadiness(ws.id, blog.publicId, wordpress.publicId);
        await readiness.evaluateReadiness(ws.id, video.publicId, youtube.publicId);
      }

      expect(await ctx.prisma.publication.count({ where: { workspaceId: ws.id } })).toBe(0);
      expect(await ctx.prisma.publicationTarget.count({ where: { workspaceId: ws.id } })).toBe(0);
      expect(await ctx.prisma.publishAttempt.count({ where: { publicationTarget: { workspaceId: ws.id } } })).toBe(0);
      expect(await ctx.prisma.backgroundJob.count({ where: { workspaceId: ws.id } })).toBe(0);
      expect(await ctx.prisma.scheduledJob.count({ where: { workspaceId: ws.id } })).toBe(0);

      const afterBlog = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: blog.id }, select: { status: true, currentVersionId: true, updatedAt: true } });
      expect(afterBlog.status).toBe(beforeBlog.status);
      expect(afterBlog.currentVersionId).toBe(beforeBlog.currentVersionId);
      expect(afterBlog.updatedAt).toEqual(beforeBlog.updatedAt);

      const afterVideo = await ctx.prisma.videoRenderJob.findMany({ where: { contentItemId: video.id } });
      expect(afterVideo).toEqual(beforeVideo);

      const afterBlogArticle = await ctx.prisma.blogArticle.findFirstOrThrow({ where: { contentItemId: blog.id } });
      expect(afterBlogArticle.updatedAt).toEqual(beforeBlogArticle.updatedAt);

      await cleanup(ws);
    });

    it("evaluating readiness never touches Module 8 internal-link records", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws, "Blog with a link to leave alone");
      const source = await createItem(ws, "BLOG", "Source");
      const internalLinksService = ctx.app.get(InternalLinksService);
      const link = await internalLinksService.create(ws.id, null, {
        sourceContentItemPublicId: source.publicId,
        targetContentItemPublicId: blog.publicId,
        anchorText: "read more",
        relevanceScore: 75,
        evidence: { note: "fixture" },
      });
      const beforeLink = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { id: link.id } });
      const channel = await createChannelAccount(ws, "WORDPRESS");

      await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);

      const afterLink = await ctx.prisma.internalLink.findUniqueOrThrow({ where: { id: link.id } });
      expect(afterLink).toEqual(beforeLink);

      await cleanup(ws);
    });
  });

  describe("security", () => {
    it("no plaintext credential value ever appears in a readiness result, JSON-serialized or otherwise", async () => {
      const ws = await createWorkspace();
      const secretMarker = `super-secret-${crypto.randomUUID()}`;
      const blog = await createReadyBlog(ws);
      const channel = await createChannelAccount(ws, "WORDPRESS", { secretPayload: { apiKey: secretMarker } });

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secretMarker);

      await cleanup(ws);
    });

    it("the stored ChannelCredential ciphertext is never the plaintext payload", async () => {
      const ws = await createWorkspace();
      const secretMarker = `super-secret-${crypto.randomUUID()}`;
      const channel = await createChannelAccount(ws, "WORDPRESS", { secretPayload: { apiKey: secretMarker } });

      const account = await ctx.prisma.publishingChannelAccount.findUniqueOrThrow({ where: { id: channel.id }, include: { credential: true } });
      expect(account.credential.ciphertext).not.toContain(secretMarker);

      await cleanup(ws);
    });

    it("a tampered/undecryptable credential never throws a raw crypto error out of readiness — surfaces as a normal blocking reason", async () => {
      const ws = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const channel = await createChannelAccount(ws, "WORDPRESS", { rawCiphertext: true });

      const result = await readiness.evaluateReadiness(ws.id, blog.publicId, channel.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toContain("CREDENTIAL_INVALID");

      await cleanup(ws);
    });

    it("workspace isolation: a content item from a foreign workspace is an enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const foreignBlog = await createReadyBlog(other);
      const channel = await createChannelAccount(ws, "WORDPRESS");

      await expect(readiness.evaluateReadiness(ws.id, foreignBlog.publicId, channel.publicId)).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });

    it("workspace isolation: a channel account from a foreign workspace is an enumeration-safe 404", async () => {
      const ws = await createWorkspace();
      const other = await createWorkspace();
      const blog = await createReadyBlog(ws);
      const foreignChannel = await createChannelAccount(other, "WORDPRESS");

      await expect(readiness.evaluateReadiness(ws.id, blog.publicId, foreignChannel.publicId)).rejects.toMatchObject({ status: 404 });

      await cleanup(ws);
      await cleanup(other);
    });
  });
});
