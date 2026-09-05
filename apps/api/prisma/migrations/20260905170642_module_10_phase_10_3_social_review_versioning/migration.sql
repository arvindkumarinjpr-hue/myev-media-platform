/*
  Warnings:

  - You are about to drop the column `caption_ai_job_id` on the `social_posts` table. All the data in the column will be lost.
  - You are about to drop the column `hashtag_ai_job_id` on the `social_posts` table. All the data in the column will be lost.

*/
-- NOTE (manually removed by the same known, previously-documented cause as
-- migrations 20260905142237 and 20260905154353's own notes): Prisma's diff
-- engine always proposes DROP CONSTRAINT projects_slug_reservation_fkey /
-- workspaces_slug_reservation_fkey on ANY new migration against this
-- schema, because those two FKs were added via raw SQL in an earlier
-- Module 1C migration (deferred/circular FKs, invisible to Prisma's own
-- schema DSL) — not a real schema conflict. Verified after applying this
-- migration that both constraints remain intact.

-- DropForeignKey
ALTER TABLE "social_posts" DROP CONSTRAINT "social_posts_caption_ai_job_id_fkey";

-- DropForeignKey
ALTER TABLE "social_posts" DROP CONSTRAINT "social_posts_hashtag_ai_job_id_fkey";

-- DropIndex
DROP INDEX "social_posts_caption_ai_job_id_idx";

-- DropIndex
DROP INDEX "social_posts_hashtag_ai_job_id_idx";

-- AlterTable
ALTER TABLE "social_posts" DROP COLUMN "caption_ai_job_id",
DROP COLUMN "hashtag_ai_job_id";

-- CreateTable
CREATE TABLE "social_version_generations" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "social_post_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "content_version_id" UUID NOT NULL,
    "caption_ai_job_id" UUID NOT NULL,
    "hashtag_ai_job_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_version_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_version_generations_public_id_key" ON "social_version_generations"("public_id");

-- CreateIndex
CREATE INDEX "social_version_generations_workspace_id_idx" ON "social_version_generations"("workspace_id");

-- CreateIndex
CREATE INDEX "social_version_generations_social_post_id_idx" ON "social_version_generations"("social_post_id");

-- CreateIndex
CREATE INDEX "social_version_generations_caption_ai_job_id_idx" ON "social_version_generations"("caption_ai_job_id");

-- CreateIndex
CREATE INDEX "social_version_generations_hashtag_ai_job_id_idx" ON "social_version_generations"("hashtag_ai_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_version_generations_content_version_id_content_item__key" ON "social_version_generations"("content_version_id", "content_item_id");

-- AddForeignKey
ALTER TABLE "social_version_generations" ADD CONSTRAINT "social_version_generations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_version_generations" ADD CONSTRAINT "social_version_generations_social_post_id_fkey" FOREIGN KEY ("social_post_id") REFERENCES "social_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_version_generations" ADD CONSTRAINT "social_version_generations_content_version_id_content_item_fkey" FOREIGN KEY ("content_version_id", "content_item_id") REFERENCES "content_versions"("id", "content_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_version_generations" ADD CONSTRAINT "social_version_generations_caption_ai_job_id_fkey" FOREIGN KEY ("caption_ai_job_id") REFERENCES "ai_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_version_generations" ADD CONSTRAINT "social_version_generations_hashtag_ai_job_id_fkey" FOREIGN KEY ("hashtag_ai_job_id") REFERENCES "ai_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
