-- Module 7 Phase 7.4: Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 / 5.1 / 6.1 / 6.2 / 7.1
-- migrations' own notes). Deliberately NOT applied — both DROP statements
-- were removed from this file. Neither constraint is touched by this
-- migration.

-- Module 7 Phase 7.4 — Media Generation Foundation.
-- Purely additive: two new enums, one new value on MediaAssetType, one
-- new table (media_jobs). No ALTER to any existing table's columns, no
-- data backfill. media_jobs is the image/voice/subtitle analogue of
-- ai_jobs (AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md §5 extension-
-- table pattern), linked 1:1 to a generic background_jobs dispatch row.

-- CreateEnum
CREATE TYPE "MediaJobOperation" AS ENUM ('IMAGE_GENERATE', 'TTS', 'SUBTITLE_GENERATE');

-- CreateEnum
CREATE TYPE "MediaJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT');

-- AlterEnum
-- media_jobs does NOT reference this value; it is consumed only by
-- media_assets.asset_type (an existing column), so a plain ADD VALUE in
-- the same migration is safe on PostgreSQL 12+ (same inline pattern as
-- the Module 1E content_foundation and Module 5 Phase 5.1 migrations).
ALTER TYPE "MediaAssetType" ADD VALUE 'SUBTITLE';

-- CreateTable
CREATE TABLE "media_jobs" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID,
    "operation" "MediaJobOperation" NOT NULL,
    "background_job_id" UUID,
    "input_payload" JSONB NOT NULL,
    "output_payload" JSONB,
    "provider_used" TEXT,
    "model_used" TEXT,
    "usage_metadata" JSONB,
    "cost_estimate" DECIMAL(10,6),
    "status" "MediaJobStatus" NOT NULL DEFAULT 'QUEUED',
    "error_code" TEXT,
    "error_message_safe" TEXT,
    "correlation_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "media_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_jobs_public_id_key" ON "media_jobs"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_jobs_background_job_id_key" ON "media_jobs"("background_job_id");

-- CreateIndex
CREATE INDEX "media_jobs_workspace_id_idx" ON "media_jobs"("workspace_id");

-- CreateIndex
CREATE INDEX "media_jobs_status_idx" ON "media_jobs"("status");

-- CreateIndex
CREATE INDEX "media_jobs_correlation_id_idx" ON "media_jobs"("correlation_id");

-- CreateIndex
CREATE INDEX "media_jobs_content_item_id_idx" ON "media_jobs"("content_item_id");

-- AddForeignKey
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_background_job_id_fkey" FOREIGN KEY ("background_job_id") REFERENCES "background_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
