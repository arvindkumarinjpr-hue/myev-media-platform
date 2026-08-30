import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  PermanentProcessorError,
  SubtitleAlignmentError,
  WordTimingValidationError,
  buildSubtitles,
  type MediaSubtitleGenerateV1Payload,
  type MediaSubtitleGenerateV1Result,
  type ProcessorContext,
  type ProcessorHandler,
  type WordTiming,
} from "@myev/shared";
import type { Prisma } from "../../../../api/generated/prisma";
import { PrismaService } from "@myev/worker-core";
import { MediaAssetWriterService } from "@myev/worker-core";
import { MediaStorageService } from "@myev/worker-core";

/**
 * Module 7 Phase 7.4 — `media.subtitle-generate.v1` processor (MEDIA
 * queue). Deterministic: no AI, no STT. Reads the approved script text +
 * the voice artifact's word-timing sidecar, runs `buildSubtitles`, and
 * persists ACTIVE SRT + VTT MediaAssets. An alignment or timing-
 * validation failure is a PERMANENT failure — never a silent guess.
 */
@Injectable()
export class MediaSubtitleGenerateProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: MediaAssetWriterService,
    private readonly storage: MediaStorageService,
    @InjectPinoLogger(MediaSubtitleGenerateProcessor.name) private readonly logger: PinoLogger,
  ) {}

  readonly handle: ProcessorHandler<MediaSubtitleGenerateV1Payload, MediaSubtitleGenerateV1Result> = async (
    payload: MediaSubtitleGenerateV1Payload,
    context: ProcessorContext,
  ): Promise<MediaSubtitleGenerateV1Result> => {
    const job = await this.prisma.mediaJob.findFirst({ where: { publicId: payload.mediaJobPublicId } });
    if (!job) throw new PermanentProcessorError("MEDIA_JOB_NOT_FOUND", "Referenced media job does not exist.");
    if (["COMPLETED", "FAILED", "TIMED_OUT"].includes(job.status)) return { mediaJobPublicId: job.publicId };
    if (job.operation !== "SUBTITLE_GENERATE") throw new PermanentProcessorError("MEDIA_JOB_WRONG_OPERATION", "media job is not a subtitle job.");

    const claimed = await this.prisma.mediaJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: job.startedAt ?? new Date(), backgroundJobId: context.jobId },
    });
    if (claimed.count === 0) return { mediaJobPublicId: job.publicId };

    try {
      const input = job.inputPayload as Record<string, unknown>;
      const scriptText = String(input.scriptText ?? "");
      const audioAssetPublicId = String(input.audioAssetPublicId ?? "");
      if (!scriptText.trim()) throw new PermanentProcessorError("MEDIA_SUBTITLE_NO_SCRIPT", "Subtitle job has no script text.");
      if (!job.createdById) throw new PermanentProcessorError("MEDIA_JOB_NO_ACTOR", "media job has no creating user.");

      // The completed TTS job that produced this audio holds the sidecar key + duration.
      const ttsJob = await this.prisma.mediaJob.findFirst({
        where: { workspaceId: job.workspaceId, contentItemId: job.contentItemId, operation: "TTS", status: "COMPLETED", deletedAt: null, outputPayload: { path: ["audioAssetPublicId"], equals: audioAssetPublicId } },
        orderBy: { completedAt: "desc" },
      });
      const ttsOut = (ttsJob?.outputPayload ?? null) as Record<string, unknown> | null;
      const timingKey = ttsOut && typeof ttsOut.wordTimingObjectKey === "string" ? ttsOut.wordTimingObjectKey : null;
      if (!timingKey) throw new PermanentProcessorError("MEDIA_SUBTITLE_NO_TIMINGS", "No word-timing sidecar found for the current voice artifact.");

      const sidecarRaw = await this.storage.getText(timingKey);
      const sidecar = JSON.parse(sidecarRaw) as { durationMs: number; words: WordTiming[] };
      const built = buildSubtitles(scriptText, sidecar.words, { audioDurationMs: sidecar.durationMs });

      const srt = await this.writer.write({
        workspaceId: job.workspaceId,
        contentItemId: job.contentItemId!,
        createdById: job.createdById,
        assetType: "SUBTITLE",
        body: Buffer.from(built.srt, "utf8"),
        declaredMimeType: "application/x-subrip",
        originalFilename: "captions.srt",
        metadata: { format: "srt", cueCount: built.cueCount, sourceAudioAssetPublicId: audioAssetPublicId, correlationId: job.correlationId },
      });
      const vtt = await this.writer.write({
        workspaceId: job.workspaceId,
        contentItemId: job.contentItemId!,
        createdById: job.createdById,
        assetType: "SUBTITLE",
        body: Buffer.from(built.vtt, "utf8"),
        declaredMimeType: "text/vtt",
        originalFilename: "captions.vtt",
        metadata: { format: "vtt", cueCount: built.cueCount, sourceAudioAssetPublicId: audioAssetPublicId, correlationId: job.correlationId },
      });

      await this.prisma.mediaJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          providerUsed: "deterministic",
          outputPayload: { srtAssetPublicId: srt.publicId, vttAssetPublicId: vtt.publicId, cueCount: built.cueCount, sourceAudioAssetPublicId: audioAssetPublicId } as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      this.logger.info({ mediaJobPublicId: job.publicId, cueCount: built.cueCount }, "media.subtitle-generate.v1: completed");
      return { mediaJobPublicId: job.publicId };
    } catch (err) {
      const permanent =
        err instanceof PermanentProcessorError ||
        err instanceof SubtitleAlignmentError ||
        err instanceof WordTimingValidationError ||
        err instanceof SyntaxError; // malformed sidecar JSON
      const code = err instanceof PermanentProcessorError ? err.errorCode : "MEDIA_SUBTITLE_BUILD_FAILED";
      const message = err instanceof Error ? err.message : "subtitle build failed";
      if (permanent) {
        await this.prisma.mediaJob.update({ where: { id: job.id }, data: { status: "FAILED", errorCode: code, errorMessageSafe: message.slice(0, 500), completedAt: new Date() } });
        throw err instanceof PermanentProcessorError ? err : new PermanentProcessorError(code, message);
      }
      // Transient (e.g. storage read blip): revert to QUEUED for reschedule.
      await this.prisma.mediaJob.update({ where: { id: job.id }, data: { status: "QUEUED", errorCode: "MEDIA_SUBTITLE_TRANSIENT", errorMessageSafe: message.slice(0, 500) } });
      throw err instanceof Error ? err : new Error(message);
    }
  };
}
