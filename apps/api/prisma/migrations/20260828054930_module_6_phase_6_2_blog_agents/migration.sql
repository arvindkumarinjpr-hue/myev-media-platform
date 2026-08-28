-- Module 6 Phase 6.2: Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 / 5.1 / 6.1 migrations' own
-- notes). Deliberately not applied. Neither constraint is touched by this
-- migration.

-- Module 6 Phase 6.2 — Blog Automation.
-- AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md §5.4: blog_articles, the
-- 1:1 (content_type = BLOG) extension row (meta_title, meta_description,
-- url_slug, schema_markup). Purely additive: one new table, no ALTER to
-- any existing table, no enum change.

-- CreateTable
CREATE TABLE "blog_articles" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "meta_title" TEXT NOT NULL,
    "meta_description" TEXT NOT NULL,
    "url_slug" TEXT NOT NULL,
    "schema_markup" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "blog_articles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blog_articles_public_id_key" ON "blog_articles"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "blog_articles_content_item_id_key" ON "blog_articles"("content_item_id");

-- CreateIndex
CREATE INDEX "blog_articles_workspace_id_idx" ON "blog_articles"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "blog_articles_content_item_id_workspace_id_key" ON "blog_articles"("content_item_id", "workspace_id");

-- AddForeignKey
ALTER TABLE "blog_articles" ADD CONSTRAINT "blog_articles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_articles" ADD CONSTRAINT "blog_articles_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_articles" ADD CONSTRAINT "blog_articles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_articles" ADD CONSTRAINT "blog_articles_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
