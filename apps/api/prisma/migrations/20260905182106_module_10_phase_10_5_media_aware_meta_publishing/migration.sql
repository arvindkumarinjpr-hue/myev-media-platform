-- NOTE (manually removed by the same known, previously-documented cause as
-- migrations 20260905142237/20260905154353/20260905170642's own notes):
-- Prisma's diff engine always proposes DROP CONSTRAINT
-- projects_slug_reservation_fkey / workspaces_slug_reservation_fkey on ANY
-- new migration against this schema, because those two FKs were added via
-- raw SQL in an earlier Module 1C migration (deferred/circular FKs,
-- invisible to Prisma's own schema DSL) — not a real schema conflict.
-- Verified after applying this migration that both constraints remain
-- intact.

-- CreateTable
CREATE TABLE "social_version_media" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "social_post_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "content_version_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_version_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_version_media_public_id_key" ON "social_version_media"("public_id");

-- CreateIndex
CREATE INDEX "social_version_media_workspace_id_idx" ON "social_version_media"("workspace_id");

-- CreateIndex
CREATE INDEX "social_version_media_social_post_id_idx" ON "social_version_media"("social_post_id");

-- CreateIndex
CREATE INDEX "social_version_media_media_asset_id_idx" ON "social_version_media"("media_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_version_media_content_version_id_content_item_id_key" ON "social_version_media"("content_version_id", "content_item_id");

-- AddForeignKey
ALTER TABLE "social_version_media" ADD CONSTRAINT "social_version_media_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_version_media" ADD CONSTRAINT "social_version_media_social_post_id_fkey" FOREIGN KEY ("social_post_id") REFERENCES "social_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_version_media" ADD CONSTRAINT "social_version_media_content_version_id_content_item_id_fkey" FOREIGN KEY ("content_version_id", "content_item_id") REFERENCES "content_versions"("id", "content_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_version_media" ADD CONSTRAINT "social_version_media_media_asset_id_workspace_id_fkey" FOREIGN KEY ("media_asset_id", "workspace_id") REFERENCES "media_assets"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
