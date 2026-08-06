-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING_UPLOAD', 'VERIFYING', 'ACTIVE', 'REJECTED', 'QUARANTINED', 'VERIFICATION_FAILED', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "MediaAssetType" AS ENUM ('IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MalwareScanStatus" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED', 'SCAN_FAILED');

-- CreateEnum
CREATE TYPE "MediaStorageProviderIdentity" AS ENUM ('MINIO', 'AWS_S3', 'CLOUDFLARE_R2', 'OTHER_S3_COMPATIBLE');

-- CreateEnum
CREATE TYPE "MediaAssetVisibility" AS ENUM ('WORKSPACE_PRIVATE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_UPLOAD_INTENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_VERIFICATION_CLAIMED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_QUARANTINED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_VERIFICATION_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_VERIFICATION_RETRIED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_VERSION_REPLACEMENT_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_METADATA_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'MEDIA_ASSET_DOWNLOAD_URL_ISSUED';

-- Module 1D correction: Prisma's diff engine generated DROP statements for
-- workspaces_slug_reservation_fkey / projects_slug_reservation_fkey here.
-- Both are Module 1C's hand-written DEFERRABLE INITIALLY DEFERRED composite
-- FKs (permanent slug reservation) — invisible to Prisma's schema DSL, so
-- its diff sees them as "extra" and wants to remove them. They must be
-- left completely untouched; removed from this migration deliberately.

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "content_item_id" UUID,
    "asset_type" "MediaAssetType" NOT NULL,
    "original_filename" TEXT NOT NULL,
    "normalized_filename" TEXT NOT NULL,
    "storage_provider_identity" "MediaStorageProviderIdentity" NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "declared_mime_type" TEXT NOT NULL,
    "declared_size_bytes" BIGINT NOT NULL,
    "verified_mime_type" TEXT,
    "verified_size_bytes" BIGINT,
    "extension" TEXT NOT NULL,
    "expected_checksum_sha256" TEXT,
    "verified_checksum_sha256" TEXT,
    "malware_scan_status" "MalwareScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
    "asset_group_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "supersedes_asset_id" UUID,
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "visibility" "MediaAssetVisibility" NOT NULL DEFAULT 'WORKSPACE_PRIVATE',
    "rejection_reason" TEXT,
    "duplicate_of_asset_id" UUID,
    "verification_attempt_id" UUID,
    "verification_started_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "presigned_url_expires_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_public_id_key" ON "media_assets"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_object_key_key" ON "media_assets"("object_key");

-- CreateIndex
CREATE INDEX "media_assets_workspace_id_idx" ON "media_assets"("workspace_id");

-- CreateIndex
CREATE INDEX "media_assets_project_id_idx" ON "media_assets"("project_id");

-- CreateIndex
CREATE INDEX "media_assets_asset_group_id_idx" ON "media_assets"("asset_group_id");

-- CreateIndex
CREATE INDEX "media_assets_status_idx" ON "media_assets"("status");

-- CreateIndex
CREATE INDEX "media_assets_workspace_id_verified_checksum_sha256_idx" ON "media_assets"("workspace_id", "verified_checksum_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_asset_group_id_version_number_key" ON "media_assets"("asset_group_id", "version_number");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_supersedes_asset_id_fkey" FOREIGN KEY ("supersedes_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_duplicate_of_asset_id_fkey" FOREIGN KEY ("duplicate_of_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Module 1D: the two partial unique indexes this design requires — not
-- expressible in Prisma's schema DSL, same limitation already worked
-- around in Module 1C (workspace_invitations_pending_email_unique,
-- users_single_platform_owner). Hand-written here.

-- At most one ACTIVE, non-deleted row per assetGroupId — the one-current-
-- version invariant. See MODULE 1D ENGINEERING PLAN §5/§9.
CREATE UNIQUE INDEX "media_assets_one_active_version_per_group"
  ON "media_assets" ("asset_group_id")
  WHERE "status" = 'ACTIVE' AND "deleted_at" IS NULL;

-- At most one non-terminal (PENDING_UPLOAD/VERIFYING) replacement row per
-- assetGroupId — Safeguard 1's concurrency guarantee. Scoped to rows that
-- ARE replacements (supersedes_asset_id IS NOT NULL); a group's very
-- first upload never goes through the versions/upload-intent endpoint and
-- is never constrained by this index.
CREATE UNIQUE INDEX "media_assets_one_pending_replacement_per_group"
  ON "media_assets" ("asset_group_id")
  WHERE "supersedes_asset_id" IS NOT NULL AND "status" IN ('PENDING_UPLOAD', 'VERIFYING');
