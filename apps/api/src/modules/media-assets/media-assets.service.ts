import { randomUUID } from "crypto";
import { ConflictException, GoneException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  type MediaAssetStatus,
  type MediaAssetType,
  type MalwareScanStatus,
  type MediaStorageProviderIdentity,
} from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import type { AppConfig } from "../../config/configuration";
import { AuditService } from "../audit/audit.service";
import { AdaptiveProtectionService } from "../../common/rate-limit/adaptive-protection.service";
import { STORAGE_PROVIDER, type StorageProvider } from "../storage/storage-provider.interface";
import { MALWARE_SCAN_PROVIDER, type MalwareScanProvider } from "../malware-scan/malware-scan-provider.interface";
import { ALLOWED_MIME_BY_ASSET_TYPE, matchesExecutableSignature, resolveVerifiedMimeType, sniffMimeType } from "../storage/mime-signatures";
import { normalizeExpectedChecksum } from "../storage/checksum.util";
import { buildObjectKey, extractExtension, normalizeFilename } from "./object-key.util";
import type { CreateUploadIntentDto, CreateVersionUploadIntentDto } from "./dto/create-upload-intent.dto";
import type { UpdateMediaAssetDto } from "./dto/update-media-asset.dto";

interface RequestContext {
  ipAddress?: string;
}

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

const ASSET_TYPE_MAX_SIZE_CONFIG_KEY: Record<MediaAssetType, "image" | "audio" | "video" | "document"> = {
  IMAGE: "image",
  AUDIO: "audio",
  VIDEO: "video",
  DOCUMENT: "document",
};

/**
 * Narrowed P2002 check — see Module 1D Engineering Plan §Safeguard 1:
 * "map only the exact expected concurrency constraints ... do not
 * broadly map unrelated unique violations." Same helper shape already
 * proven in Module 1C.1's invitations.service.ts.
 */
function isExpectedUniqueViolation(error: unknown, columnSubstrings: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== UNIQUE_CONSTRAINT_VIOLATION) {
    return false;
  }
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return columnSubstrings.every((needle) =>
    targets.some((entry) => typeof entry === "string" && entry.toLowerCase().includes(needle.toLowerCase())),
  );
}

interface LockedAssetRow {
  id: string;
  publicId: string;
  workspaceId: string;
  projectId: string | null;
  assetType: MediaAssetType;
  originalFilename: string;
  normalizedFilename: string;
  objectKey: string;
  bucket: string;
  storageProviderIdentity: string;
  declaredMimeType: string;
  declaredSizeBytes: bigint;
  expectedChecksumSha256: string | null;
  assetGroupId: string;
  versionNumber: number;
  supersedesAssetId: string | null;
  status: MediaAssetStatus;
  presignedUrlExpiresAt: Date | null;
  verificationAttemptId: string | null;
  createdById: string;
}

const ASSET_ROW_COLUMNS = `
  id,
  public_id AS "publicId",
  workspace_id AS "workspaceId",
  project_id AS "projectId",
  asset_type AS "assetType",
  original_filename AS "originalFilename",
  normalized_filename AS "normalizedFilename",
  object_key AS "objectKey",
  bucket,
  storage_provider_identity AS "storageProviderIdentity",
  declared_mime_type AS "declaredMimeType",
  declared_size_bytes AS "declaredSizeBytes",
  expected_checksum_sha256 AS "expectedChecksumSha256",
  asset_group_id AS "assetGroupId",
  version_number AS "versionNumber",
  supersedes_asset_id AS "supersedesAssetId",
  status,
  presigned_url_expires_at AS "presignedUrlExpiresAt",
  verification_attempt_id AS "verificationAttemptId",
  created_by AS "createdById"
`;

// `partial` carries whatever was determined before a non-success outcome
// was reached — e.g. a checksum-mismatch rejection still knows the real
// computed checksum, useful for audit/debugging (plan §3: "the true
// checksum is still recorded"). Never used to imply the outcome passed.
interface PartialVerification {
  verifiedMimeType?: string;
  verifiedSizeBytes?: number;
  verifiedChecksumSha256?: string;
}

type VerificationOutcome =
  | { kind: "success"; verifiedMimeType: string; verifiedSizeBytes: number; verifiedChecksumSha256: string; malwareScanStatus: MalwareScanStatus }
  | ({ kind: "rejected"; reason: string } & PartialVerification)
  | ({ kind: "quarantined"; reason: string } & PartialVerification)
  | ({ kind: "retryable"; reason: string } & PartialVerification);

@Injectable()
export class MediaAssetsService {
  private readonly logger = new Logger(MediaAssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
    private readonly protection: AdaptiveProtectionService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(MALWARE_SCAN_PROVIDER) private readonly malwareScan: MalwareScanProvider,
  ) {}

