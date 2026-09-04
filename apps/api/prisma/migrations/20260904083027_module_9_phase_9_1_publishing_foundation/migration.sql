-- CreateEnum
CREATE TYPE "PublishingChannelType" AS ENUM ('WORDPRESS', 'YOUTUBE', 'FACEBOOK', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "PublishingConnectionStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "PublicationTargetStatus" AS ENUM ('PENDING', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PUBLISHING_CHANNEL_ACCOUNT_CONNECTED';
ALTER TYPE "AuditAction" ADD VALUE 'PUBLISHING_CHANNEL_ACCOUNT_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'PUBLISHING_CREDENTIAL_ROTATED';
ALTER TYPE "AuditAction" ADD VALUE 'PUBLICATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PUBLICATION_TARGET_STATUS_CHANGED';

-- NOTE (Module 9 Phase 9.1 migration-safety review): `prisma migrate dev`'s
-- diff engine proposed dropping "projects_slug_reservation_fkey" and
-- "workspaces_slug_reservation_fkey" here. Both are deliberately hand-
-- written, raw-SQL-only composite FKs from the very first migration
-- (20260805181319_workspace_platform_owner_foundation) — a self-
-- referencing (id, slug) -> (workspace_id/project_id, slug) constraint
-- with no schema.prisma-level relation declaration at all (the same
-- "not expressible in Prisma's schema DSL" category as InternalLink's
-- own hand-written partial unique index). Because nothing in
-- schema.prisma ever declared them, Prisma's diff engine cannot see
-- that they're intentional and proposes dropping them on every future
-- `migrate dev` run, regardless of what schema change is actually being
-- made — a pre-existing tooling artifact, unrelated to Module 9, not
-- reproduced here. Left entirely untouched; Phase 9.1 makes no change
-- of any kind to the workspaces/projects/slug-reservation tables.

-- CreateTable
CREATE TABLE "publishing_channel_accounts" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_type" "PublishingChannelType" NOT NULL,
    "display_name" TEXT NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "connection_status" "PublishingConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "credential_id" UUID NOT NULL,
    "capabilities_snapshot" JSONB,
    "connected_by" UUID NOT NULL,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_verified_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_channel_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_credentials" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "token_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publications" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_for" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_targets" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "status" "PublicationTargetStatus" NOT NULL DEFAULT 'PENDING',
    "external_content_id" TEXT,
    "external_url" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_message_safe" TEXT,
    "published_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publication_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL,
    "publication_target_id" UUID NOT NULL,
    "from_status" "PublicationTargetStatus",
    "to_status" "PublicationTargetStatus" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB,

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publishing_channel_accounts_public_id_key" ON "publishing_channel_accounts"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_channel_accounts_credential_id_key" ON "publishing_channel_accounts"("credential_id");

-- CreateIndex
CREATE INDEX "publishing_channel_accounts_workspace_id_channel_type_idx" ON "publishing_channel_accounts"("workspace_id", "channel_type");

-- CreateIndex
CREATE INDEX "publishing_channel_accounts_workspace_id_connection_status_idx" ON "publishing_channel_accounts"("workspace_id", "connection_status");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_channel_accounts_workspace_id_channel_type_exter_key" ON "publishing_channel_accounts"("workspace_id", "channel_type", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_channel_accounts_credential_id_workspace_id_key" ON "publishing_channel_accounts"("credential_id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_channel_accounts_id_workspace_id_key" ON "publishing_channel_accounts"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "channel_credentials_workspace_id_idx" ON "channel_credentials"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_credentials_id_workspace_id_key" ON "channel_credentials"("id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "publications_public_id_key" ON "publications"("public_id");

-- CreateIndex
CREATE INDEX "publications_workspace_id_content_item_id_idx" ON "publications"("workspace_id", "content_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "publications_id_workspace_id_key" ON "publications"("id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "publication_targets_public_id_key" ON "publication_targets"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "publication_targets_idempotency_key_key" ON "publication_targets"("idempotency_key");

-- CreateIndex
CREATE INDEX "publication_targets_workspace_id_content_item_id_status_idx" ON "publication_targets"("workspace_id", "content_item_id", "status");

-- CreateIndex
CREATE INDEX "publication_targets_workspace_id_channel_account_id_status_idx" ON "publication_targets"("workspace_id", "channel_account_id", "status");

-- CreateIndex
CREATE INDEX "publish_attempts_publication_target_id_idx" ON "publish_attempts"("publication_target_id");

-- AddForeignKey
ALTER TABLE "publishing_channel_accounts" ADD CONSTRAINT "publishing_channel_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_channel_accounts" ADD CONSTRAINT "publishing_channel_accounts_credential_id_workspace_id_fkey" FOREIGN KEY ("credential_id", "workspace_id") REFERENCES "channel_credentials"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_channel_accounts" ADD CONSTRAINT "publishing_channel_accounts_connected_by_fkey" FOREIGN KEY ("connected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_credentials" ADD CONSTRAINT "channel_credentials_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_targets" ADD CONSTRAINT "publication_targets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_targets" ADD CONSTRAINT "publication_targets_publication_id_workspace_id_fkey" FOREIGN KEY ("publication_id", "workspace_id") REFERENCES "publications"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_targets" ADD CONSTRAINT "publication_targets_channel_account_id_workspace_id_fkey" FOREIGN KEY ("channel_account_id", "workspace_id") REFERENCES "publishing_channel_accounts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_publication_target_id_fkey" FOREIGN KEY ("publication_target_id") REFERENCES "publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Live-target uniqueness invariant (Architecture Checkpoint §Part M /
-- publishing-domain.ts's own LIVE_TARGET_STATUSES): at most one
-- PENDING/SCHEDULED/QUEUED/PUBLISHING row may exist for the same
-- (workspace, content item, channel account) at any time. PUBLISHED/
-- FAILED/CANCELLED are deliberately excluded from this scope — they are
-- history, not live state — so a fresh publish attempt for the same
-- pair after a terminal outcome is always a normal INSERT, never a
-- resurrection of the old row. Not expressible in Prisma's schema DSL;
-- hand-written here, the exact same precedent as InternalLink's own
-- "internal_links_workspace_source_target_active_unique" partial unique
-- index (20260831090000_module_8_phase_8_1_internal_linking_foundation).
CREATE UNIQUE INDEX "publication_targets_workspace_content_channel_live_unique"
ON "publication_targets" ("workspace_id", "content_item_id", "channel_account_id")
WHERE "status" IN ('PENDING', 'SCHEDULED', 'QUEUED', 'PUBLISHING');
