import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { FacebookChannelProvider, InstagramChannelProvider, PublishingProviderRegistryBuilder, startMetaFixtureServer, type MetaFixtureServer } from "@myev/shared";
import { MediaStorageService, PrismaService } from "@myev/worker-core";
import { AppModule } from "../src/app.module";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/publishing/publishing-provider-registry.module";
import { PublishingCredentialCryptoService } from "../src/publishing/publishing-credential-crypto.service";
import { PublishingExecutionService } from "../src/publishing/publishing-execution.service";

const FACEBOOK_TOKEN = "fixture-facebook-page-token";
const INSTAGRAM_TOKEN = "fixture-instagram-token";
const FIXTURE_VIDEO_BYTES = Buffer.alloc(2048, 5);

/**
 * Module 9 Phase 9.6 — the "Integration" category test (Part AK): proves
 * the real FacebookChannelProvider/InstagramChannelProvider working end
 * to end through the existing, unmodified Phase 9.3 execution backbone —
 * real MinIO-backed bytes, the real PublishingMediaReaderService, the
 * real encrypted-checkpoint mechanism, and PUBLISHING_PROVIDER_REGISTRY
 * overridden with real provider instances pointed at a local
 * startMetaFixtureServer instance. Also proves the Part 8/J
 * target-platform-aware render resolution: each ContentItem's
 * VideoRenderJob fixture is created with the CHANNEL-MATCHED
 * targetPlatform (FACEBOOK_REEL / INSTAGRAM_REEL), never YouTube's
 * YOUTUBE_LONG, and readiness/execution correctly resolves it.
 */