  // ---------------------------------------------------------------------
  // Upload capabilities (Module 1D Engineering Plan — Final Approval
  // Candidate §7 ACR: clients/UI must see the real, effective ceiling,
  // never a hardcoded aspirational figure).
  // ---------------------------------------------------------------------
  getUploadCapabilities(): Array<{ assetType: MediaAssetType; frdMaxSizeBytes: number; effectiveMaxSizeBytes: number; allowedMimeTypes: string[] }> {
    const media = this.config.get("media", { infer: true });
    return (Object.keys(ASSET_TYPE_MAX_SIZE_CONFIG_KEY) as MediaAssetType[]).map((assetType) => {
      const frdMax = media.maxSizeBytes[ASSET_TYPE_MAX_SIZE_CONFIG_KEY[assetType]];
      return {
        assetType,
        frdMaxSizeBytes: frdMax,
        effectiveMaxSizeBytes: Math.min(frdMax, media.syncChecksumMaxBytes),
        allowedMimeTypes: ALLOWED_MIME_BY_ASSET_TYPE[assetType],
      };
    });
  }

  private effectiveMaxSizeBytes(assetType: MediaAssetType): number {
    const media = this.config.get("media", { infer: true });
    return Math.min(media.maxSizeBytes[ASSET_TYPE_MAX_SIZE_CONFIG_KEY[assetType]], media.syncChecksumMaxBytes);
  }

  // Which real-world service STORAGE_PROVIDER_IDENTITY currently claims
  // to be — stamped onto every row created while this config is active
  // (Module 1D Engineering Plan §7). Validated against the enum rather
  // than blindly cast, so a typo in the env var fails loudly here instead
  // of surfacing as an opaque Prisma error at insert time.
  private resolveStorageProviderIdentity(): MediaStorageProviderIdentity {
    const identity = this.config.get("media", { infer: true }).storageProviderIdentity;
    const valid: MediaStorageProviderIdentity[] = ["MINIO", "AWS_S3", "CLOUDFLARE_R2", "OTHER_S3_COMPATIBLE"];
    if ((valid as string[]).includes(identity)) return identity as MediaStorageProviderIdentity;
    throw new Error(`Invalid STORAGE_PROVIDER_IDENTITY "${identity}" — must be one of ${valid.join(", ")}.`);
  }

