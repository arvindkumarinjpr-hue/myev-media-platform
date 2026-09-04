import { Injectable } from "@nestjs/common";
import { PublishingProviderPermanentError, type PublishingMediaReader } from "@myev/shared";
import { MediaStorageService, PrismaService } from "@myev/worker-core";

/**
 * Module 9 Phase 9.5 — the ONE, workspace-scoped implementation of
 * `PublishingMediaReader` (packages/shared) this process supplies to a
 * real, byte-transferring connector (YouTube). Never given to a provider
 * directly — `PublishingExecutionService` constructs one per execution
 * call, scoped to that call's own already-authorized workspace, and
 * passes it through `PublishingExecutionCallbacks.mediaReader`.
 *
 * Every read resolves `mediaAssetPublicId` to a real, workspace-scoped,
 * ACTIVE `MediaAsset` row FIRST — never trusts a raw storage key from
 * anywhere else, and never accepts one from job payload data. The
 * resolved object key is cached for the lifetime of one reader instance
 * (one execution call) so a large video's many chunk reads only resolve
 * the MediaAsset row once, not once per chunk.
 */
@Injectable()
export class PublishingMediaReaderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
  ) {}

  createReader(workspaceId: string): PublishingMediaReader {
    const resolvedObjectKeys = new Map<string, string>();

    const resolveObjectKey = async (mediaAssetPublicId: string): Promise<string> => {
      const cached = resolvedObjectKeys.get(mediaAssetPublicId);
      if (cached) return cached;
      const asset = await this.prisma.mediaAsset.findFirst({ where: { workspaceId, publicId: mediaAssetPublicId, status: "ACTIVE" }, select: { objectKey: true } });
      if (!asset) {
        throw new PublishingProviderPermanentError(
          "PUBLISHING_MEDIA_ASSET_UNAVAILABLE",
          "The resolved media artifact is no longer an ACTIVE asset in this workspace.",
        );
      }
      resolvedObjectKeys.set(mediaAssetPublicId, asset.objectKey);
      return asset.objectKey;
    };

    return {
      headObject: async (mediaAssetPublicId) => {
        const objectKey = await resolveObjectKey(mediaAssetPublicId);
        return this.storage.headObject(objectKey);
      },
      readRange: async (mediaAssetPublicId, start, end) => {
        const objectKey = await resolveObjectKey(mediaAssetPublicId);
        return this.storage.getRange(objectKey, start, end);
      },
    };
  }
}
