-- Module 6 Phase 6.1: Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 / Phase 5.1 migrations' own
-- notes). Deliberately not applied. Neither constraint is touched by this
-- migration.

-- Module 6 Phase 6.1 — Content Scoring Engine (shared foundation).
-- AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md §5.10 (content_scores) and
-- §5.8 (seo_reports). Purely additive: two new append-only score-history
-- tables, no ALTER to any existing table, no enum change.

-- CreateTable
CREATE TABLE "content_scores" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "factors" JSONB NOT NULL,
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_reports" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "seo_score" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seo_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_scores_public_id_key" ON "content_scores"("public_id");

-- CreateIndex
CREATE INDEX "content_scores_workspace_id_idx" ON "content_scores"("workspace_id");

-- CreateIndex
CREATE INDEX "content_scores_content_item_id_idx" ON "content_scores"("content_item_id");

-- CreateIndex
CREATE INDEX "content_scores_content_item_id_calculated_at_idx" ON "content_scores"("content_item_id", "calculated_at");

-- CreateIndex
CREATE UNIQUE INDEX "seo_reports_public_id_key" ON "seo_reports"("public_id");

-- CreateIndex
CREATE INDEX "seo_reports_workspace_id_idx" ON "seo_reports"("workspace_id");

-- CreateIndex
CREATE INDEX "seo_reports_content_item_id_idx" ON "seo_reports"("content_item_id");

-- CreateIndex
CREATE INDEX "seo_reports_content_item_id_calculated_at_idx" ON "seo_reports"("content_item_id", "calculated_at");

-- AddForeignKey
ALTER TABLE "content_scores" ADD CONSTRAINT "content_scores_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_scores" ADD CONSTRAINT "content_scores_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_scores" ADD CONSTRAINT "content_scores_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_reports" ADD CONSTRAINT "seo_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_reports" ADD CONSTRAINT "seo_reports_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_reports" ADD CONSTRAINT "seo_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