  // ---------------------------------------------------------------------
  // Upload intent — plain, new asset.
  // ---------------------------------------------------------------------
  async createUploadIntent(
    workspace: { id: string; publicId: string },
    userId: string,
    dto: CreateUploadIntentDto,
    context: RequestContext,
  ) {
    const rate = await this.protection.checkRateLimit(
      `media:upload-intent:user:${userId}:workspace:${workspace.id}`,
      this.config.get("media", { infer: true }).uploadIntent.limit,
      this.config.get("media", { infer: true }).uploadIntent.windowSeconds,
    );
    if (!rate.allowed) {
      throw new HttpException({ code: "RATE_LIMITED", message: "Too many upload requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
    }

    let projectInternalId: string | null = null;
    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({ where: { publicId: dto.projectId, workspaceId: workspace.id } });
      if (!project) throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
      projectInternalId = project.id;
    }

    const effectiveMax = this.effectiveMaxSizeBytes(dto.assetType);
    if (dto.declaredSizeBytes > effectiveMax) {
      throw new HttpException(
        {
          code: "MEDIA_ASSET_EXCEEDS_SYNC_VERIFICATION_LIMIT",
          message: `Declared size exceeds the effective ${dto.assetType} upload limit of ${effectiveMax} bytes.`,
        },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_MIME_BY_ASSET_TYPE, dto.assetType)) {
      throw new HttpException({ code: "MEDIA_ASSET_UNSUPPORTED_TYPE", message: "Unsupported asset type." }, HttpStatus.BAD_REQUEST);
    }

    let expectedChecksumSha256: string | undefined;
    if (dto.expectedChecksumSha256) {
      const normalized = normalizeExpectedChecksum(dto.expectedChecksumSha256);
      if (!normalized) {
        throw new HttpException(
          { code: "MEDIA_ASSET_INVALID_CHECKSUM_FORMAT", message: "expectedChecksumSha256 must be exactly 64 hexadecimal characters." },
          HttpStatus.BAD_REQUEST,
        );
      }
      expectedChecksumSha256 = normalized;
    }

    const projectPublicId = dto.projectId ?? null;
    const assetId = randomUUID();
    const normalizedFilename = normalizeFilename(dto.originalFilename);
    const objectKey = buildObjectKey({
      workspacePublicId: workspace.publicId,
      projectPublicId,
      assetType: dto.assetType,
      assetId,
      versionNumber: 1,
      normalizedFilename,
    });

    const media = this.config.get("media", { infer: true });
    const storageConfig = this.config.get("storage", { infer: true });
    // Local, purely cryptographic signing — no network I/O — safe to call
    // outside any transaction boundary concern.
    const instruction = await this.storage.createUploadInstruction({
      key: objectKey,
      declaredContentType: dto.declaredMimeType,
      minSizeBytes: 1,
      maxSizeBytes: effectiveMax,
      expiresInSeconds: media.uploadUrlTtlSeconds,
    });

    const created = await this.prisma.mediaAsset.create({
      data: {
        id: assetId,
        publicId: randomUUID(),
        workspaceId: workspace.id,
        projectId: projectInternalId,
        assetType: dto.assetType,
        originalFilename: dto.originalFilename,
        normalizedFilename,
        storageProviderIdentity: this.resolveStorageProviderIdentity(),
        bucket: storageConfig.bucket,
        objectKey,
        declaredMimeType: dto.declaredMimeType,
        declaredSizeBytes: BigInt(dto.declaredSizeBytes),
        extension: extractExtension(normalizedFilename),
        expectedChecksumSha256: expectedChecksumSha256 ?? null,
        assetGroupId: assetId,
        versionNumber: 1,
        status: "PENDING_UPLOAD",
        presignedUrlExpiresAt: instruction.expiresAt,
        createdById: userId,
      },
    });

    await this.audit.record({
      action: "MEDIA_ASSET_UPLOAD_INTENT_CREATED",
      actorUserId: userId,
      workspaceId: workspace.id,
      entityType: "media_asset",
      entityId: created.publicId,
      ipAddress: context.ipAddress,
    });

    return { assetPublicId: created.publicId, instruction };
  }

  // ---------------------------------------------------------------------
  // Version-replacement upload intent (Safeguard 1).
  // ---------------------------------------------------------------------
  async createVersionUploadIntent(
    workspace: { id: string; publicId: string },
    userId: string,
    targetAssetPublicId: string,
    dto: CreateVersionUploadIntentDto,
    context: RequestContext,
  ) {
    const media = this.config.get("media", { infer: true });
    const rate = await this.protection.checkRateLimit(
      `media:version-upload-intent:user:${userId}:workspace:${workspace.id}`,
      media.uploadIntent.limit,
      media.uploadIntent.windowSeconds,
    );
    if (!rate.allowed) {
      throw new HttpException({ code: "RATE_LIMITED", message: "Too many upload requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const targetLookup = await this.prisma.mediaAsset.findFirst({ where: { publicId: targetAssetPublicId, workspaceId: workspace.id } });
    if (!targetLookup) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });

    let expectedChecksumSha256: string | undefined;
    if (dto.expectedChecksumSha256) {
      const normalized = normalizeExpectedChecksum(dto.expectedChecksumSha256);
      if (!normalized) {
        throw new HttpException(
          { code: "MEDIA_ASSET_INVALID_CHECKSUM_FORMAT", message: "expectedChecksumSha256 must be exactly 64 hexadecimal characters." },
          HttpStatus.BAD_REQUEST,
        );
      }
      expectedChecksumSha256 = normalized;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Step 1: lock the current ACTIVE version / asset-group serialization point.
      const [current] = await tx.$queryRaw<LockedAssetRow[]>`
        SELECT ${Prisma.raw(ASSET_ROW_COLUMNS)} FROM media_assets WHERE id = ${targetLookup.id}::uuid FOR UPDATE
      `;
      // Step 2: confirm it is still the current version.
      if (!current || current.status !== "ACTIVE") {
        throw new ConflictException({ code: "MEDIA_ASSET_NOT_CURRENT_VERSION", message: "This is not the current active version of this asset." });
      }

      const effectiveMax = this.effectiveMaxSizeBytes(current.assetType);
      if (dto.declaredSizeBytes > effectiveMax) {
        throw new HttpException(
          {
            code: "MEDIA_ASSET_EXCEEDS_SYNC_VERIFICATION_LIMIT",
            message: `Declared size exceeds the effective ${current.assetType} upload limit of ${effectiveMax} bytes.`,
          },
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }

      // Step 3: confirm no non-terminal replacement already exists — a
      // friendly, proactive check. The partial unique index
      // media_assets_one_pending_replacement_per_group (Safeguard 1) is
      // the authoritative, race-proof backstop below.
      const existingReplacement = await tx.mediaAsset.findFirst({
        where: { assetGroupId: current.assetGroupId, supersedesAssetId: { not: null }, status: { in: ["PENDING_UPLOAD", "VERIFYING"] } },
      });
      if (existingReplacement) {
        throw new ConflictException({ code: "MEDIA_ASSET_REPLACEMENT_IN_PROGRESS", message: "A replacement is already in progress for this asset." });
      }

      // Step 4: calculate the next version number. `current` is always
      // the highest version in its group — ACTIVE is kept in sync with
      // "latest" by the archive-old/activate-new finalize step.
      const nextVersionNumber = current.versionNumber + 1;

      // Step 5: insert the new PENDING_UPLOAD row.
      const newId = randomUUID();
      const normalizedFilename = normalizeFilename(dto.originalFilename);
      const currentProject = current.projectId ? await tx.project.findUnique({ where: { id: current.projectId } }) : null;
      const objectKey = buildObjectKey({
        workspacePublicId: workspace.publicId,
        projectPublicId: currentProject?.publicId ?? null,
        assetType: current.assetType,
        assetId: newId,
        versionNumber: nextVersionNumber,
        normalizedFilename,
      });
      const storageConfig = this.config.get("storage", { infer: true });
      const instruction = await this.storage.createUploadInstruction({
        key: objectKey,
        declaredContentType: dto.declaredMimeType,
        minSizeBytes: 1,
        maxSizeBytes: effectiveMax,
        expiresInSeconds: media.uploadUrlTtlSeconds,
      });

      let created;
      try {
        created = await tx.mediaAsset.create({
          data: {
            id: newId,
            publicId: randomUUID(),
            workspaceId: workspace.id,
            projectId: current.projectId,
            assetType: current.assetType,
            originalFilename: dto.originalFilename,
            normalizedFilename,
            storageProviderIdentity: this.resolveStorageProviderIdentity(),
            bucket: storageConfig.bucket,
            objectKey,
            declaredMimeType: dto.declaredMimeType,
            declaredSizeBytes: BigInt(dto.declaredSizeBytes),
            extension: extractExtension(normalizedFilename),
            expectedChecksumSha256: expectedChecksumSha256 ?? null,
            assetGroupId: current.assetGroupId,
            versionNumber: nextVersionNumber,
            supersedesAssetId: current.id,
            status: "PENDING_UPLOAD",
            presignedUrlExpiresAt: instruction.expiresAt,
            createdById: userId,
          },
        });
      } catch (error) {
        if (isExpectedUniqueViolation(error, ["asset_group_id", "supersedes_asset_id"])) {
          throw new ConflictException({ code: "MEDIA_ASSET_REPLACEMENT_IN_PROGRESS", message: "A replacement is already in progress for this asset." });
        }
        if (isExpectedUniqueViolation(error, ["asset_group_id", "version_number"])) {
          // Safeguard 1's version-number invariant caught a lost race the
          // proactive checks above didn't — same clean conflict, never a
          // raw constraint error.
          throw new ConflictException({ code: "MEDIA_ASSET_REPLACEMENT_IN_PROGRESS", message: "A replacement is already in progress for this asset." });
        }
        throw error;
      }

      await this.audit.recordWithinTransaction(tx, {
        action: "MEDIA_ASSET_VERSION_REPLACEMENT_STARTED",
        actorUserId: userId,
        workspaceId: workspace.id,
        entityType: "media_asset",
        entityId: created.publicId,
        ipAddress: context.ipAddress,
      });

      // Step 6: commit atomically — implicit.
      return { assetPublicId: created.publicId, instruction };
    });

    return result;
  }

  // ---------------------------------------------------------------------
  // Confirm upload — claim (Transaction 1) -> outside-transaction
  // verification -> finalize (Transaction 2). See Module 1D Engineering
  // Plan §4.
  // ---------------------------------------------------------------------
  async confirmUpload(workspace: { id: string }, userId: string, assetPublicId: string, context: RequestContext) {
    const targetLookup = await this.prisma.mediaAsset.findFirst({ where: { publicId: assetPublicId, workspaceId: workspace.id } });
    if (!targetLookup) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });

    const { row, attemptId } = await this.claimForVerification(targetLookup.id, ["PENDING_UPLOAD"], userId, context);
    const outcome = await this.runOutsideVerification(row);
    const finalRow = await this.finalizeVerification(row, attemptId, outcome, userId, context);
    return this.toResponse(finalRow);
  }

