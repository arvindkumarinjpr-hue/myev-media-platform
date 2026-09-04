import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { encryptPublishingCredential, PublishingProviderRegistryBuilder, YouTubeChannelProvider, startYouTubeFixtureServer, type YouTubeFixtureServer } from "@myev/shared";
import { MediaStorageService, PrismaService } from "@myev/worker-core";
import { AppModule } from "../src/app.module";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/publishing/publishing-provider-registry.module";
import { PublishingCredentialCryptoService } from "../src/publishing/publishing-credential-crypto.service";
import { PublishingExecutionService } from "../src/publishing/publishing-execution.service";

const FIXTURE_ACCESS_TOKEN = "fixture-access-token";
const FIXTURE_REFRESH_TOKEN = "fixture-refresh-token";
const FIXTURE_VIDEO_BYTES = Buffer.alloc(2048, 9);
// Deliberately a DIFFERENT, well-formed 64-hex-char key from the one this
// process is actually configured with (docker/docker-compose.yml + CI both
// configure PUBLISHING_CREDENTIAL_ENCRYPTION_KEY as 64 "1"s) — simulates a
// checkpoint encrypted under a rotated/foreign key.
const WRONG_HEX_KEY = "2".repeat(64);

/**
 * Module 9 Phase 9.5 pre-merge security correction — proves the
 * encrypted-checkpoint boundary in `PublishingExecutionService` end to
 * end against a real Postgres/Prisma + the real
 * `PublishingCredentialCryptoService`: a decryptable checkpoint resumes
 * correctly with zero duplicate upload (the crash/reconciliation case
 * this checkpoint mechanism exists for), and — the actual point of this
 * correction — every way a checkpoint can fail to decrypt/validate is
 * treated as a hard, blocking failure rather than silently falling
 * through to a fresh upload (which would risk a duplicate external
 * video). Mirrors publishing-youtube-integration.e2e-spec.ts's own
 * scaffolding; kept as a separate file since these scenarios seed
 * `PublishAttempt` rows directly rather than only observing them.
 */
