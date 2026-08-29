import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  MEDIA_TTS_V1_MANIFEST,
  MediaProviderError,
  MediaProviderErrorCode,
  PermanentProcessorError,
  validateWordTimings,
  type MediaTtsV1Payload,
  type MediaTtsV1Result,
  type ProcessorContext,
  type ProcessorHandler,
  type TtsOutputFormat,
  type TtsProviderRegistry,
} from "@myev/shared";
import type { Prisma } from "../../../../api/generated/prisma";
import type { WorkerConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { TTS_PROVIDER_REGISTRY } from "../../media-provider/media-provider-registry.module";
import { resolveTtsProviderId } from "../../media-provider/media-provider-client-factory";
import { MediaAssetWriterService } from "../../media/media-asset-writer.service";
import { MediaStorageService } from "../../media/media-storage.service";

/**
 * Module 7 Phase 7.4 — `media.tts.v1` processor (MEDIA queue).
 * Synthesizes narration audio + word-level timings, persists an ACTIVE
 * AUDIO MediaAsset plus a word-timing sidecar JSON in object storage, and
 * records the sidecar key + duration on the media_jobs output.
 *
 * Gate #3 authority is the persisted ACTIVE audio asset + a non-empty
 * word-timing sidecar — never a COMPLETED job alone. A provider that
 * returns no timings is a permanent artifact failure (D3 requires them).
 */
@Injectable()
export class MediaTtsProcessor {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TTS_PROVIDER_REGISTRY) private readonly registry: TtsProviderRegistry,
    private readonly writer: MediaAssetWriterService,
    private readonly storage: MediaStorageService,
    private readonly config: ConfigService<WorkerConfig, true>,
    @InjectPinoLogger(MediaTtsProcessor.name) private readonly logger: PinoLogger,
  ) {}

  readonly handle: ProcessorHandler<MediaTtsV1Payload, MediaTtsV1Result> = async (payload: MediaTtsV1Payload, context: ProcessorContext): Promise<MediaTtsV1Result> => {
    const job = await this.prisma.mediaJob.findFirst({ where: { publicId: payload.mediaJobPublicId } });
    if (!job) throw new PermanentProcessorError("MEDIA_JOB_NOT_FOUND", "Referenced media job does not exist.");
    if (["COMPLETED", "FAILED", "TIMED_OUT"].includes(job.status)) return { mediaJobPublicId: job.publicId };
    if (job.operation !== "TTS") throw new PermanentProcessorError("MEDIA_JOB_WRONG_OPERATION", "media job is not a TTS job.");

    const claimed = await this.prisma.mediaJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: job.startedAt ?? new Date(), backgroundJobId: context.jobId },
    });
    if (claimed.count === 0) return { mediaJobPublicId: job.publicId };

    const input = job.inputPayload as Record<string, unknown>;
    const text = String(input.text ?? "");
    const voiceProfileId = String(input.voiceProfileId ?? "");
    const providerVoiceId = String(input.providerVoiceId ?? "");
    const language = String(input.language ?? "en-IN");
    const outputFormat = (input.outputFormat as TtsOutputFormat) ?? "mp3";
    const scriptVersionHash = String(input.scriptVersionHash ?? "");
    if (!text.trim()) throw new PermanentProcessorError("MEDIA_TTS_NO_TEXT", "TTS job has no narration text.");
    if (!job.createdById) throw new PermanentProcessorError("MEDIA_JOB_NO_ACTOR", "media job has no creating user.");

    const providerId = resolveTtsProviderId(this.registry, this.config.get("mediaProviders", { infer: true }));
    const provider = this.registry.resolve(providerId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_TTS_V1_MANIFEST.timeout - 5_000);
    try {
      const result = await provider.synthesize(
        { text, voiceProfileId, providerVoiceId, language, style: (input.style as "neutral") ?? "neutral", outputFormat, workspaceId: job.workspaceId, contentItemId: job.contentItemId ?? undefined, correlationId: job.correlationId },
        controller.signal,
      );
      clearTimeout(timeout);

      if (!result.wordTimings || result.wordTimings.length === 0) {
        throw new PermanentProcessorError("MEDIA_TTS_NO_TIMINGS", "TTS provider returned no word timings — cannot build subtitles.");
      }
      validateWordTimings(result.wordTimings);
      if (!(result.durationMs > 0)) {
        throw new PermanentProcessorError("MEDIA_TTS_NO_DURATION", "TTS produced audio with no measurable duration.");
      }

      const written = await this.writer.write({
        workspaceId: job.workspaceId,
        contentItemId: job.contentItemId!,
        createdById: job.createdById,
        assetType: "AUDIO",
        body: result.audioBytes,
        declaredMimeType: result.mimeType,
        originalFilename: `narration-${voiceProfileId}`,
        assetGroupId: null,
        metadata: {
          provider: result.provider,
          model: result.model,
          durationMs: result.durationMs,
          voiceProfileId,
          language,
          scriptVersionHash,
          characterCount: text.length,
          correlationId: job.correlationId,
        },
      });

      const timingKey = `${written.objectKey}.timings.json`;
      await this.storage.put(timingKey, Buffer.from(JSON.stringify({ durationMs: result.durationMs, words: result.wordTimings }), "utf8"), "application/json");

      await this.prisma.mediaJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          providerUsed: result.provider,
          modelUsed: result.model,
          usageMetadata: (result.usage ?? null) as unknown as Prisma.InputJsonValue,
          ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
          outputPayload: {
            audioAssetPublicId: written.publicId,
            wordTimingObjectKey: timingKey,
            durationMs: result.durationMs,
            scriptVersionHash,
            voiceProfileId,
          } as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      this.logger.info({ mediaJobPublicId: job.publicId, audioAssetPublicId: written.publicId, durationMs: result.durationMs, words: result.wordTimings.length }, "media.tts.v1: completed");
      return { mediaJobPublicId: job.publicId };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof PermanentProcessorError) {
        await this.terminal(job.id, "FAILED", err.errorCode, err.errorMessageSafe);
        throw err;
      }
      const pe = err instanceof MediaProviderError ? err : new MediaProviderError(controller.signal.aborted ? MediaProviderErrorCode.TIMEOUT : MediaProviderErrorCode.UNKNOWN, "TTS failed.", "unknown");
      const maxAttempts = MEDIA_TTS_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1;
      if (pe.retryable && context.attempt < maxAttempts) {
        await this.prisma.mediaJob.update({ where: { id: job.id }, data: { status: "QUEUED", errorCode: pe.code, errorMessageSafe: pe.messageSafe } });
        throw new Error(pe.messageSafe);
      }
      const status = pe.code === MediaProviderErrorCode.TIMEOUT ? "TIMED_OUT" : "FAILED";
      await this.terminal(job.id, status, pe.code, pe.messageSafe);
      throw new PermanentProcessorError(pe.code, pe.messageSafe);
    }
  };

  private async terminal(jobId: string, status: "FAILED" | "TIMED_OUT", errorCode: string, errorMessageSafe: string): Promise<void> {
    await this.prisma.mediaJob.update({ where: { id: jobId }, data: { status, errorCode, errorMessageSafe: errorMessageSafe.slice(0, 500), completedAt: new Date() } });
  }
}