  // ---------------------------------------------------------------------
  // Retry verification (Safeguard 2) — no new storage upload instruction,
  // no re-upload. Same claim/finalize machinery, different starting
  // status.
  // ---------------------------------------------------------------------
  async retryVerification(workspace: { id: string }, userId: string, assetPublicId: string, context: RequestContext) {
    const media = this.config.get("media", { infer: true });
    const rate = await this.protection.checkRateLimit(
      `media:retry-verification:user:${userId}:workspace:${workspace.id}`,
      media.retryVerification.limit,
      media.retryVerification.windowSeconds,
    );
    if (!rate.allowed) {
      throw new HttpException({ code: "RATE_LIMITED", message: "Too many retry requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const targetLookup = await this.prisma.mediaAsset.findFirst({ where: { publicId: assetPublicId, workspaceId: workspace.id } });
    if (!targetLookup) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });

    const { row, attemptId } = await this.claimForVerification(targetLookup.id, ["VERIFICATION_FAILED"], userId, context, "MEDIA_ASSET_VERIFICATION_RETRIED");
    const outcome = await this.runOutsideVerification(row);
    const finalRow = await this.finalizeVerification(row, attemptId, outcome, userId, context);
    return this.toResponse(finalRow);
  }

  private async claimForVerification(
    assetId: string,
    fromStatuses: MediaAssetStatus[],
    userId: string,
    context: RequestContext,
    claimAuditAction: "MEDIA_ASSET_VERIFICATION_CLAIMED" | "MEDIA_ASSET_VERIFICATION_RETRIED" = "MEDIA_ASSET_VERIFICATION_CLAIMED",
  ): Promise<{ row: LockedAssetRow; attemptId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<LockedAssetRow[]>`
        SELECT ${Prisma.raw(ASSET_ROW_COLUMNS)} FROM media_assets WHERE id = ${assetId}::uuid FOR UPDATE
      `;
      if (!row) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });

      if (!fromStatuses.includes(row.status)) {
        if (row.status === "VERIFYING") {
          throw new ConflictException({ code: "MEDIA_ASSET_VERIFICATION_IN_PROGRESS", message: "Verification is already in progress for this asset." });
        }
        if (fromStatuses.includes("PENDING_UPLOAD")) {
          // confirm() called on something already confirmed once.
          throw new ConflictException({ code: "MEDIA_ASSET_ALREADY_CONFIRMED", message: "This asset has already been confirmed." });
        }
        // retryVerification() called on something not in VERIFICATION_FAILED.
        throw new ConflictException({
          code: "MEDIA_ASSET_NOT_RETRYABLE",
          message: "This asset is not in a retryable verification-failed state.",
        });
      }

