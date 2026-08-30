import { createHash } from "crypto";
import { promises as fs } from "fs";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  MEDIA_VIDEO_RENDER_V1_MANIFEST,
  PermanentProcessorError,
  parseMp4,
  resolveExportProfile,
  validateVideoRenderInput,
  type MediaVideoRenderV1Payload,
  type MediaVideoRenderV1Result,
  type ProcessorContext,
  type ProcessorHandler,
  type VideoRenderInputV1,
} from "@myev/shared";
import type { Prisma } from "../../../../api/generated/prisma";
import type { WorkerConfig } from "../../config/configuration";
import { PrismaService } from "@myev/worker-core";
import { MediaAssetWriterService } from "@myev/worker-core";
import { MediaStorageService } from "@myev/worker-core";
import { RENDER_ENGINE, type MaterializedAsset, type RenderEngine } from "../../render/render-engine.interface";
import { RenderTempDir } from "../../render/render-temp";

/**
 * Module 7 Phase 7.5 — `media.video-render.v1` processor. Runs ONLY in
 * the dedicated render/media worker (WORKER_QUEUES includes MEDIA); the
 * general SYSTEM/AI worker never binds this handler (checkpoint §27).
 *
 * Flow (checkpoint §12): load the frozen render snapshot → validate →
 * materialize every private input asset into a job-scoped temp dir →
 * render via the configured engine → inspect the produced file → verify
 * geometry against the export profile → checksum → persist an ACTIVE
 * VIDEO MediaAsset → write the render-job output metadata → terminal
 * state. A COMPLETED job without a valid persisted VIDEO MediaAsset can
 * never satisfy Gate #4 — that is the API's reconciliation's job, not a
 * flag this processor sets.
 */