describe("Worker (e2e) — Module 9 Phase 9.5 YouTube checkpoint encryption + decrypt-failure blocking", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let storage: MediaStorageService;
  let execution: PublishingExecutionService;
  let crypto: PublishingCredentialCryptoService;
  let fixtureServer: YouTubeFixtureServer;

  beforeAll(async () => {
    fixtureServer = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/channels")) return { status: 200, json: { items: [{ id: "UCfixture" }] } };
      if (req.path.startsWith("/videos?uploadType=resumable")) return { status: 200, headers: { Location: `${fixtureServer.url}/upload/session/fresh-upload` } };
      // Status-check PUT for the pre-seeded "already completed on
      // YouTube's side" checkpoint (Content-Range: bytes */total, no
      // body) — responds as if the upload had already finished, exactly
      // per Google's own documented resumable-upload behavior.
      if (req.path === "/upload/session/crash-recovered" && req.method === "PUT") return { status: 200, json: { id: "yt-crash-recovered-1" } };
      return { status: 500, json: { error: { message: `unexpected fixture request: ${req.method} ${req.path}` } } };
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
    const user = await prisma.user.create({ data: { email: `publishing-yt-checkpoint-sec-${suffix}@example.invalid`, fullName: "Publishing YouTube Checkpoint Security Test User", status: "ACTIVE" } });
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: `Publishing YT Checkpoint Sec WS ${suffix}`, slug: `publishing-yt-checkpoint-sec-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { id: workspace.id, publicId: workspace.publicId, userId: user.id };
  }

  async function createReadyVideoContentItem(ws: Workspace, userId: string): Promise<{ id: string; publicId: string }> {
    const suffix = randomUUID();
    const objectKey = `workspaces/${ws.id}/publishing-yt-checkpoint-sec-test/${suffix}.mp4`;
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
      data: { workspaceId: ws.id, channelType: "YOUTUBE", displayName: "Fixture YouTube (checkpoint security)", externalAccountId: `ext-${credential.id}`, credentialId: credential.id, connectedById: userId },
    });
    return { id: account.id, publicId: account.publicId };
  }

  async function createQueuedTarget(ws: Workspace, userId: string, contentItemId: string, channelAccountId: string) {
    const publication = await prisma.publication.create({ data: { workspaceId: ws.id, contentItemId, requestedById: userId } });
    return prisma.publicationTarget.create({
      data: { workspaceId: ws.id, publicationId: publication.id, contentItemId, channelAccountId, status: "QUEUED", idempotencyKey: `publish:${publication.publicId}:${randomUUID()}` },
    });
  }

  /** Seeds the exact `PUBLISHING -> PUBLISHING` checkpoint-marker row `loadPriorCheckpoint()` looks for, with an arbitrary already-persisted `detail`. Mirrors `saveCheckpoint()`'s own row shape without going through it — the whole point of these tests is to control what a PRIOR attempt left behind. */
  async function seedCheckpointRow(targetId: string, detail: unknown): Promise<void> {
    await prisma.publishAttempt.create({ data: { publicationTargetId: targetId, fromStatus: "PUBLISHING", toStatus: "PUBLISHING", detail: detail as never } });
  }

  async function setupReadyTarget() {
    const ws = await createTestWorkspace();
    const item = await createReadyVideoContentItem(ws, ws.userId);
    const channel = await createYouTubeChannelAccount(ws, ws.userId);
    const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);
    return { ws, target };
  }

  it("a valid encrypted checkpoint decrypts and resumes: zero new upload session created, zero duplicate video (crash-after-provider-success reconciliation)", async () => {
    const { ws, target } = await setupReadyTarget();
    const uploadSessionUri = `${fixtureServer.url}/upload/session/crash-recovered`;
    const encrypted = crypto.encrypt({ uploadSessionUri, totalBytes: FIXTURE_VIDEO_BYTES.length });
    await seedCheckpointRow(target.id, { checkpointType: "YOUTUBE_RESUMABLE_UPLOAD", encrypted });

    const requestCountBefore = fixtureServer.requests.length;
    const outcome = await execution.execute(ws.publicId, target.publicId);

    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.externalContentId).toBe("yt-crash-recovered-1");

    const requestsThisRun = fixtureServer.requests.slice(requestCountBefore);
    // The decrypted checkpoint's own session URI was used for the status
    // check (proves decryption actually worked and resumed correctly)...
    expect(requestsThisRun.some((r) => r.path === "/upload/session/crash-recovered" && r.method === "PUT")).toBe(true);
    // ...and no NEW upload session was ever created — zero duplicate.
    expect(requestsThisRun.some((r) => r.path.startsWith("/videos?uploadType=resumable"))).toBe(false);

    const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.status).toBe("PUBLISHED");
    expect(updated.externalContentId).toBe("yt-crash-recovered-1");
  });

  it("tampered checkpoint ciphertext fails safely: blocks with a permanent, non-leaking error and never starts a fresh upload", async () => {
    const { ws, target } = await setupReadyTarget();
    const secretSessionUri = `${fixtureServer.url}/upload/session/should-never-be-requested-tampered`;
    const encrypted = crypto.encrypt({ uploadSessionUri: secretSessionUri, totalBytes: FIXTURE_VIDEO_BYTES.length });
    const tamperedCiphertext = encrypted.ciphertext.slice(0, -4) + (encrypted.ciphertext.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    await seedCheckpointRow(target.id, { checkpointType: "YOUTUBE_RESUMABLE_UPLOAD", encrypted: { ...encrypted, ciphertext: tamperedCiphertext } });

    const requestCountBefore = fixtureServer.requests.length;
    const outcome = await execution.execute(ws.publicId, target.publicId);

    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.errorCode).toBe("PUBLISHING_CHECKPOINT_UNRECOVERABLE");
    expect(outcome.message).not.toContain(secretSessionUri);
    expect(outcome.message).not.toContain(tamperedCiphertext);

    const requestsThisRun = fixtureServer.requests.slice(requestCountBefore);
    expect(requestsThisRun.some((r) => r.path.startsWith("/upload/session/") || r.path.startsWith("/videos?uploadType=resumable"))).toBe(false);

    const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.lastErrorCode).toBe("PUBLISHING_CHECKPOINT_UNRECOVERABLE");
    expect(updated.lastErrorMessageSafe).not.toContain(secretSessionUri);

    const failedAttempt = await prisma.publishAttempt.findFirst({ where: { publicationTargetId: target.id, toStatus: "FAILED" } });
    expect(JSON.stringify(failedAttempt?.detail)).not.toContain(secretSessionUri);
  });

  it("a checkpoint encrypted under a different/wrong key fails safely and blocks rather than starting a fresh upload", async () => {
    const { ws, target } = await setupReadyTarget();
    const secretSessionUri = `${fixtureServer.url}/upload/session/should-never-be-requested-wrongkey`;
    const encrypted = encryptPublishingCredential({ uploadSessionUri: secretSessionUri, totalBytes: FIXTURE_VIDEO_BYTES.length }, WRONG_HEX_KEY);
    await seedCheckpointRow(target.id, { checkpointType: "YOUTUBE_RESUMABLE_UPLOAD", encrypted });

    const requestCountBefore = fixtureServer.requests.length;
    const outcome = await execution.execute(ws.publicId, target.publicId);

    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.errorCode).toBe("PUBLISHING_CHECKPOINT_UNRECOVERABLE");
    expect(outcome.message).not.toContain(secretSessionUri);

    const requestsThisRun = fixtureServer.requests.slice(requestCountBefore);
    expect(requestsThisRun.some((r) => r.path.startsWith("/upload/session/") || r.path.startsWith("/videos?uploadType=resumable"))).toBe(false);

    const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.lastErrorCode).toBe("PUBLISHING_CHECKPOINT_UNRECOVERABLE");
  });

  it("a checkpoint that decrypts but is structurally malformed (missing uploadSessionUri/totalBytes) fails safely and blocks rather than starting a fresh upload", async () => {
    const { ws, target } = await setupReadyTarget();
    // Encrypted with the REAL, correctly-configured key — decryption
    // itself succeeds; the payload just isn't a real checkpoint bag.
    const encrypted = crypto.encrypt({ unrelatedField: "not a checkpoint" });
    await seedCheckpointRow(target.id, { checkpointType: "YOUTUBE_RESUMABLE_UPLOAD", encrypted });

    const requestCountBefore = fixtureServer.requests.length;
    const outcome = await execution.execute(ws.publicId, target.publicId);

    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.errorCode).toBe("PUBLISHING_CHECKPOINT_UNRECOVERABLE");

    const requestsThisRun = fixtureServer.requests.slice(requestCountBefore);
    expect(requestsThisRun.some((r) => r.path.startsWith("/upload/session/") || r.path.startsWith("/videos?uploadType=resumable"))).toBe(false);

    const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.lastErrorCode).toBe("PUBLISHING_CHECKPOINT_UNRECOVERABLE");
  });

  it("a checkpoint row with an unrecognized envelope shape (not our checkpointType/encrypted structure) fails safely and blocks rather than starting a fresh upload", async () => {
    const { ws, target } = await setupReadyTarget();
    // Simulates a legacy plaintext row (pre-security-correction shape) or
    // any other unrecognized JSON — must never be treated as "no
    // checkpoint" (which would silently start a fresh upload).
    await seedCheckpointRow(target.id, { uploadSessionUri: `${fixtureServer.url}/upload/session/legacy-plaintext`, totalBytes: FIXTURE_VIDEO_BYTES.length });

    const requestCountBefore = fixtureServer.requests.length;
    const outcome = await execution.execute(ws.publicId, target.publicId);

    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.errorCode).toBe("PUBLISHING_CHECKPOINT_UNRECOVERABLE");

    const requestsThisRun = fixtureServer.requests.slice(requestCountBefore);
    expect(requestsThisRun.some((r) => r.path.startsWith("/upload/session/") || r.path.startsWith("/videos?uploadType=resumable"))).toBe(false);
  });
});
