-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM');

-- Module 10 Phase 10.1: Prisma's own diff engine proposed dropping
-- "projects_slug_reservation_fkey"/"workspaces_slug_reservation_fkey"
-- here. Both are pre-existing, intentional deferred/circular foreign
-- keys added by hand via raw SQL in earlier migrations (Module 1C
-- Engineering Plan §1 — "a deferred composite foreign key added via raw
-- SQL") — schema.prisma has never been able to express them in its own
-- DSL, so Prisma always proposes dropping them on any new diff against
-- this schema, regardless of what actually changed. Deliberately
-- removed from this migration; neither constraint is touched.

-- CreateTable
CREATE TABLE "social_posts" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "source_content_item_id" UUID NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_posts_public_id_key" ON "social_posts"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_posts_content_item_id_key" ON "social_posts"("content_item_id");

-- CreateIndex
CREATE INDEX "social_posts_workspace_id_idx" ON "social_posts"("workspace_id");

-- CreateIndex
CREATE INDEX "social_posts_source_content_item_id_idx" ON "social_posts"("source_content_item_id");

-- CreateIndex
CREATE INDEX "social_posts_workspace_id_platform_idx" ON "social_posts"("workspace_id", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "social_posts_content_item_id_workspace_id_key" ON "social_posts"("content_item_id", "workspace_id");

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_source_content_item_id_workspace_id_fkey" FOREIGN KEY ("source_content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
