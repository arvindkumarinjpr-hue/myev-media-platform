/*
  Warnings:

  - Added the required column `caption_ai_job_id` to the `social_posts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `hashtag_ai_job_id` to the `social_posts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source_content_version_id` to the `social_posts` table without a default value. This is not possible if the table is not empty.

*/
-- NOTE (manually removed by the same known, previously-documented cause as
-- migration 20260905142237's own note): Prisma's diff engine always
-- proposes DROP CONSTRAINT projects_slug_reservation_fkey /
-- workspaces_slug_reservation_fkey on ANY new migration against this
-- schema, because those two FKs were added via raw SQL in an earlier
-- Module 1C migration (deferred/circular FKs, invisible to Prisma's own
-- schema DSL) — not a real schema conflict. Verified after applying this
-- migration that both constraints remain intact.

-- AlterTable
ALTER TABLE "social_posts" ADD COLUMN     "caption_ai_job_id" UUID NOT NULL,
ADD COLUMN     "hashtag_ai_job_id" UUID NOT NULL,
ADD COLUMN     "source_content_version_id" UUID NOT NULL;

-- CreateIndex
CREATE INDEX "social_posts_source_content_version_id_idx" ON "social_posts"("source_content_version_id");

-- CreateIndex
CREATE INDEX "social_posts_caption_ai_job_id_idx" ON "social_posts"("caption_ai_job_id");

-- CreateIndex
CREATE INDEX "social_posts_hashtag_ai_job_id_idx" ON "social_posts"("hashtag_ai_job_id");

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_source_content_version_id_source_content_item_fkey" FOREIGN KEY ("source_content_version_id", "source_content_item_id") REFERENCES "content_versions"("id", "content_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_caption_ai_job_id_fkey" FOREIGN KEY ("caption_ai_job_id") REFERENCES "ai_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_hashtag_ai_job_id_fkey" FOREIGN KEY ("hashtag_ai_job_id") REFERENCES "ai_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
