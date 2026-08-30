import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Prisma } from "../../api/generated/prisma";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@myev/worker-core";
import { MediaImageGenerateProcessor } from "../src/queue/processors/media-image-generate.processor";
import { MediaTtsProcessor } from "../src/queue/processors/media-tts.processor";
import { MediaSubtitleGenerateProcessor } from "../src/queue/processors/media-subtitle-generate.processor";

/**
 * Module 7 Phase 7.4 — the three MEDIA processors against real Postgres +
 * MinIO, with the DETERMINISTIC FAKE providers (D7 — no real keys). Proves
 * the full processor path: claim → provider/deterministic generation →
 * verify → object write → ACTIVE MediaAsset → media_jobs terminal +
 * usage/output. Direct `.handle()` invocation (same technique as
 * ai-execute.e2e-spec.ts) — BullMQ scheduling is proven elsewhere.
 */
describe("Worker (e2e) — MEDIA processors (image / tts / subtitle)", () => {
  process.env.WORKER_QUEUES = "MEDIA";
  process.env.WORKER_APPLICATION_VERSION = "e2e-test";
  process.env.STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? "myev-media-test";

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let imageProc: MediaImageGenerateProcessor;
  let ttsProc: MediaTtsProcessor;
  let subProc: MediaSubtitleGenerateProcessor;

  let workspaceId: string;
  let userId: string;
  let contentItemId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    imageProc = moduleRef.get(MediaImageGenerateProcessor);
    ttsProc = moduleRef.get(MediaTtsProcessor);
    subProc = moduleRef.get(MediaSubtitleGenerateProcessor);

    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `media-proc-${suffix}@example.invalid`, fullName: "Media Proc E2E", status: "ACTIVE" } });
    userId = user.id;
    workspaceId = (
      await prisma.$transaction(async (tx) => {
        const w = await tx.workspace.create({ data: { name: `Media Proc WS ${suffix}`, slug: `mp-${suffix}`, ownerId: user.id, createdById: user.id } });
        await tx.workspaceSlugReservation.create({ data: { workspaceId: w.id, slug: w.slug } });
        return w;
      })
    ).id;
    // content_items has a deferred "must have a current_version_id at
    // commit" trigger — create the item + its first version + the pointer
    // in one transaction.
    contentItemId = await prisma.$transaction(async (tx) => {
      const item = await tx.contentItem.create({ data: { workspaceId, contentType: "VIDEO", title: "Proc test", status: "IN_PROGRESS", createdById: user.id, metadata: {} as Prisma.InputJsonValue } });
      const version = await tx.contentVersion.create({ data: { contentItemId: item.id, versionNumber: 1, body: {} as Prisma.InputJsonValue, createdById: user.id } });
      await tx.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
      return item.id;
    });
  });

  afterAll(async () => {
    // Best-effort teardown — a leftover fixture row never fails the suite.
    const swallow = (p: Promise<unknown>) => p.catch(() => undefined);
    await swallow(prisma.mediaAsset.deleteMany({ where: { workspaceId } }));
    await swallow(prisma.mediaJob.deleteMany({ where: { workspaceId } }));
    await swallow(prisma.backgroundJobHistory.deleteMany({ where: { backgroundJob: { workspaceId } } }));
    await swallow(prisma.backgroundJob.deleteMany({ where: { workspaceId } }));
    await swallow(
      prisma.$transaction(async (tx) => {
        await tx.contentItem.update({ where: { id: contentItemId }, data: { currentVersionId: null } });
        await tx.contentVersion.deleteMany({ where: { contentItemId } });
        await tx.contentItem.delete({ where: { id: contentItemId } });
      }),
    );
    await swallow(prisma.$executeRaw`UPDATE workspaces SET slug_reservation_id = NULL WHERE id = ${workspaceId}::uuid`);
    await swallow(prisma.workspaceSlugReservation.deleteMany({ where: { workspaceId } }));
    await swallow(prisma.workspace.deleteMany({ where: { id: workspaceId } }));
    await swallow(prisma.user.deleteMany({ where: { id: userId } }));
    await moduleRef.close();
  });

  function ctx(jobId: string, attempt = 1) {
    return { jobId, correlationId: randomUUID(), attempt, isCancelled: async () => false };
  }

  const jobToBg = new Map<string, string>();

  async function createJob(operation: "IMAGE_GENERATE" | "TTS" | "SUBTITLE_GENERATE", inputPayload: Record<string, unknown>) {
    const media = await prisma.mediaJob.create({
      data: { workspaceId, contentItemId, operation, status: "QUEUED", correlationId: randomUUID(), inputPayload: inputPayload as Prisma.InputJsonValue, createdById: userId },
    });
    // The processor writes `backgroundJobId = context.jobId` on claim — it must reference a real row.
    const bg = await prisma.backgroundJob.create({
      data: { workspaceId, jobType: `media.${operation.toLowerCase()}.v1`, queueName: "MEDIA", payloadMetadata: { mediaJobPublicId: media.publicId } as Prisma.InputJsonValue, maxAttempts: 3, correlationId: media.correlationId, createdById: userId },
    });
    jobToBg.set(media.publicId, bg.id);
    return media;
  }
  const bgId = (mediaPublicId: string) => jobToBg.get(mediaPublicId)!;

  it("media.image-generate.v1: generates → verifies → writes an ACTIVE IMAGE MediaAsset + records usage", async () => {
    const job = await createJob("IMAGE_GENERATE", { purpose: "scene", sceneId: "scene-1", prompt: "an EV charging at dawn", aspectRatio: "16:9" });
    await imageProc.handle({ mediaJobPublicId: job.publicId }, ctx(bgId(job.publicId)));

    const done = await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe("COMPLETED");
    const out = done.outputPayload as Record<string, unknown>;
    const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { publicId: out.mediaAssetPublicId as string } });
    expect(asset.status).toBe("ACTIVE");
    expect(asset.assetType).toBe("IMAGE");
    expect(asset.verifiedMimeType).toBe("image/png");
    expect(asset.verifiedChecksumSha256).toBeTruthy();
    expect(done.usageMetadata).toMatchObject({ imageCount: 1 });
  });

  it("media.tts.v1: synthesizes → writes ACTIVE AUDIO + a word-timing sidecar; records duration", async () => {
    const job = await createJob("TTS", { text: "Charging at home is cheaper than petrol in India.", voiceProfileId: "en-in-neerja", providerVoiceId: "en-IN-NeerjaNeural", language: "en-IN", outputFormat: "wav", scriptVersionHash: "abc123" });
    await ttsProc.handle({ mediaJobPublicId: job.publicId }, ctx(bgId(job.publicId)));

    const done = await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe("COMPLETED");
    const out = done.outputPayload as Record<string, unknown>;
    expect(out.wordTimingObjectKey).toEqual(expect.stringContaining(".timings.json"));
    expect(out.durationMs).toBeGreaterThan(0);
    const audio = await prisma.mediaAsset.findFirstOrThrow({ where: { publicId: out.audioAssetPublicId as string } });
    expect(audio.assetType).toBe("AUDIO");
    expect(audio.status).toBe("ACTIVE");
  });

  it("media.subtitle-generate.v1: builds SRT + VTT deterministically from the voice sidecar", async () => {
    const ttsJob = await createJob("TTS", { text: "One two three four five six seven eight nine ten.", voiceProfileId: "en-in-neerja", providerVoiceId: "en-IN-NeerjaNeural", language: "en-IN", outputFormat: "wav", scriptVersionHash: "h" });
    await ttsProc.handle({ mediaJobPublicId: ttsJob.publicId }, ctx(bgId(ttsJob.publicId)));
    const ttsOut = (await prisma.mediaJob.findUniqueOrThrow({ where: { id: ttsJob.id } })).outputPayload as Record<string, unknown>;

    const subJob = await createJob("SUBTITLE_GENERATE", { scriptText: "One two three four five six seven eight nine ten.", audioAssetPublicId: ttsOut.audioAssetPublicId });
    await subProc.handle({ mediaJobPublicId: subJob.publicId }, ctx(bgId(subJob.publicId)));

    const done = await prisma.mediaJob.findUniqueOrThrow({ where: { id: subJob.id } });
    expect(done.status).toBe("COMPLETED");
    const out = done.outputPayload as Record<string, unknown>;
    const srt = await prisma.mediaAsset.findFirstOrThrow({ where: { publicId: out.srtAssetPublicId as string } });
    const vtt = await prisma.mediaAsset.findFirstOrThrow({ where: { publicId: out.vttAssetPublicId as string } });
    expect(srt.assetType).toBe("SUBTITLE");
    expect(srt.verifiedMimeType).toBe("application/x-subrip");
    expect(vtt.verifiedMimeType).toBe("text/vtt");
    expect(out.cueCount).toBeGreaterThan(0);
  });

  it("a COMPLETED media job is an idempotent no-op on redelivery (no second asset)", async () => {
    const job = await createJob("IMAGE_GENERATE", { purpose: "thumbnail", prompt: "p", aspectRatio: "16:9" });
    await imageProc.handle({ mediaJobPublicId: job.publicId }, ctx(bgId(job.publicId)));
    const assetsAfter1 = await prisma.mediaAsset.count({ where: { workspaceId } });
    await imageProc.handle({ mediaJobPublicId: job.publicId }, ctx(bgId(job.publicId)));
    expect(await prisma.mediaAsset.count({ where: { workspaceId } })).toBe(assetsAfter1);
  });

  it("scene-plan regeneration precedent: a fresh IMAGE version supersedes the previous one in the same asset group", async () => {
    const job1 = await createJob("IMAGE_GENERATE", { purpose: "scene", sceneId: "scene-x", prompt: "v1", aspectRatio: "16:9" });
    await imageProc.handle({ mediaJobPublicId: job1.publicId }, ctx(bgId(job1.publicId)));
    const out1 = (await prisma.mediaJob.findUniqueOrThrow({ where: { id: job1.id } })).outputPayload as Record<string, unknown>;
    const groupId = out1.mediaAssetGroupId as string;

    const job2 = await createJob("IMAGE_GENERATE", { purpose: "scene", sceneId: "scene-x", prompt: "v2", aspectRatio: "16:9", existingAssetGroupId: groupId });
    await imageProc.handle({ mediaJobPublicId: job2.publicId }, ctx(bgId(job2.publicId)));

    const versions = await prisma.mediaAsset.findMany({ where: { assetGroupId: groupId }, orderBy: { versionNumber: "asc" } });
    expect(versions).toHaveLength(2);
    expect(versions[1].supersedesAssetId).toBe(versions[0].id);
    // Exactly one ACTIVE version per group — the previous one is ARCHIVED, not deleted (§17).
    expect(versions[0].status).toBe("ARCHIVED");
    expect(versions[1].status).toBe("ACTIVE");
  });
});
