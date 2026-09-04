import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { PublishingProviderRegistryBuilder, YouTubeChannelProvider, startYouTubeFixtureServer, type YouTubeFixtureServer } from "@myev/shared";
import { MediaStorageService, PrismaService } from "@myev/worker-core";
import { AppModule } from "../src/app.module";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/publishing/publishing-provider-registry.module";
import { PublishingCredentialCryptoService } from "../src/publishing/publishing-credential-crypto.service";
import { PublishingExecutionService } from "../src/publishing/publishing-execution.service";

const FIXTURE_ACCESS_TOKEN = "fixture-access-token";
const FIXTURE_REFRESH_TOKEN = "fixture-refresh-token";
const FIXTURE_VIDEO_BYTES = Buffer.alloc(2048, 9); // small on purpose (Part Z: no real large-video fixture needed).

/**
 * Module 9 Phase 9.5 — the "Integration" category test (Part AC/Z): proves
 * the real `YouTubeChannelProvider` (not FixturePublishingChannelProvider)
 * working end to end through the existing, unmodified Phase 9.3 execution
 * backbone — real MinIO-backed bytes, the real `PublishingMediaReaderService`
 * (chunked/bounded reads, never a full in-memory buffer), the real
 * resumable-upload checkpoint mechanism, and PUBLISHING_PROVIDER_REGISTRY
 * overridden with the real provider class pointed at a local
 * `startYouTubeFixtureServer` instance. A separate TestingModule/AppModule
 * bootstrap from publishing-execution.e2e-spec.ts's own (which uses the
 * fixture provider for every other Phase 9.3 test) — PublishingProviderRegistry
 * only allows one provider per channel type, so the real-provider case
 * needs its own module instance.
 */
