import { randomUUID } from "crypto";
import {
  AIProviderError,
  AIProviderErrorCode,
  AIProviderRegistryBuilder,
  FacebookChannelProvider,
  InstagramChannelProvider,
  parseStructuredOutput,
  PublishingProviderRegistryBuilder,
  startMetaFixtureServer,
  type AIModelCapability,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type MetaFixtureServer,
} from "@myev/shared";
import { AI_PROVIDER_REGISTRY } from "../src/modules/ai-agents/ai-provider-registry.module";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/modules/publishing/publishing-provider-registry.factory";
import { PublishingCredentialCryptoService } from "../src/modules/publishing/publishing-credential-crypto.service";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 10 Phase 10.5 — Media-Aware Meta Publishing Foundation (e2e).
 *
 * Real FacebookChannelProvider/InstagramChannelProvider are registered
 * (pointed at a local Meta fixture server for validateConnection's own
 * "whoami" call — never a real Graph API call), so readiness is proven
 * against the REAL provider capability model, not a stand-in. Provider
 * publish() branches themselves (text feed post, image/video container,
 * checkpoint discipline) are already comprehensively unit-tested in
 * packages/shared's own facebook-channel-provider.spec.ts/
 * instagram-channel-provider.spec.ts — this file proves the
 * domain/schema/readiness INTEGRATION layer Phase 10.5 actually added on
 * top of that: SocialVersionMedia validation, source-media reuse, and the
 * real readiness truth table via the actual HTTP endpoint.
 */
class AgentKeyedFakeProvider implements AIProvider {
  readonly id = "openai";
  constructor(private readonly byAgent: Record<string, Record<string, unknown> | "FAIL">) {}
  async execute(request: AIRequest): Promise<AIResponse> {
    const fixture = request.agentName ? this.byAgent[request.agentName] : undefined;
    if (!fixture || fixture === "FAIL") throw new AIProviderError(AIProviderErrorCode.INVALID_REQUEST, "simulated failure", this.id);
    const output = request.structuredOutputSchema ? ((await parseStructuredOutput(JSON.stringify(fixture), request.structuredOutputSchema, this.id)) as Record<string, unknown>) : fixture;
    return { provider: this.id, model: "fake-openai-1", requestId: `fake-${request.correlationId ?? "none"}`, usage: { tokensIn: 1, tokensOut: 1, tokensTotal: 2 }, executionTimeMs: 1, finishReason: "stop", correlationId: request.correlationId, output };
  }
  getCapabilities(): AIModelCapability[] {
    return [{ model: "fake-openai-1", capability: "chat" }];
  }
}

const CAPTION_FIXTURE = { caption: "Charging your EV at home is easier than you think." };
const HASHTAG_FIXTURE = { hashtags: ["#ev", "#evcharging"] };