@Injectable()
export class VideoRenderProcessor {
  private readonly durationToleranceMs = 1500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    private readonly writer: MediaAssetWriterService,
    private readonly config: ConfigService<WorkerConfig, true>,
    @Inject(RENDER_ENGINE) private readonly engine: RenderEngine,
    @InjectPinoLogger(VideoRenderProcessor.name) private readonly logger: PinoLogger,
  ) {}

  readonly handle: ProcessorHandler<MediaVideoRenderV1Payload, MediaVideoRenderV1Result> = async (
    payload: MediaVideoRenderV1Payload,
    context: ProcessorContext,
  ): Promise<MediaVideoRenderV1Result> => {
    const job = await this.prisma.videoRenderJob.findFirst({ where: { publicId: payload.videoRenderJobPublicId } });
    if (!job) throw new PermanentProcessorError("VIDEO_RENDER_JOB_NOT_FOUND", "Referenced render job does not exist.");
    if (["COMPLETED", "FAILED", "TIMED_OUT"].includes(job.status)) return { videoRenderJobPublicId: job.publicId };

    const claimed = await this.prisma.videoRenderJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: job.startedAt ?? new Date(), backgroundJobId: context.jobId, attempt: { increment: 1 } },
    });
    if (claimed.count === 0) return { videoRenderJobPublicId: job.publicId };

    if (!job.createdById) throw new PermanentProcessorError("VIDEO_RENDER_NO_ACTOR", "Render job has no creating user.");

    const structural = validateVideoRenderInput(job.renderInputSnapshot);
    if (!structural.ok) {
      await this.terminal(job.id, "FAILED", "VIDEO_RENDER_INPUT_INVALID", `render snapshot invalid: ${structural.errors.slice(0, 3).join("; ")}`);
      throw new PermanentProcessorError("VIDEO_RENDER_INPUT_INVALID", "The frozen render input snapshot failed validation.");
    }
    const input = job.renderInputSnapshot as unknown as VideoRenderInputV1;
    const profile = resolveExportProfile(input.exportProfileId);
    const renderCfg = this.config.get("render", { infer: true });

    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: job.workspaceId }, select: { publicId: true } });
    const temp = await RenderTempDir.create(renderCfg.tempDir, job.publicId, workspace.publicId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_VIDEO_RENDER_V1_MANIFEST.timeout - 10_000);

    try {
      // --- Materialize every private input asset (checkpoint §16/§28) ---
      const assets: MaterializedAsset[] = [];
      const fetchOne = async (slot: string, objectKey: string, maxBytes: number): Promise<void> => {
        let bytes: Buffer;
        try {
          bytes = await this.storage.getBytes(objectKey, maxBytes, controller.signal);
        } catch (err) {
          const e = err as { message?: string; name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
          const status = e.$metadata?.httpStatusCode;
          const notFound =
            status === 404 ||
            e.name === "NoSuchKey" ||
            e.name === "NotFound" ||
            e.Code === "NoSuchKey" ||
            /no body|NoSuchKey|NotFound|not exist|404/i.test(e.message ?? "");
          if (notFound) {
            throw new PermanentProcessorError("VIDEO_RENDER_ASSET_MISSING", `A required render asset is missing from storage (${slot}).`);
          }
          throw new Error(`failed to materialize render asset (${slot}): ${e.message ?? "unknown"}`);
        }
        const localPath = temp.file(`${slot}-${objectKey.split("/").pop() ?? "asset"}`);
        await fs.writeFile(localPath, bytes);
        assets.push({ slot, objectKey, bytes, localPath });
      };

      for (const scene of input.scenes) await fetchOne(scene.sceneId, scene.asset.objectKey, this.config.get("media", { infer: true }).maxImageBytes);
      await fetchOne("audio", input.audio.objectKey, this.config.get("media", { infer: true }).maxAudioBytes);
      await fetchOne("subtitles", input.subtitles.objectKey, this.config.get("media", { infer: true }).maxSubtitleBytes);

      // --- Render ---
      const result = await this.engine.render(input, { workDir: temp.path, assets, signal: controller.signal });
      clearTimeout(timer);

      if (result.videoBytes.length === 0) throw new PermanentProcessorError("VIDEO_RENDER_EMPTY_OUTPUT", "The render produced no bytes.");
      if (result.videoBytes.length > renderCfg.maxOutputBytes) throw new PermanentProcessorError("VIDEO_RENDER_TOO_LARGE", "The rendered file exceeds the size limit.");

      // --- Inspect the ACTUAL produced file (checkpoint §13) ---
      const info = parseMp4(result.videoBytes);
      if (!info.ok || info.width === null || info.height === null || info.durationMs === null) {
        throw new PermanentProcessorError("VIDEO_RENDER_OUTPUT_INVALID", `Rendered file failed technical inspection: ${info.errors.join("; ")}`);
      }
      if (info.width !== profile.width || info.height !== profile.height) {
        throw new PermanentProcessorError("VIDEO_RENDER_RESOLUTION_MISMATCH", `Rendered ${info.width}x${info.height} does not match export profile ${profile.width}x${profile.height}.`);
      }
      if (Math.abs(info.durationMs - input.expectedDurationMs) > this.durationToleranceMs) {
        throw new PermanentProcessorError("VIDEO_RENDER_DURATION_MISMATCH", `Rendered duration ${info.durationMs}ms drifts from the expected ${input.expectedDurationMs}ms.`);
      }

      const checksum = createHash("sha256").update(result.videoBytes).digest("hex");

      // --- Persist as an ACTIVE VIDEO MediaAsset (new version chain per re-render) ---
      const priorGroup = await this.prisma.videoRenderJob.findFirst({
        where: { workspaceId: job.workspaceId, contentItemId: job.contentItemId, status: "COMPLETED", outputMediaAssetGroupId: { not: null }, id: { not: job.id } },
        orderBy: { completedAt: "desc" },
        select: { outputMediaAssetGroupId: true },
      });

      const written = await this.writer.write({
        workspaceId: job.workspaceId,
        contentItemId: job.contentItemId,
        createdById: job.createdById,
        assetType: "VIDEO",
        body: result.videoBytes,
        declaredMimeType: result.mimeType,
        originalFilename: `render-${input.exportProfileId.toLowerCase()}`,
        assetGroupId: priorGroup?.outputMediaAssetGroupId ?? null,
        metadata: {
          renderJobPublicId: job.publicId,
          exportProfileId: input.exportProfileId,
          width: info.width,
          height: info.height,
          durationMs: info.durationMs,
          fps: input.fps,
          videoCodec: result.videoCodec,
          audioCodec: result.audioCodec,
          container: result.container,
          renderEngine: result.engine,
          renderEngineVersion: result.engineVersion,
          renderInputVersion: job.renderInputVersion,
          scriptVersionHash: job.scriptVersionHash,
          correlationId: job.correlationId,
        },
      });

      await this.prisma.videoRenderJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          outputMediaAssetPublicId: written.publicId,
          outputMediaAssetGroupId: written.assetGroupId,
          outputWidth: info.width,
          outputHeight: info.height,
          outputDurationMs: info.durationMs,
          outputFps: input.fps,
          outputByteSize: BigInt(result.videoBytes.length),
          outputChecksumSha256: checksum,
          outputContainer: result.container,
          outputVideoCodec: result.videoCodec,
          outputAudioCodec: result.audioCodec,
          renderEngine: result.engine,
          renderEngineVersion: result.engineVersion,
          completedAt: new Date(),
        } as Prisma.VideoRenderJobUpdateInput,
      });

      this.logger.info(
        { videoRenderJobPublicId: job.publicId, outputMediaAssetPublicId: written.publicId, width: info.width, height: info.height, durationMs: info.durationMs, engine: result.engine },
        "media.video-render.v1: completed",
      );
      return { videoRenderJobPublicId: job.publicId };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof PermanentProcessorError) {
        await this.terminal(job.id, "FAILED", err.errorCode, err.errorMessageSafe);
        throw err;
      }
      const timedOut = controller.signal.aborted;
      const maxAttempts = MEDIA_VIDEO_RENDER_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1;
      if (!timedOut && context.attempt < maxAttempts) {
        // FR-VID-007: a transient failure re-queues (resume-not-restart —
        // a fresh attempt re-materializes and re-renders; no partial state
        // is trusted).
        await this.prisma.videoRenderJob.update({ where: { id: job.id }, data: { status: "QUEUED", errorCode: "VIDEO_RENDER_TRANSIENT", errorMessageSafe: (err as Error).message.slice(0, 400) } });
        throw err instanceof Error ? err : new Error("render failed");
      }
      await this.terminal(job.id, timedOut ? "TIMED_OUT" : "FAILED", timedOut ? "VIDEO_RENDER_TIMEOUT" : "VIDEO_RENDER_FAILED", timedOut ? "The render exceeded its time limit." : "The render failed.");
      throw new PermanentProcessorError(timedOut ? "VIDEO_RENDER_TIMEOUT" : "VIDEO_RENDER_FAILED", timedOut ? "The render exceeded its time limit." : "The render failed.");
    } finally {
      await temp.cleanup();
    }
  };

  private async terminal(jobId: string, status: "FAILED" | "TIMED_OUT", errorCode: string, errorMessageSafe: string): Promise<void> {
    await this.prisma.videoRenderJob.update({
      where: { id: jobId },
      data: { status, errorCode, errorMessageSafe: errorMessageSafe.slice(0, 500), completedAt: new Date() },
    });
  }
}
