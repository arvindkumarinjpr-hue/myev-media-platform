import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  MEDIA_IMAGE_GENERATE_V1_MANIFEST,
  MediaProviderError,
  MediaProviderErrorCode,
  PermanentProcessorError,
  type ImageAspectRatio,
  type ImageGenerationProviderRegistry,
  type MediaImageGenerateV1Payload,
  type MediaImageGenerateV1Result,
  type ProcessorContext,
  type ProcessorHandler,
} from "@myev/shared";
import type { Prisma } from "../../../../api/generated/prisma";
import { PrismaService } from "@myev/worker-core";
import { IMAGE_PROVIDER_REGISTRY } from "../../media-provider/media-provider-registry.module";
import { resolveImageProviderId } from "../../media-provider/media-provider-client-factory";
import { MediaAssetWriterService } from "@myev/worker-core";
import { ConfigService } from "@nestjs/config";
import type { WorkerConfig } from "../../config/configuration";

/**
 * Module 7 Phase 7.4 — `media.image-generate.v1` processor (MEDIA queue).
 * Generates one image via the configured image provider, persists it as
 * an ACTIVE MediaAsset, and records usage/cost on the media_jobs row. A
 * COMPLETED job never satisfies a Video gate on its own — the persisted
 * ACTIVE MediaAsset is the authority (the API reconciles from it).
 *
 * Mirrors `AiExecuteProcessor`: never creates the media_jobs row (the
 * API's MediaJobSubmissionService did), only ever advances an existing
 * one; atomic fenced claim on backgroundJobId; transient provider
 * failure reverts to QUEUED for Module 1F to reschedule.
 */
@Injectable()
export class MediaImageGenerateProcessor {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_PROVIDER_REGISTRY) private readonly registry: ImageGenerationProviderRegistry,
    private readonly writer: MediaAssetWriterService,
    private readonly config: ConfigService<WorkerConfig, true>,
    @InjectPinoLogger(MediaImageGenerateProcessor.name) private readonly logger: PinoLogger,
  ) {}

  readonly handle: ProcessorHandler<MediaImageGenerateV1Payload, MediaImageGenerateV1Result> = async (
    payload: MediaImageGenerateV1Payload,
    context: ProcessorContext,
  ): Promise<MediaImageGenerateV1Result> => {
    const job = await this.prisma.mediaJob.findFirst({ where: { publicId: payload.mediaJobPublicId } });
    if (!job) throw new PermanentProcessorError("MEDIA_JOB_NOT_FOUND", "Referenced media job does not exist.");
    if (["COMPLETED", "FAILED", "TIMED_OUT"].includes(job.status)) return { mediaJobPublicId: job.publicId };
    if (job.operation !== "IMAGE_GENERATE") throw new PermanentProcessorError("MEDIA_JOB_WRONG_OPERATION", "media job is not an image generation.");

    const claimed = await this.prisma.mediaJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: job.startedAt ?? new Date(), backgroundJobId: context.jobId },
    });
    if (claimed.count === 0) {
      this.logger.info({ mediaJobPublicId: job.publicId }, "media.image-generate.v1: already claimed — skipping");
      return { mediaJobPublicId: job.publicId };
    }

    const input = job.inputPayload as Record<string, unknown>;
    const prompt = String(input.prompt ?? "");
    const aspectRatio = (input.aspectRatio as ImageAspectRatio) ?? "16:9";
    const purpose = String(input.purpose ?? "scene");
    const existingAssetGroupId = typeof input.existingAssetGroupId === "string" ? input.existingAssetGroupId : null;
    if (!job.createdById) throw new PermanentProcessorError("MEDIA_JOB_NO_ACTOR", "media job has no creating user.");

    const providerId = resolveImageProviderId(this.registry, this.config.get("mediaProviders", { infer: true }));
    const provider = this.registry.resolve(providerId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_IMAGE_GENERATE_V1_MANIFEST.timeout - 5_000);
    try {
      const result = await provider.generate(
        { prompt, aspectRatio, styleGuidance: typeof input.styleGuidance === "string" ? input.styleGuidance : undefined, workspaceId: job.workspaceId, contentItemId: job.contentItemId ?? undefined, correlationId: job.correlationId },
        controller.signal,
      );
      clearTimeout(timeout);

      const written = await this.writer.write({
        workspaceId: job.workspaceId,
        contentItemId: job.contentItemId!,
        createdById: job.createdById,
        assetType: "IMAGE",
        body: result.imageBytes,
        declaredMimeType: result.mimeType,
        originalFilename: `${purpose}-${(input.sceneId as string) ?? "thumbnail"}`,
        assetGroupId: existingAssetGroupId,
        metadata: { provider: result.provider, model: result.model, width: result.width, height: result.height, purpose, prompt: prompt.slice(0, 500), correlationId: job.correlationId },
      });

      await this.prisma.mediaJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          providerUsed: result.provider,
          modelUsed: result.model,
          usageMetadata: (result.usage ?? null) as unknown as Prisma.InputJsonValue,
          ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
          outputPayload: { mediaAssetPublicId: written.publicId, mediaAssetGroupId: written.assetGroupId, width: result.width, height: result.height } as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      this.logger.info({ mediaJobPublicId: job.publicId, mediaAssetPublicId: written.publicId }, "media.image-generate.v1: completed");
      return { mediaJobPublicId: job.publicId };
    } catch (err) {
      clearTimeout(timeout);
      return this.onError(job.id, job.publicId, err, context, controller.signal.aborted);
    }
  };

  private async onError(jobId: string, jobPublicId: string, err: unknown, context: ProcessorContext, aborted: boolean): Promise<never> {
    if (err instanceof PermanentProcessorError) {
      await this.terminal(jobId, "FAILED", err.errorCode, err.errorMessageSafe);
      throw err;
    }
    const pe =
      err instanceof MediaProviderError
        ? err
        : new MediaProviderError(aborted ? MediaProviderErrorCode.TIMEOUT : MediaProviderErrorCode.UNKNOWN, "Image generation failed.", "unknown");
    const maxAttempts = MEDIA_IMAGE_GENERATE_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1;
    if (pe.retryable && context.attempt < maxAttempts) {
      await this.prisma.mediaJob.update({ where: { id: jobId }, data: { status: "QUEUED", errorCode: pe.code, errorMessageSafe: pe.messageSafe } });
      this.logger.warn({ mediaJobPublicId: jobPublicId, code: pe.code, attempt: context.attempt }, "media.image-generate.v1: transient failure — reverted to QUEUED");
      throw new Error(pe.messageSafe);
    }
    const status = pe.code === MediaProviderErrorCode.TIMEOUT ? "TIMED_OUT" : "FAILED";
    await this.terminal(jobId, status, pe.code, pe.messageSafe);
    throw new PermanentProcessorError(pe.code, pe.messageSafe);
  }

  private async terminal(jobId: string, status: "FAILED" | "TIMED_OUT", errorCode: string, errorMessageSafe: string): Promise<void> {
    await this.prisma.mediaJob.update({ where: { id: jobId }, data: { status, errorCode, errorMessageSafe: errorMessageSafe.slice(0, 500), completedAt: new Date() } });
  }
}