describe("Worker (e2e) — Module 9 Phase 9.6 Meta connectors, real providers through the full execution backbone", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let storage: MediaStorageService;
  let execution: PublishingExecutionService;
  let crypto: PublishingCredentialCryptoService;
  let fixtureServer: MetaFixtureServer;

  beforeAll(async () => {
    fixtureServer = await startMetaFixtureServer((req) => {
      // Facebook: Page id lookup (readiness's own validateConnection).
      if (req.path === "/v25.0/fb-page-1?fields=id") return { status: 200, json: { id: "fb-page-1" } };
      if (req.path === "/v25.0/app-fixture/uploads") return { status: 200, json: { id: "upload:sess-int-1" } };
      if (req.path === "/upload:sess-int-1") return { status: 200, json: { h: "handle-int-1" } };
      if (req.path === "/v25.0/fb-page-1/videos") return { status: 200, json: { id: "fb-video-int-1" } };

      // Instagram: professional-account lookup + container/upload/poll/publish/permalink.
      if (req.path === "/v25.0/ig-user-1?fields=id,account_type") return { status: 200, json: { id: "ig-user-1", account_type: "BUSINESS" } };
      if (req.path === "/v25.0/ig-user-1/media") return { status: 200, json: { id: "container-int-1" } };
      if (req.path === "/ig-api-upload/container-int-1") return { status: 200, json: { success: true } };
      if (req.path === "/v25.0/container-int-1?fields=status_code") return { status: 200, json: { status_code: "FINISHED" } };
      if (req.path === "/v25.0/ig-user-1/media_publish") return { status: 200, json: { id: "ig-media-int-1" } };
      if (req.path === "/v25.0/ig-media-int-1?fields=permalink") return { status: 200, json: { permalink: "https://www.instagram.com/reel/int1/" } };

      return { status: 500, json: { error: { message: `unexpected fixture request: ${req.method} ${req.path}` } } };
    });

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PUBLISHING_PROVIDER_REGISTRY)
      .useFactory({
        factory: () => {
          const builder = new PublishingProviderRegistryBuilder();
          builder.register(new FacebookChannelProvider({ appId: "app-fixture", graphBaseUrl: fixtureServer.url, uploadBaseUrl: fixtureServer.url }));
          builder.register(new InstagramChannelProvider({ graphBaseUrl: fixtureServer.url, uploadBaseUrl: fixtureServer.url }));
          return builder.freeze();
        },
      })
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    storage = moduleRef.get(MediaStorageService);
    execution = moduleRef.get(PublishingExecutionService);
    crypto = moduleRef.get(PublishingCredentialCryptoService);
  });

  afterAll(async () => {
    await moduleRef.close();
    await fixtureServer.close();
  });

  interface Workspace {
    id: string;
    publicId: string;
  }

  async function createTestWorkspace(): Promise<Workspace & { userId: string }> {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `publishing-meta-integration-${suffix}@example.invalid`, fullName: "Publishing Meta Integration Test User", status: "ACTIVE" } });
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: `Publishing Meta Integration WS ${suffix}`, slug: `publishing-meta-integration-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { id: workspace.id, publicId: workspace.publicId, userId: user.id };
  }

  async function createReadyVideoContentItem(ws: Workspace, userId: string, targetPlatform: "FACEBOOK_REEL" | "INSTAGRAM_REEL"): Promise<{ id: string; publicId: string }> {
    const suffix = randomUUID();
    const objectKey = `workspaces/${ws.id}/publishing-meta-integration-test/${suffix}.mp4`;
    await storage.put(objectKey, FIXTURE_VIDEO_BYTES, "video/mp4");

    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.contentItem.create({ data: { workspaceId: ws.id, contentType: "VIDEO", title: `Ready reel ${suffix}`, status: "APPROVED", createdById: userId } });
      const version = await tx.contentVersion.create({ data: { contentItemId: created.id, versionNumber: 1, body: { script: "fixture" }, createdById: userId } });
      return tx.contentItem.update({ where: { id: created.id }, data: { currentVersionId: version.id, metadata: { publishing: { caption: "A great fixture caption." } } } });
    });

    const asset = await prisma.mediaAsset.create({
      data: {
        workspaceId: ws.id,
        contentItemId: item.id,
        assetType: "VIDEO",
        originalFilename: "fixture.mp4",
        normalizedFilename: "fixture.mp4",
        storageProviderIdentity: "MINIO",
        bucket: storage.bucket,
        objectKey,
        declaredMimeType: "video/mp4",
        declaredSizeBytes: FIXTURE_VIDEO_BYTES.length,
        verifiedMimeType: "video/mp4",
        verifiedSizeBytes: FIXTURE_VIDEO_BYTES.length,
        extension: "mp4",
        assetGroupId: randomUUID(),
        status: "ACTIVE",
        createdById: userId,
      },
    });

    await prisma.videoRenderJob.create({
      data: {
        workspaceId: ws.id,
        contentItemId: item.id,
        status: "COMPLETED",
        targetPlatform,
        exportProfileId: "fixture-export-profile",
        renderInputSnapshot: {},
        scriptVersionHash: "fixture-script-hash",
        sceneAssetFingerprint: "fixture-scene-fingerprint",
        voiceAudioAssetPublicId: randomUUID(),
        outputMediaAssetPublicId: asset.publicId,
        renderEngine: "deterministic-test",
        renderEngineVersion: "1",
        correlationId: randomUUID(),
        createdById: userId,
      },
    });

    return { id: item.id, publicId: item.publicId };
  }

  async function createChannelAccount(ws: Workspace, userId: string, channelType: "FACEBOOK" | "INSTAGRAM", credential: Record<string, unknown>): Promise<{ id: string; publicId: string }> {
    const encrypted = crypto.encrypt(credential);
    const record = await prisma.channelCredential.create({ data: { workspaceId: ws.id, ...encrypted, tokenExpiresAt: null } });
    const account = await prisma.publishingChannelAccount.create({
      data: { workspaceId: ws.id, channelType, displayName: `Fixture ${channelType}`, externalAccountId: `ext-${record.id}`, credentialId: record.id, connectedById: userId },
    });
    return { id: account.id, publicId: account.publicId };
  }

  async function createQueuedTarget(ws: Workspace, userId: string, contentItemId: string, channelAccountId: string) {
    const publication = await prisma.publication.create({ data: { workspaceId: ws.id, contentItemId, requestedById: userId } });
    return prisma.publicationTarget.create({
      data: { workspaceId: ws.id, publicationId: publication.id, contentItemId, channelAccountId, status: "QUEUED", idempotencyKey: `publish:${publication.publicId}:${randomUUID()}` },
    });
  }

  it("Facebook: QUEUED -> PUBLISHING -> PUBLISHED against the real FacebookChannelProvider, correct externalContentId, no externalUrl fabricated, encrypted checkpoint, no secret in PublishAttempt, ContentItem stays APPROVED", async () => {
    const ws = await createTestWorkspace();
    const item = await createReadyVideoContentItem(ws, ws.userId, "FACEBOOK_REEL");
    const channel = await createChannelAccount(ws, ws.userId, "FACEBOOK", { accessToken: FACEBOOK_TOKEN, pageId: "fb-page-1" });
    const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);

    const outcome = await execution.execute(ws.publicId, target.publicId);
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.externalContentId).toBe("fb-video-int-1");
    expect(outcome.externalUrl).toBeUndefined();

    const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.status).toBe("PUBLISHED");
    expect(updated.externalContentId).toBe("fb-video-int-1");

    const attempts = await prisma.publishAttempt.findMany({ where: { publicationTargetId: target.id }, orderBy: { occurredAt: "asc" } });
    const serializedAttempts = JSON.stringify(attempts);
    expect(serializedAttempts).not.toContain(FACEBOOK_TOKEN);

    const checkpointAttempts = attempts.filter((a) => a.fromStatus === "PUBLISHING" && a.toStatus === "PUBLISHING");
    expect(checkpointAttempts.length).toBeGreaterThan(0);
    for (const checkpointAttempt of checkpointAttempts) {
      const detail = checkpointAttempt.detail as Record<string, unknown>;
      expect(detail.checkpointType).toBe("FACEBOOK_PAGE_POST_ATTEMPT");
      expect(Object.keys(detail).sort()).toEqual(["checkpointType", "encrypted"]);
    }
    expect(serializedAttempts).not.toContain("sess-int-1");
    expect(serializedAttempts).not.toContain("handle-int-1");

    const contentItemAfter = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id }, select: { status: true } });
    expect(contentItemAfter.status).toBe("APPROVED");
  });

  it("Instagram: QUEUED -> PUBLISHING -> PUBLISHED against the real InstagramChannelProvider, correct externalContentId + externalUrl permalink, caption pass-through, encrypted checkpoint, no secret in PublishAttempt", async () => {
    const ws = await createTestWorkspace();
    const item = await createReadyVideoContentItem(ws, ws.userId, "INSTAGRAM_REEL");
    const channel = await createChannelAccount(ws, ws.userId, "INSTAGRAM", { accessToken: INSTAGRAM_TOKEN, igUserId: "ig-user-1" });
    const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);

    const outcome = await execution.execute(ws.publicId, target.publicId);
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.externalContentId).toBe("ig-media-int-1");
    expect(outcome.externalUrl).toBe("https://www.instagram.com/reel/int1/");

    const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.status).toBe("PUBLISHED");

    const attempts = await prisma.publishAttempt.findMany({ where: { publicationTargetId: target.id }, orderBy: { occurredAt: "asc" } });
    const serializedAttempts = JSON.stringify(attempts);
    expect(serializedAttempts).not.toContain(INSTAGRAM_TOKEN);
    expect(serializedAttempts).not.toContain("container-int-1");

    const checkpointAttempt = attempts.find((a) => a.fromStatus === "PUBLISHING" && a.toStatus === "PUBLISHING");
    expect(checkpointAttempt).toBeDefined();
    const detail = checkpointAttempt?.detail as Record<string, unknown>;
    expect(detail.checkpointType).toBe("INSTAGRAM_CONTAINER_UPLOAD");

    // Caption pass-through (Part R) — the fixture container-create request
    // actually carried the ContentItem.metadata.publishing.caption text.
    const containerReq = fixtureServer.requests.find((r) => r.path === "/v25.0/ig-user-1/media");
    expect((containerReq?.body as Record<string, unknown>).caption).toBe("A great fixture caption.");
  });

  it("a Facebook target and an Instagram target for sibling ContentItems in the SAME workspace do not interfere with each other", async () => {
    const ws = await createTestWorkspace();
    const fbItem = await createReadyVideoContentItem(ws, ws.userId, "FACEBOOK_REEL");
    const igItem = await createReadyVideoContentItem(ws, ws.userId, "INSTAGRAM_REEL");
    const fbChannel = await createChannelAccount(ws, ws.userId, "FACEBOOK", { accessToken: FACEBOOK_TOKEN, pageId: "fb-page-1" });
    const igChannel = await createChannelAccount(ws, ws.userId, "INSTAGRAM", { accessToken: INSTAGRAM_TOKEN, igUserId: "ig-user-1" });
    const fbTarget = await createQueuedTarget(ws, ws.userId, fbItem.id, fbChannel.id);
    const igTarget = await createQueuedTarget(ws, ws.userId, igItem.id, igChannel.id);

    const [fbOutcome, igOutcome] = await Promise.all([execution.execute(ws.publicId, fbTarget.publicId), execution.execute(ws.publicId, igTarget.publicId)]);

    expect(fbOutcome.kind).toBe("success");
    expect(igOutcome.kind).toBe("success");
    if (fbOutcome.kind !== "success" || igOutcome.kind !== "success") return;
    expect(fbOutcome.externalContentId).toBe("fb-video-int-1");
    expect(igOutcome.externalContentId).toBe("ig-media-int-1");

    const fbUpdated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: fbTarget.id } });
    const igUpdated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: igTarget.id } });
    expect(fbUpdated.status).toBe("PUBLISHED");
    expect(igUpdated.status).toBe("PUBLISHED");
  });
});
