import { createHash, randomUUID } from "crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PermanentProcessorError, verifyMediaBytes, type VerifiableAssetType } from "@myev/shared";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { Prisma } from "../../../../apps/api/generated/prisma";
import type { WorkerCoreConfig } from "../config/worker-core-config";
import { PrismaService } from "../prisma/prisma.service";
import { MediaStorageService } from "./media-storage.service";
import { buildObjectKey, extractExtension, normalizeFilename } from "./object-key.util";

export interface WriteMediaAssetInput {
  workspaceId: string;
  contentItemId: string;
  createdById: string;
  assetType: VerifiableAssetType;
  body: Buffer;
  declaredMimeType: string;
  originalFilename: string;
  /** When set, this write is a new VERSION in an existing asset group (regeneration). */
  assetGroupId?: string | null;
  /** Extra provider/generation metadata to persist on the row. */
  metadata?: Record<string, unknown>;
}

export interface WrittenMediaAsset {
  publicId: string;
  assetGroupId: string;
  versionNumber: number;
  objectKey: string;
  verifiedMimeType: string;
  verifiedSizeBytes: number;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "text/vtt": ".vtt",
  "application/x-subrip": ".srt",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

/**
 * Module 7 Phase 7.4 — persists WORKER-ORIGINATED media bytes as an
 * ACTIVE MediaAsset. Distinct from apps/api's client-upload/verify flow:
 * the bytes are trusted provider output already in memory, so there is
 * no presigned round-trip and no untrusted-content verification window —
 * but magic bytes, size, and checksum are still verified server-side
 * before the row goes ACTIVE (fail-closed).
 */
@Injectable()
export class MediaAssetWriterService {
  private readonly maxBytesByType: Record<VerifiableAssetType, number>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    config: ConfigService<WorkerCoreConfig, true>,
    @InjectPinoLogger(MediaAssetWriterService.name) private readonly logger: PinoLogger,
  ) {
    const media = config.get("media", { infer: true });
    this.maxBytesByType = { IMAGE: media.maxImageBytes, AUDIO: media.maxAudioBytes, SUBTITLE: media.maxSubtitleBytes, VIDEO: media.maxVideoBytes };
  }

  async write(input: WriteMediaAssetInput): Promise<WrittenMediaAsset> {
    if (input.body.length === 0) {
      throw new PermanentProcessorError("MEDIA_EMPTY_OUTPUT", "Generated media has zero bytes.");
    }
    if (input.body.length > this.maxBytesByType[input.assetType]) {
      throw new PermanentProcessorError("MEDIA_TOO_LARGE", `Generated ${input.assetType} exceeds the size limit.`);
    }
    const verifiedMime = verifyMediaBytes(input.body, input.assetType, input.declaredMimeType);
    if (!verifiedMime) {
      throw new PermanentProcessorError("MEDIA_MIME_UNVERIFIED", `Generated ${input.assetType} bytes did not pass magic-byte verification.`);
    }

    const sha256 = createHash("sha256").update(input.body).digest("hex");

    // Resolve workspace + project public ids + version chain.
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: input.workspaceId }, select: { publicId: true } });
    const item = await this.prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { projectId: true } });
    const project = item.projectId ? await this.prisma.project.findUnique({ where: { id: item.projectId }, select: { publicId: true } }) : null;

    let assetGroupId = input.assetGroupId ?? null;
    let versionNumber = 1;
    let supersedesAssetId: string | null = null;
    if (assetGroupId) {
      const latest = await this.prisma.mediaAsset.findFirst({
        where: { assetGroupId },
        orderBy: { versionNumber: "desc" },
        select: { id: true, versionNumber: true, status: true },
      });
      if (latest) {
        versionNumber = latest.versionNumber + 1;
        supersedesAssetId = latest.status === "ACTIVE" ? latest.id : null;
      }
    }

    const assetId = randomUUID();
    if (!assetGroupId) assetGroupId = assetId;

    const ext = EXT_BY_MIME[verifiedMime] ?? extractExtension(input.originalFilename) ?? "";
    const normalizedFilename = normalizeFilename(input.originalFilename.endsWith(ext) ? input.originalFilename : `${input.originalFilename}${ext}`);
    const objectKey = buildObjectKey({
      workspacePublicId: workspace.publicId,
      projectPublicId: project?.publicId ?? null,
      assetType: input.assetType,
      assetId,
      versionNumber,
      normalizedFilename,
    });

    await this.storage.put(objectKey, input.body, verifiedMime);

    // The `media_assets_one_active_version_per_group` partial unique index
    // permits exactly one ACTIVE version per group — archive the previous
    // ACTIVE version (retained, never deleted — §17) in the same
    // transaction as the new one goes ACTIVE.
    const row = await this.prisma.$transaction(async (tx) => {
      if (supersedesAssetId) {
        await tx.mediaAsset.update({ where: { id: supersedesAssetId }, data: { status: "ARCHIVED", archivedAt: new Date() } });
      }
      return tx.mediaAsset.create({
        data: {
          id: assetId,
          workspaceId: input.workspaceId,
          projectId: item.projectId,
          contentItemId: input.contentItemId,
          assetType: input.assetType,
          originalFilename: input.originalFilename,
          normalizedFilename,
          storageProviderIdentity: this.storage.providerIdentity as "MINIO",
          bucket: this.storage.bucket,
          objectKey,
          declaredMimeType: input.declaredMimeType,
          declaredSizeBytes: BigInt(input.body.length),
          verifiedMimeType: verifiedMime,
          verifiedSizeBytes: BigInt(input.body.length),
          extension: ext || ".bin",
          expectedChecksumSha256: sha256,
          verifiedChecksumSha256: sha256,
          malwareScanStatus: "NOT_SCANNED",
          assetGroupId,
          versionNumber,
          supersedesAssetId,
          status: "ACTIVE",
          visibility: "WORKSPACE_PRIVATE",
          verifiedAt: new Date(),
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          createdById: input.createdById,
        },
        select: { publicId: true, assetGroupId: true, versionNumber: true },
      });
    });

    this.logger.info({ mediaAssetPublicId: row.publicId, assetType: input.assetType, versionNumber, objectKey }, "media asset written ACTIVE");
    return {
      publicId: row.publicId,
      assetGroupId: row.assetGroupId,
      versionNumber: row.versionNumber,
      objectKey,
      verifiedMimeType: verifiedMime,
      verifiedSizeBytes: input.body.length,
    };
  }
}