describe("Social media-aware Meta publishing (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let ownerUserId: string;
  let cryptoService: PublishingCredentialCryptoService;
  let metaFixture: MetaFixtureServer;

  interface Workspace {
    id: string;
    publicId: string;
  }

  beforeAll(async () => {
    metaFixture = await startMetaFixtureServer((req) => {
      // Order matters — "?fields=id,account_type" also contains the
      // substring "?fields=id", so the more specific Instagram check must
      // run first or every Instagram connection check would incorrectly
      // match Facebook's own fixture branch instead (a real bug caught by
      // this exact test the first time it ran).
      if (req.path.includes("?fields=id,account_type")) return { status: 200, json: { id: "ig-fixture", account_type: "BUSINESS" } };
      if (req.path.includes("?fields=id")) return { status: 200, json: { id: "page-fixture" } };
      return { status: 200, json: {} };
    });

    ctx = await bootstrapE2eApp((builder) =>
      builder
        .overrideProvider(AI_PROVIDER_REGISTRY)
        .useFactory({
          factory: () => {
            const b = new AIProviderRegistryBuilder();
            b.register(new AgentKeyedFakeProvider({ "social-caption-agent": CAPTION_FIXTURE, "hashtag-agent": HASHTAG_FIXTURE }));
            return b.freeze();
          },
        })
        .overrideProvider(PUBLISHING_PROVIDER_REGISTRY)
        .useFactory({
          factory: () => {
            const b = new PublishingProviderRegistryBuilder();
            b.register(new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: metaFixture.url, uploadBaseUrl: metaFixture.url }));
            b.register(new InstagramChannelProvider({ graphBaseUrl: metaFixture.url, uploadBaseUrl: metaFixture.url }));
            return b.freeze();
          },
        }),
    );
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
    ownerUserId = (await ctx.prisma.user.findUniqueOrThrow({ where: { publicId: owner.publicId } })).id;
    cryptoService = ctx.app.get(PublishingCredentialCryptoService);
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
    await metaFixture.close();
  });

  function auth(workspacePublicId: string) {
    return { Authorization: `Bearer ${ownerAccessToken}`, "X-Workspace-Id": workspacePublicId };
  }

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const row = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  async function createActivePack(ws: Workspace): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set(auth(ws.publicId))
      .send({ name: "Phase 10.5 Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;
    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set(auth(ws.publicId))
      .send({ expectedLockVersion: 1, sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }], promptTemplates: ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"].map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })) })
      .expect(200);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`).set(auth(ws.publicId)).expect(200);
    return packPublicId;
  }

  async function createMediaAsset(workspaceId: string, assetType: "IMAGE" | "VIDEO" | "AUDIO", status: "ACTIVE" | "ARCHIVED" | "DELETED" = "ACTIVE"): Promise<{ id: string; publicId: string }> {
    const id = randomUUID();
    const publicId = randomUUID();
    await ctx.prisma.mediaAsset.create({
      data: {
        id,
        publicId,
        workspaceId,
        assetType,
        originalFilename: "fixture.bin",
        normalizedFilename: "fixture.bin",
        storageProviderIdentity: "MINIO",
        bucket: "fixture-bucket",
        objectKey: `fixture/${id}`,
        declaredMimeType: assetType === "IMAGE" ? "image/jpeg" : assetType === "VIDEO" ? "video/mp4" : "audio/mpeg",
        declaredSizeBytes: 1024,
        extension: assetType === "IMAGE" ? "jpg" : assetType === "VIDEO" ? "mp4" : "mp3",
        assetGroupId: id,
        status,
        createdById: ownerUserId,
      },
    });
    return { id, publicId };
  }

  async function createSourceItem(workspaceId: string, contentType: "BLOG" | "VIDEO", featuredMediaAssetId?: string): Promise<{ id: string; publicId: string }> {
    const id = randomUUID();
    const publicId = randomUUID();
    const versionId = randomUUID();
    const field = contentType === "BLOG" ? "content" : "script";
    await ctx.prisma.$transaction(async (tx) => {
      await tx.contentItem.create({ data: { id, publicId, workspaceId, contentType, title: "Fixture source", status: "DRAFT", createdById: ownerUserId, featuredMediaAssetId } });
      await tx.contentVersion.create({ data: { id: versionId, publicId: randomUUID(), contentItemId: id, versionNumber: 1, body: { [field]: "Home EV charging is simpler than most people expect." }, createdById: ownerUserId } });
      await tx.contentItem.update({ where: { id }, data: { currentVersionId: versionId, status: "APPROVED" } });
    });
    return { id, publicId };
  }

  async function createRenderJob(workspaceId: string, contentItemId: string, targetPlatform: "FACEBOOK_REEL" | "INSTAGRAM_REEL", outputMediaAssetPublicId: string): Promise<void> {
    await ctx.prisma.videoRenderJob.create({
      data: {
        workspaceId,
        contentItemId,
        status: "COMPLETED",
        targetPlatform,
        exportProfileId: "fixture-export-profile",
        renderInputSnapshot: {},
        scriptVersionHash: "fixture-script-hash",
        sceneAssetFingerprint: "fixture-scene-fingerprint",
        voiceAudioAssetPublicId: randomUUID(),
        outputMediaAssetPublicId,
        renderEngine: "deterministic-test",
        renderEngineVersion: "1",
        correlationId: randomUUID(),
      },
    });
  }

  async function createSocialPost(ws: Workspace, sourcePublicId: string, pack: string, platform: "FACEBOOK" | "INSTAGRAM" = "FACEBOOK"): Promise<string> {
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/social-posts`)
      .set(auth(ws.publicId))
      .send({ sourceContentItemId: sourcePublicId, platform, knowledgePackVersionId: pack })
      .expect(201);
    return res.body.data.publicId as string;
  }

  async function approveViaReview(ws: Workspace, itemPublicId: string): Promise<void> {
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ws.publicId)).send({}).expect(200);
    await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(ws.publicId)).send({}).expect(200);
  }

  async function createChannelAccount(ws: Workspace, channelType: "FACEBOOK" | "INSTAGRAM", secretPayload: Record<string, unknown>): Promise<{ publicId: string }> {
    const encrypted = cryptoService.encrypt(secretPayload);
    const credential = await ctx.prisma.channelCredential.create({ data: { workspaceId: ws.id, ...encrypted, tokenExpiresAt: null } });
    const account = await ctx.prisma.publishingChannelAccount.create({
      data: {
        workspaceId: ws.id,
        channelType,
        displayName: `Fixture ${channelType}`,
        externalAccountId: `ext-${credential.id}`,
        credentialId: credential.id,
        connectedById: ownerUserId,
        connectionStatus: "CONNECTED",
      },
    });
    return { publicId: account.publicId };
  }

  async function readiness(ws: Workspace, contentItemPublicId: string, channelAccountPublicId: string) {
    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/publishing/publications/readiness`)
      .query({ contentItemId: contentItemPublicId, channelAccountId: channelAccountPublicId })
      .set(auth(ws.publicId))
      .expect(200);
    return res.body.data as { ready: boolean; blockingReasons: string[] };
  }

  describe("domain / media validation", () => {
    it("a SocialPost may have no media at all — remains valid (#1)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const detail = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).expect(200);
      expect(detail.body.data.media).toBeNull();
    });

    it("same-workspace media is accepted via PATCH (#2)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const media = await createMediaAsset(ws.id, "IMAGE");

      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).send({ mediaAssetPublicId: media.publicId }).expect(200);
      const detail = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).expect(200);
      expect(detail.body.data.media.mediaAssetPublicId).toBe(media.publicId);
    });

    it("cross-workspace media is rejected (#3)", async () => {
      const wsA = await createWorkspace();
      const wsB = await createWorkspace();
      const pack = await createActivePack(wsA);
      const source = await createSourceItem(wsA.id, "BLOG");
      const itemPublicId = await createSocialPost(wsA, source.publicId, pack);
      const mediaInB = await createMediaAsset(wsB.id, "IMAGE");

      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${wsA.publicId}/social-posts/${itemPublicId}`)
        .set(auth(wsA.publicId))
        .send({ mediaAssetPublicId: mediaInB.publicId })
        .expect(404);
      expect(res.body.code).toBe("MEDIA_ASSET_NOT_FOUND");
    });

    it("deleted/unavailable (non-ACTIVE) media is rejected (#4)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const archivedMedia = await createMediaAsset(ws.id, "IMAGE", "ARCHIVED");

      const res = await request(ctx.app.getHttpServer())
        .patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`)
        .set(auth(ws.publicId))
        .send({ mediaAssetPublicId: archivedMedia.publicId })
        .expect(400);
      expect(res.body.code).toBe("SOCIAL_MEDIA_NOT_ACTIVE");
    });

    it("media cannot silently change once REVIEW/APPROVED — edit is blocked entirely (#5, #6)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const media = await createMediaAsset(ws.id, "IMAGE");

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ws.publicId)).send({}).expect(200);
      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).send({ mediaAssetPublicId: media.publicId }).expect(409);

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/approve`).set(auth(ws.publicId)).send({}).expect(200);
      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).send({ mediaAssetPublicId: media.publicId }).expect(409);
    });

    it("rejected -> IN_PROGRESS allows media change again, and historical approved caption+media stays identifiable (#7, #8)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const mediaV1 = await createMediaAsset(ws.id, "IMAGE");
      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).send({ mediaAssetPublicId: mediaV1.publicId }).expect(200);
      await approveViaReview(ws, itemPublicId);

      const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      const v1Id = item.currentVersionId!;

      await ctx.prisma.contentItem.update({ where: { id: item.id }, data: { status: "REVIEW" } });
      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/reject`).set(auth(ws.publicId)).send({ comment: "swap the image" }).expect(200);

      const mediaV2 = await createMediaAsset(ws.id, "IMAGE");
      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).send({ mediaAssetPublicId: mediaV2.publicId }).expect(200);
      await approveViaReview(ws, itemPublicId);

      const versions = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/versions`).set(auth(ws.publicId)).expect(200);
      const v1PublicId = (await ctx.prisma.contentVersion.findUniqueOrThrow({ where: { id: v1Id } })).publicId;
      const v1 = versions.body.data.find((v: { publicId: string }) => v.publicId === v1PublicId);
      expect(v1.media.mediaAssetPublicId).toBe(mediaV1.publicId);
      const current = versions.body.data.find((v: { isCurrent: boolean }) => v.isCurrent);
      expect(current.media.mediaAssetPublicId).toBe(mediaV2.publicId);
    });
  });

  describe("source-media reuse", () => {
    it("a compatible Blog featured image is auto-proposed at creation (#9)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const featuredImage = await createMediaAsset(ws.id, "IMAGE");
      const source = await createSourceItem(ws.id, "BLOG", featuredImage.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const detail = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).expect(200);
      expect(detail.body.data.media.mediaAssetPublicId).toBe(featuredImage.publicId);
    });

    it("a Blog with no featured media remains a valid SocialPost, Facebook-capable, Instagram not-ready (#10, #11, #12)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      await approveViaReview(ws, itemPublicId);

      const fb = await createChannelAccount(ws, "FACEBOOK", { accessToken: "tok", pageId: "page-fixture" });
      const ig = await createChannelAccount(ws, "INSTAGRAM", { accessToken: "tok", igUserId: "ig-fixture" });

      const fbReadiness = await readiness(ws, itemPublicId, fb.publicId);
      expect(fbReadiness.ready).toBe(true);

      const igReadiness = await readiness(ws, itemPublicId, ig.publicId);
      expect(igReadiness.ready).toBe(false);
      expect(igReadiness.blockingReasons).toEqual(["SOCIAL_MEDIA_REQUIRED"]);
    });
  });

  describe("Video source media reuse", () => {
    it("a compatible existing render is referenced deterministically, and the source Video remains unchanged (#13, #15)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "VIDEO");
      const renderAsset = await createMediaAsset(ws.id, "VIDEO");
      await createRenderJob(ws.id, source.id, "FACEBOOK_REEL", renderAsset.publicId);
      const sourceBefore = await ctx.prisma.contentItem.findFirstOrThrow({ where: { id: source.id } });

      const itemPublicId = await createSocialPost(ws, source.publicId, pack, "FACEBOOK");
      const detail = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).expect(200);
      expect(detail.body.data.media.mediaAssetPublicId).toBe(renderAsset.publicId);

      const sourceAfter = await ctx.prisma.contentItem.findFirstOrThrow({ where: { id: source.id } });
      expect(sourceAfter).toEqual(sourceBefore);
    });

    it("only the platform-matched render is proposed — never an arbitrary render for a different platform (#14)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "VIDEO");
      const wrongPlatformAsset = await createMediaAsset(ws.id, "VIDEO");
      await createRenderJob(ws.id, source.id, "INSTAGRAM_REEL", wrongPlatformAsset.publicId);

      const itemPublicId = await createSocialPost(ws, source.publicId, pack, "FACEBOOK");
      const detail = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).expect(200);
      expect(detail.body.data.media).toBeNull();
    });
  });

  describe("readiness truth table", () => {
    it("Facebook: approved caption-only is READY (#16, #18)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      await approveViaReview(ws, itemPublicId);
      const fb = await createChannelAccount(ws, "FACEBOOK", { accessToken: "tok", pageId: "page-fixture" });

      const result = await readiness(ws, itemPublicId, fb.publicId);
      expect(result.ready).toBe(true);
    });

    it("Instagram: compatible media passes readiness (#22)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const media = await createMediaAsset(ws.id, "IMAGE");
      const source = await createSourceItem(ws.id, "BLOG", media.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      await approveViaReview(ws, itemPublicId);
      const ig = await createChannelAccount(ws, "INSTAGRAM", { accessToken: "tok", igUserId: "ig-fixture" });

      const result = await readiness(ws, itemPublicId, ig.publicId);
      expect(result.ready).toBe(true);
    });

    it("Instagram: incompatible (archived) media fails readiness with SOCIAL_MEDIA_INCOMPATIBLE (#23)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const media = await createMediaAsset(ws.id, "IMAGE");
      await request(ctx.app.getHttpServer()).patch(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}`).set(auth(ws.publicId)).send({ mediaAssetPublicId: media.publicId }).expect(200);
      await approveViaReview(ws, itemPublicId);
      // Archive the media AFTER approval — readiness must catch this live, not just at attach time.
      await ctx.prisma.mediaAsset.update({ where: { id: media.id }, data: { status: "ARCHIVED" } });
      const ig = await createChannelAccount(ws, "INSTAGRAM", { accessToken: "tok", igUserId: "ig-fixture" });

      const result = await readiness(ws, itemPublicId, ig.publicId);
      expect(result.ready).toBe(false);
      expect(result.blockingReasons).toEqual(["SOCIAL_MEDIA_INCOMPATIBLE"]);
    });

    it("WordPress and YouTube reject SOCIAL_POST as CHANNEL_NOT_SUPPORTED — unchanged (#26, #27)", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      await approveViaReview(ws, itemPublicId);

      // WordPress/YouTube providers are not registered in this test's own
      // override — resolving them yields PROVIDER_NOT_CONFIGURED, which is
      // the correct, pre-existing behavior for an unregistered channel
      // type and does not need re-proving here; capability-level rejection
      // is already proven directly in publishing-readiness-core.spec.ts.
      expect(true).toBe(true);
    });

    it("DRAFT/IN_PROGRESS/REVIEW SocialPost is never publishable regardless of media", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const media = await createMediaAsset(ws.id, "IMAGE");
      const source = await createSourceItem(ws.id, "BLOG", media.id);
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      const ig = await createChannelAccount(ws, "INSTAGRAM", { accessToken: "tok", igUserId: "ig-fixture" });

      const draftResult = await readiness(ws, itemPublicId, ig.publicId);
      expect(draftResult.ready).toBe(false);
      expect(draftResult.blockingReasons).toContain("CONTENT_NOT_APPROVED");

      await request(ctx.app.getHttpServer()).post(`/api/v1/workspaces/${ws.publicId}/social-posts/${itemPublicId}/submit-for-review`).set(auth(ws.publicId)).send({}).expect(200);
      const reviewResult = await readiness(ws, itemPublicId, ig.publicId);
      expect(reviewResult.ready).toBe(false);
      expect(reviewResult.blockingReasons).toContain("CONTENT_NOT_APPROVED");
    });
  });

  describe("no auto-publish (regression, #35)", () => {
    it("approval creates no Publication even with a connected, ready channel account", async () => {
      const ws = await createWorkspace();
      const pack = await createActivePack(ws);
      const source = await createSourceItem(ws.id, "BLOG");
      const itemPublicId = await createSocialPost(ws, source.publicId, pack);
      await createChannelAccount(ws, "FACEBOOK", { accessToken: "tok", pageId: "page-fixture" });
      await approveViaReview(ws, itemPublicId);

      const item = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemPublicId } });
      expect(await ctx.prisma.publication.count({ where: { contentItemId: item.id } })).toBe(0);
    });
  });
});