      if (row.status === "PENDING_UPLOAD" && row.presignedUrlExpiresAt && row.presignedUrlExpiresAt < new Date()) {
        throw new GoneException({ code: "MEDIA_ASSET_UPLOAD_EXPIRED", message: "The upload window for this asset has expired." });
      }

      const attemptId = randomUUID();
      await tx.mediaAsset.update({
        where: { id: row.id },
        data: { status: "VERIFYING", verificationAttemptId: attemptId, verificationStartedAt: new Date() },
      });
      await this.audit.recordWithinTransaction(tx, {
        action: claimAuditAction,
        actorUserId: userId,
        workspaceId: row.workspaceId,
        entityType: "media_asset",
        entityId: row.publicId,
        ipAddress: context.ipAddress,
      });

      return { row: { ...row, status: "VERIFYING" as MediaAssetStatus, verificationAttemptId: attemptId }, attemptId };
    });
  }

  /**
   * Outside any transaction — no DB row lock is held while this runs.
   * Every possible failure (timeout, network error, scan-provider error)
   * is caught here and funneled into a classified outcome; nothing
   * propagates uncaught past this method. See plan §4 (no long DB
   * transactions across storage I/O) and Safeguard 2 (retryable vs
   * permanent).
   */
  private async runOutsideVerification(row: LockedAssetRow): Promise<VerificationOutcome> {
    const media = this.config.get("media", { infer: true });
    const overallController = new AbortController();
    const overallTimeout = setTimeout(() => overallController.abort(), media.maxVerificationDurationSeconds * 1000);

    const withTimeout = async <T>(factory: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> => {
      const perCallController = new AbortController();
      const perCallTimeout = setTimeout(() => perCallController.abort(), timeoutMs);
      const combinedSignal = AbortSignal.any([perCallController.signal, overallController.signal]);
      try {
        return await factory(combinedSignal);
      } finally {
        clearTimeout(perCallTimeout);
      }
    };

    try {
      let head;
      try {
        head = await withTimeout((signal) => this.storage.headObject(row.objectKey, { signal }), media.storageOperationTimeoutSeconds * 1000);
      } catch (error) {
        this.logger.debug({ event: "MEDIA_ASSET_VERIFICATION_STEP_FAILED", step: "headObject", assetId: row.id, error: (error as Error).message });
        return { kind: "retryable", reason: "storage_metadata_timeout" };
      }
      if (!head.exists) {
        return { kind: "rejected", reason: "object_not_found" };
      }

      const effectiveMax = this.effectiveMaxSizeBytes(row.assetType);
      const reportedSize = head.reportedSizeBytes ?? 0;
      if (reportedSize > effectiveMax) {
        return { kind: "rejected", reason: "size_exceeds_sync_verification_ceiling" };
      }

      let prefix: Buffer;
      try {
        prefix = await withTimeout(
          (signal) => this.storage.inspectObjectPrefix(row.objectKey, media.mimeInspectionBytes, { signal }),
          media.storageOperationTimeoutSeconds * 1000,
        );
      } catch (error) {
        this.logger.debug({ event: "MEDIA_ASSET_VERIFICATION_STEP_FAILED", step: "inspectObjectPrefix", assetId: row.id, error: (error as Error).message });
        return { kind: "retryable", reason: "mime_inspection_timeout" };
      }

      const executableHit = matchesExecutableSignature(prefix);
      if (executableHit) {
        return { kind: "rejected", reason: `executable_signature_detected`, verifiedSizeBytes: reportedSize };
      }
      const sniff = sniffMimeType(prefix);
      const verifiedMimeType = resolveVerifiedMimeType(sniff, row.assetType);
      if (!verifiedMimeType) {
        return { kind: "rejected", reason: "mime_mismatch_or_unrecognized_format", verifiedSizeBytes: reportedSize };
      }

      let verifiedChecksumSha256: string;
      try {
        verifiedChecksumSha256 = await withTimeout(
          (signal) => this.storage.computeSha256(row.objectKey, { signal }),
          media.checksumTimeoutSeconds * 1000,
        );
      } catch (error) {
        this.logger.debug({ event: "MEDIA_ASSET_VERIFICATION_STEP_FAILED", step: "computeSha256", assetId: row.id, error: (error as Error).message });
        return { kind: "retryable", reason: "checksum_timeout_or_stream_interrupted", verifiedMimeType, verifiedSizeBytes: reportedSize };
      }
      if (row.expectedChecksumSha256 && row.expectedChecksumSha256 !== verifiedChecksumSha256) {
        // The real checksum is recorded even on rejection — useful for
        // audit/debugging (plan §3), never treated as if it "passed".
        return { kind: "rejected", reason: "checksum_mismatch", verifiedMimeType, verifiedSizeBytes: reportedSize, verifiedChecksumSha256 };
      }

      let scanResult: { status: MalwareScanStatus };
      try {
        scanResult = await this.malwareScan.scan({ key: row.objectKey });
      } catch (error) {
        this.logger.debug({ event: "MEDIA_ASSET_VERIFICATION_STEP_FAILED", step: "malwareScan", assetId: row.id, error: (error as Error).message });
        return {
          kind: "retryable",
          reason: "malware_scan_provider_outage",
          verifiedMimeType,
          verifiedSizeBytes: reportedSize,
          verifiedChecksumSha256,
        };
      }
      if (scanResult.status === "INFECTED") {
        return {
          kind: "quarantined",
          reason: "malware_infected",
          verifiedMimeType,
          verifiedSizeBytes: reportedSize,
          verifiedChecksumSha256,
        };
      }
      if (scanResult.status === "SCAN_FAILED") {
        // Transient scan-provider outage — retryable, not permanent
        // (Safeguard 2). Never silently treated as equivalent to a clean
        // pass either.
        return {
          kind: "retryable",
          reason: "malware_scan_failed",
          verifiedMimeType,
          verifiedSizeBytes: reportedSize,
          verifiedChecksumSha256,
        };
      }

      return {
        kind: "success",
        verifiedMimeType,
        verifiedSizeBytes: reportedSize,
        verifiedChecksumSha256,
        malwareScanStatus: scanResult.status, // NOT_SCANNED or CLEAN only, by construction above
      };
    } finally {
      clearTimeout(overallTimeout);
    }
  }

  /**
   * Transaction 2. Re-locks by id + verificationAttemptId — a finalize
   * whose attemptId no longer matches the row's current one lost the
   * race (a newer retry/claim superseded it) and is silently discarded,
   * never applied. For a version-replacement (`supersedesAssetId` set),
   * locks both the new and the current-ACTIVE row in one ORDER BY id
   * statement (deadlock-safe, same discipline as Module 1C's
   * transferOwnership), archives the old row, THEN activates the new one
   * — never the reverse.
   */
  private async finalizeVerification(
    claimedRow: LockedAssetRow,
    attemptId: string,
    outcome: VerificationOutcome,
    userId: string,
    context: RequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const idsToLock = claimedRow.supersedesAssetId
        ? [claimedRow.id, claimedRow.supersedesAssetId].sort()
        : [claimedRow.id];
      const lockedRows = await tx.$queryRaw<LockedAssetRow[]>`
        SELECT ${Prisma.raw(ASSET_ROW_COLUMNS)} FROM media_assets WHERE id = ANY(${idsToLock}::uuid[]) ORDER BY id ASC FOR UPDATE
      `;
      const current = lockedRows.find((r) => r.id === claimedRow.id);

      if (!current || current.status !== "VERIFYING" || current.verificationAttemptId !== attemptId) {
        // Lost the race — a newer claim/retry already moved this row on.
        // Nothing to apply; return the row's actual current state.
        const latest = await tx.mediaAsset.findUniqueOrThrow({ where: { id: claimedRow.id } });
        return latest;
      }

      if (outcome.kind === "success") {
        if (current.supersedesAssetId) {
          const oldRow = lockedRows.find((r) => r.id === current.supersedesAssetId);
          if (!oldRow || oldRow.status !== "ACTIVE") {
            // Defensive: the one-pending-replacement partial index should
            // make this unreachable, but never silently activate over an
            // inconsistent supersede target.
            await tx.mediaAsset.update({
              where: { id: current.id },
              data: { status: "REJECTED", rejectionReason: "supersede_target_no_longer_active" },
            });
            await this.audit.recordWithinTransaction(tx, {
              action: "MEDIA_ASSET_REJECTED",
              actorUserId: userId,
              workspaceId: current.workspaceId,
              entityType: "media_asset",
              entityId: current.publicId,
              ipAddress: context.ipAddress,
            });
            return tx.mediaAsset.findUniqueOrThrow({ where: { id: current.id } });
          }
          // Archive old FIRST.
          await tx.mediaAsset.update({ where: { id: oldRow.id }, data: { status: "ARCHIVED", archivedAt: new Date() } });
          // THEN activate new.
          await tx.mediaAsset.update({
            where: { id: current.id },
            data: {
              status: "ACTIVE",
              verifiedAt: new Date(),
              verifiedMimeType: outcome.verifiedMimeType,
              verifiedSizeBytes: BigInt(outcome.verifiedSizeBytes),
              verifiedChecksumSha256: outcome.verifiedChecksumSha256,
              malwareScanStatus: outcome.malwareScanStatus,
            },
          });
        } else {
          await tx.mediaAsset.update({
            where: { id: current.id },
            data: {
              status: "ACTIVE",
              verifiedAt: new Date(),
              verifiedMimeType: outcome.verifiedMimeType,
              verifiedSizeBytes: BigInt(outcome.verifiedSizeBytes),
              verifiedChecksumSha256: outcome.verifiedChecksumSha256,
              malwareScanStatus: outcome.malwareScanStatus,
            },
          });
        }
        await this.markDuplicateIfAny(tx, current.id, current.workspaceId, outcome.verifiedChecksumSha256);
        await this.audit.recordWithinTransaction(tx, {
          action: "MEDIA_ASSET_ACTIVATED",
          actorUserId: userId,
          workspaceId: current.workspaceId,
          entityType: "media_asset",
          entityId: current.publicId,
          afterState: { malwareScanStatus: outcome.malwareScanStatus },
          ipAddress: context.ipAddress,
        });
      } else if (outcome.kind === "rejected") {
        await tx.mediaAsset.update({
          where: { id: current.id },
          data: {
            status: "REJECTED",
            rejectionReason: outcome.reason,
            verifiedMimeType: outcome.verifiedMimeType,
            verifiedSizeBytes: outcome.verifiedSizeBytes !== undefined ? BigInt(outcome.verifiedSizeBytes) : undefined,
            verifiedChecksumSha256: outcome.verifiedChecksumSha256,
          },
        });
        await this.audit.recordWithinTransaction(tx, {
          action: "MEDIA_ASSET_REJECTED",
          actorUserId: userId,
          workspaceId: current.workspaceId,
          entityType: "media_asset",
          entityId: current.publicId,
          afterState: { rejectionReason: outcome.reason },
          ipAddress: context.ipAddress,
        });
      } else if (outcome.kind === "quarantined") {
        await tx.mediaAsset.update({
          where: { id: current.id },
          data: {
            status: "QUARANTINED",
            malwareScanStatus: "INFECTED",
            rejectionReason: outcome.reason,
            verifiedMimeType: outcome.verifiedMimeType,
            verifiedSizeBytes: outcome.verifiedSizeBytes !== undefined ? BigInt(outcome.verifiedSizeBytes) : undefined,
            verifiedChecksumSha256: outcome.verifiedChecksumSha256,
          },
        });
        await this.audit.recordWithinTransaction(tx, {
          action: "MEDIA_ASSET_QUARANTINED",
          actorUserId: userId,
          workspaceId: current.workspaceId,
          entityType: "media_asset",
          entityId: current.publicId,
          ipAddress: context.ipAddress,
        });
      } else {
        // retryable
        await tx.mediaAsset.update({
          where: { id: current.id },
          data: {
            status: "VERIFICATION_FAILED",
            rejectionReason: outcome.reason,
            verifiedMimeType: outcome.verifiedMimeType,
            verifiedSizeBytes: outcome.verifiedSizeBytes !== undefined ? BigInt(outcome.verifiedSizeBytes) : undefined,
            verifiedChecksumSha256: outcome.verifiedChecksumSha256,
          },
        });
        await this.audit.recordWithinTransaction(tx, {
          action: "MEDIA_ASSET_VERIFICATION_FAILED",
          actorUserId: userId,
          workspaceId: current.workspaceId,
          entityType: "media_asset",
          entityId: current.publicId,
          afterState: { rejectionReason: outcome.reason },
          ipAddress: context.ipAddress,
        });
      }

      return tx.mediaAsset.findUniqueOrThrow({ where: { id: current.id } });
    });
  }

  /**
   * Per-workspace-only duplicate flagging — never cross-workspace, never
   * physical object dedup. Best-effort: failure here must not fail the
   * activation it's attached to, so callers should treat this as
   * fire-and-forget within the same transaction (a query, not a critical
   * write).
   */
  private async markDuplicateIfAny(tx: Prisma.TransactionClient, assetId: string, workspaceId: string, verifiedChecksumSha256: string): Promise<void> {
    const duplicate = await tx.mediaAsset.findFirst({
      where: {
        workspaceId,
        verifiedChecksumSha256,
        id: { not: assetId },
        deletedAt: null,
      },
      orderBy: { createdAt: "asc" },
    });
    if (duplicate) {
      await tx.mediaAsset.update({ where: { id: assetId }, data: { duplicateOfAssetId: duplicate.id } });
    }
  }

  // ---------------------------------------------------------------------
  // Read/write CRUD surface.
  // ---------------------------------------------------------------------
  async list(workspaceId: string, filters: { projectId?: string; assetType?: MediaAssetType; status?: MediaAssetStatus }) {
    // filters.projectId is the project's PUBLIC id (client-facing); the
    // row's own projectId column is the internal FK — must resolve one to
    // the other, never compare them directly.
    let projectInternalId: string | undefined;
    if (filters.projectId) {
      const project = await this.prisma.project.findFirst({ where: { publicId: filters.projectId, workspaceId } });
      if (!project) throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
      projectInternalId = project.id;
    }
    return this.prisma.mediaAsset.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(projectInternalId ? { projectId: projectInternalId } : {}),
        ...(filters.assetType ? { assetType: filters.assetType } : {}),
        status: filters.status ?? { notIn: ["DELETED", "REJECTED"] },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(workspaceId: string, assetPublicId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({ where: { publicId: assetPublicId, workspaceId } });
    if (!asset) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });
    return asset;
  }

  async getDownloadUrl(workspace: { id: string }, userId: string, assetPublicId: string, context: RequestContext) {
    const media = this.config.get("media", { infer: true });
    const rate = await this.protection.checkRateLimit(
      `media:download-url:user:${userId}:workspace:${workspace.id}`,
      media.downloadUrl.limit,
      media.downloadUrl.windowSeconds,
    );
    if (!rate.allowed) {
      throw new HttpException({ code: "RATE_LIMITED", message: "Too many download requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const asset = await this.findOne(workspace.id, assetPublicId);
    if (asset.status !== "ACTIVE") {
      throw new ConflictException({ code: "MEDIA_ASSET_NOT_ACTIVE", message: "Only an ACTIVE asset can be downloaded." });
    }

    const { downloadUrl, expiresAt } = await this.storage.createPresignedDownloadUrl({
      key: asset.objectKey,
      expiresInSeconds: media.downloadUrlTtlSeconds,
      downloadFilename: asset.normalizedFilename,
    });

    await this.audit.record({
      action: "MEDIA_ASSET_DOWNLOAD_URL_ISSUED",
      actorUserId: userId,
      workspaceId: workspace.id,
      entityType: "media_asset",
      entityId: asset.publicId,
      ipAddress: context.ipAddress,
    });

    // Never persisted, never logged — see plan §9.
    return { downloadUrl, expiresAt };
  }

  async updateMetadata(workspace: { id: string }, userId: string, assetPublicId: string, dto: UpdateMediaAssetDto, context: RequestContext) {
    const asset = await this.findOne(workspace.id, assetPublicId);

    let projectId = asset.projectId;
    if (dto.projectId !== undefined) {
      const project = await this.prisma.project.findFirst({ where: { publicId: dto.projectId, workspaceId: workspace.id } });
      if (!project) throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
      projectId = project.id;
    }

    const updated = await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        normalizedFilename: dto.normalizedFilename ?? undefined,
        metadata: (dto.metadata as Prisma.InputJsonValue) ?? undefined,
        projectId,
      },
    });

    await this.audit.record({
      action: "MEDIA_ASSET_METADATA_UPDATED",
      actorUserId: userId,
      workspaceId: workspace.id,
      entityType: "media_asset",
      entityId: asset.publicId,
      ipAddress: context.ipAddress,
    });

    return updated;
  }

  async archive(workspace: { id: string }, userId: string, assetPublicId: string, context: RequestContext) {
    const asset = await this.findOne(workspace.id, assetPublicId);
    if (asset.status !== "ACTIVE") {
      throw new ConflictException({ code: "MEDIA_ASSET_NOT_ACTIVE", message: "Only an ACTIVE asset can be archived." });
    }
    const updated = await this.prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    await this.audit.record({
      action: "MEDIA_ASSET_ARCHIVED",
      actorUserId: userId,
      workspaceId: workspace.id,
      entityType: "media_asset",
      entityId: asset.publicId,
      ipAddress: context.ipAddress,
    });
    return updated;
  }

  /**
   * Module 1D Engineering Plan §5 "Archive/Restore and Version
   * Invariants": valid only if the target is ARCHIVED and its
   * assetGroupId currently has zero ACTIVE rows — i.e. it was manually
   * archived while still current, never a historical version superseded
   * by a replacement (which always keeps exactly one ACTIVE row in the
   * group throughout that transition). One combined, id-ordered lock
   * query covers both the target and whatever row (if any) is currently
   * ACTIVE in the group — deadlock-safe against a concurrent
   * version-replacement finalize on the same group.
   */
  async restore(workspace: { id: string }, userId: string, assetPublicId: string, context: RequestContext) {
    const targetLookup = await this.prisma.mediaAsset.findFirst({ where: { publicId: assetPublicId, workspaceId: workspace.id } });
    if (!targetLookup) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });

    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedAssetRow[]>`
        SELECT ${Prisma.raw(ASSET_ROW_COLUMNS)} FROM media_assets
        WHERE id = ${targetLookup.id}::uuid
           OR (asset_group_id = ${targetLookup.assetGroupId}::uuid AND status = 'ACTIVE')
        ORDER BY id ASC
        FOR UPDATE
      `;
      const target = rows.find((r) => r.id === targetLookup.id);
      if (!target || target.status !== "ARCHIVED") {
        throw new ConflictException({ code: "MEDIA_ASSET_NOT_ARCHIVED", message: "Only an ARCHIVED asset can be restored." });
      }
      const activeSibling = rows.find((r) => r.id !== target.id && r.status === "ACTIVE");
      if (activeSibling) {
        throw new ConflictException({
          code: "MEDIA_ASSET_SUPERSEDED_CANNOT_RESTORE",
          message: "A newer version of this asset is active — restore a historical, superseded version by creating a new version from it instead.",
        });
      }

      const result = await tx.mediaAsset.update({ where: { id: target.id }, data: { status: "ACTIVE", archivedAt: null } });
      await this.audit.recordWithinTransaction(tx, {
        action: "MEDIA_ASSET_RESTORED",
        actorUserId: userId,
        workspaceId: workspace.id,
        entityType: "media_asset",
        entityId: target.publicId,
        ipAddress: context.ipAddress,
      });
      return result;
    });

    return updated;
  }

  async softDelete(workspace: { id: string }, userId: string, assetPublicId: string, context: RequestContext) {
    const asset = await this.findOne(workspace.id, assetPublicId);
    if (asset.status === "PENDING_UPLOAD" || asset.status === "VERIFYING" || asset.status === "DELETED") {
      throw new ConflictException({ code: "MEDIA_ASSET_NOT_DELETABLE", message: "This asset cannot be deleted in its current state." });
    }
    const updated = await this.prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "DELETED", deletedAt: new Date() } });
    await this.audit.record({
      action: "MEDIA_ASSET_DELETED",
      actorUserId: userId,
      workspaceId: workspace.id,
      entityType: "media_asset",
      entityId: asset.publicId,
      ipAddress: context.ipAddress,
    });
    return updated;
  }

  private toResponse(asset: { publicId: string; status: MediaAssetStatus; malwareScanStatus: MalwareScanStatus; rejectionReason: string | null }) {
    return {
      assetPublicId: asset.publicId,
      status: asset.status,
      malwareScanStatus: asset.malwareScanStatus,
      rejectionReason: asset.rejectionReason,
    };
  }
}