describe("Worker (e2e) — Module 9 Phase 9.5 YouTube connector, real provider through the full execution backbone", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let storage: MediaStorageService;
  let execution: PublishingExecutionService;
  let crypto: PublishingCredentialCryptoService;
  let fixtureServer: YouTubeFixtureServer;

  beforeAll(async () => {
    fixtureServer = await startYouTubeFixtureServer((req) => {
      // Readiness's own connection-health check calls validateConnection()
      // (channels.list(mine=true)) before execute() ever reaches publish()
      // — must be handled or the whole attempt fails at readiness, never
      // even reaching the upload path below.
      if (req.path.startsWith("/channels")) return { status: 200, json: { items: [{ id: "UCfixture" }] } };
      if (req.path.startsWith("/videos?uploadType=resumable")) return { status: 200, headers: { Location: `${fixtureServer.url}/upload/session/it1` } };
      if (req.path === "/upload/session/it1") return { status: 201, json: { id: "yt-integration-1" } };
      return { status: 500, json: { error: { message: "unexpected fixture request" } } };
    });

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PUBLISHING_PROVIDER_REGISTRY)
      .useFactory({
        factory: () => {
          const builder = new PublishingProviderRegistryBuilder();
          builder.register(
            new YouTubeChannelProvider({
              oauthClientId: "fixture-client-id",
              oauthClientSecret: "fixture-client-secret",
              apiBaseUrl: fixtureServer.url,
              uploadBaseUrl: fixtureServer.url,
              oauthTokenEndpoint: fixtureServer.url,
            }),
          );
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
    const user = await prisma.user.create({ data: { email: `publishing-yt-integration-${suffix}@example.invalid`, fullName: "Publishing YouTube Integration Test User", status: "ACTIVE" } });
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: `Publishing YT Integration WS ${suffix}`, slug: `publishing-yt-integration-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { id: workspace.id, publicId: workspace.publicId, userId: user.id };
  }

  /** Puts real bytes into the SAME MinIO bucket MediaStorageService reads from, then creates the matching ACTIVE MediaAsset + a COMPLETED VideoRenderJob pointing at it — the exact chain readiness/execution/the real media reader all depend on. */
  async function createReadyVideoContentItem(ws: Workspace, userId: string): Promise<{ id: string; publicId: string }> {
    const suffix = randomUUID();
    const objectKey = `workspaces/${ws.id}/publishing-yt-integration-test/${suffix}.mp4`;
    await storage.put(objectKey, FIXTURE_VIDEO_BYTES, "video/mp4");

    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.contentItem.create({ data: { workspaceId: ws.id, contentType: "VIDEO", title: `Ready video ${suffix}`, status: "APPROVED", createdById: userId } });
      const version = await tx.contentVersion.create({ data: { contentItemId: created.id, versionNumber: 1, body: { script: "fixture" }, createdById: userId } });
      return tx.contentItem.update({ where: { id: created.id }, data: { currentVersionId: version.id } });
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
        targetPlatform: "YOUTUBE_LONG",
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

  async function createYouTubeChannelAccount(ws: Workspace, userId: string): Promise<{ id: string; publicId: string }> {
    const encrypted = crypto.encrypt({ accessToken: FIXTURE_ACCESS_TOKEN, refreshToken: FIXTURE_REFRESH_TOKEN });
    const credential = await prisma.channelCredential.create({ data: { workspaceId: ws.id, ...encrypted, tokenExpiresAt: new Date(Date.now() + 3_600_000) } });
    const account = await prisma.publishingChannelAccount.create({
      data: { workspaceId: ws.id, channelType: "YOUTUBE", displayName: "Fixture YouTube (real provider)", externalAccountId: `ext-${credential.id}`, credentialId: credential.id, connectedById: userId },
    });
    return { id: account.id, publicId: account.publicId };
  }

  async function createQueuedTarget(ws: Workspace, userId: string, contentItemId: string, channelAccountId: string) {
    const publication = await prisma.publication.create({ data: { workspaceId: ws.id, contentItemId, requestedById: userId } });
    return prisma.publicationTarget.create({
      data: { workspaceId: ws.id, publicationId: publication.id, contentItemId, channelAccountId, status: "QUEUED", idempotencyKey: `publish:${publication.publicId}:${randomUUID()}` },
    });
  }

  it("QUEUED -> PUBLISHING -> PUBLISHED against the real YouTubeChannelProvider + a local fixture server + real MinIO-backed chunked upload, external id/url persisted, no secret in PublishAttempt, ContentItem stays APPROVED", async () => {
    const ws = await createTestWorkspace();
    const item = await createReadyVideoContentItem(ws, ws.userId);
    const channel = await createYouTubeChannelAccount(ws, ws.userId);
    const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);

    const outcome = await execution.execute(ws.publicId, target.publicId);
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.externalContentId).toBe("yt-integration-1");
    expect(outcome.externalUrl).toBe("https://www.youtube.com/watch?v=yt-integration-1");

    const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.status).toBe("PUBLISHED");
    expect(updated.publishedAt).not.toBeNull();
    expect(updated.externalContentId).toBe("yt-integration-1");
    expect(updated.externalUrl).toBe("https://www.youtube.com/watch?v=yt-integration-1");

    const attempts = await prisma.publishAttempt.findMany({ where: { publicationTargetId: target.id }, orderBy: { occurredAt: "asc" } });
    const serializedAttempts = JSON.stringify(attempts);
    expect(serializedAttempts).not.toContain(FIXTURE_ACCESS_TOKEN);
    expect(serializedAttempts).not.toContain(FIXTURE_REFRESH_TOKEN);
    // The checkpoint row (saved BEFORE any byte upload) must carry only
    // the non-secret session URI/byte count — never the credential.
    const checkpointAttempt = attempts.find((a) => a.fromStatus === "PUBLISHING" && a.toStatus === "PUBLISHING");
    expect(checkpointAttempt).toBeDefined();
    expect(Object.keys(checkpointAttempt?.detail as Record<string, unknown>).sort()).toEqual(["totalBytes", "uploadSessionUri"]);
    // completeTarget() persists only { externalContentId, externalUrl } —
    // never the raw YouTube response verbatim (Part S).
    const publishedAttempt = attempts.find((a) => a.toStatus === "PUBLISHED");
    expect(Object.keys(publishedAttempt?.detail as Record<string, unknown>).sort()).toEqual(["externalContentId", "externalUrl"]);

    const contentItemAfter = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id }, select: { status: true } });
    expect(contentItemAfter.status).toBe("APPROVED");

    // The real bytes actually reached the fixture server's upload endpoint.
    const uploadRequest = fixtureServer.requests.find((r) => r.path === "/upload/session/it1");
    expect(uploadRequest?.body).toEqual(FIXTURE_VIDEO_BYTES);
    expect(uploadRequest?.headers.authorization).toBe(`Bearer ${FIXTURE_ACCESS_TOKEN}`);
  });
});
