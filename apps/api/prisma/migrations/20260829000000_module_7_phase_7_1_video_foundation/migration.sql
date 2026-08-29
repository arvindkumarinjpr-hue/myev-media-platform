-- Module 7 Phase 7.1: Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 / 5.1 / 6.1 / 6.2 migrations'
-- own notes). Deliberately not applied. Neither constraint is touched by
-- this migration.

-- Module 7 Phase 7.1 — Video Automation domain + pipeline foundation.
-- AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md §5.4: video_scripts, the
-- 1:1 (content_type = VIDEO) extension row (script_body, scene_plan,
-- voice_profile_id, render_job_id) plus FR-VID-001 target_platform and
-- FR-VID-009/FR-SEO-001 video SEO metadata columns. Purely additive: one
-- new enum, one new table, no ALTER to any existing table, no change to
-- any existing enum (ContentType.VIDEO and ContentItemStatus.RENDERING/
-- FAILED already exist — reserved since Module 1E).

-- CreateEnum
CREATE TYPE "VideoTargetPlatform" AS ENUM ('YOUTUBE_LONG', 'YOUTUBE_SHORTS', 'INSTAGRAM_REEL', 'FACEBOOK_REEL', 'SQUARE_SOCIAL', 'LANDSCAPE_PRESENTATION');

-- CreateTable
CREATE TABLE "video_scripts" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "target_platform" "VideoTargetPlatform" NOT NULL,
    "export_profile" TEXT,
    "duration_seconds_target" INTEGER,
    "script_body" TEXT,
    "scene_plan" JSONB,
    "voice_profile_id" UUID,
    "render_job_id" UUID,
    "meta_title" TEXT,
    "meta_description" TEXT,
    "tags" JSONB,
    "chapters" JSONB,
    "hashtags" JSONB,
    "schema_markup" JSONB,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "video_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_scripts_public_id_key" ON "video_scripts"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_scripts_content_item_id_key" ON "video_scripts"("content_item_id");

-- CreateIndex
CREATE INDEX "video_scripts_workspace_id_idx" ON "video_scripts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_scripts_content_item_id_workspace_id_key" ON "video_scripts"("content_item_id", "workspace_id");

-- AddForeignKey
ALTER TABLE "video_scripts" ADD CONSTRAINT "video_scripts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_scripts" ADD CONSTRAINT "video_scripts_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_scripts" ADD CONSTRAINT "video_scripts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_scripts" ADD CONSTRAINT "video_scripts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
