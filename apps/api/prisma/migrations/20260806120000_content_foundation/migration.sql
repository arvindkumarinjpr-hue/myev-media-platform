-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('BLOG', 'VIDEO', 'SHORT', 'REEL', 'NEWSLETTER', 'SOCIAL_POST');

-- CreateEnum
CREATE TYPE "ContentItemStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'REVIEW', 'APPROVED', 'ARCHIVED', 'DELETED', 'RENDERING', 'FAILED', 'SCHEDULED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "ContentReviewAction" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_VERSION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_SUBMITTED_FOR_REVIEW';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_ITEM_SERIES_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_SERIES_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_SERIES_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTENT_SERIES_DELETED';

-- Module 1E correction (same as Module 1D's own migration): Prisma's diff
-- engine generated DROP statements here for
-- workspaces_slug_reservation_fkey / projects_slug_reservation_fkey —
-- Module 1C's hand-written DEFERRABLE INITIALLY DEFERRED composite FKs,
-- invisible to Prisma's schema DSL. Left completely untouched; removed
-- from this migration deliberately. Re-verified via the live Postgres
-- catalog after this migration applies (condeferrable=t, condeferred=t
-- for both, unchanged).

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "content_type" "ContentType" NOT NULL,
    "title" TEXT NOT NULL,
    "current_version_id" UUID,
    "series_id" UUID,
    "featured_media_asset_id" UUID,
    "status" "ContentItemStatus" NOT NULL DEFAULT 'DRAFT',
    "archived_from_status" "ContentItemStatus",
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_versions" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_series" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "name" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "content_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_review_events" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "content_version_id" UUID NOT NULL,
    "action" "ContentReviewAction" NOT NULL,
    "comment" TEXT,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_items_public_id_key" ON "content_items"("public_id");

-- CreateIndex
CREATE INDEX "content_items_workspace_id_idx" ON "content_items"("workspace_id");

-- CreateIndex
CREATE INDEX "content_items_project_id_idx" ON "content_items"("project_id");

-- CreateIndex
CREATE INDEX "content_items_series_id_idx" ON "content_items"("series_id");

-- CreateIndex
CREATE INDEX "content_items_status_idx" ON "content_items"("status");

-- CreateIndex
CREATE INDEX "content_items_content_type_idx" ON "content_items"("content_type");

-- CreateIndex
CREATE UNIQUE INDEX "content_items_id_workspace_id_key" ON "content_items"("id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_items_current_version_id_id_key" ON "content_items"("current_version_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_public_id_key" ON "content_versions"("public_id");

-- CreateIndex
CREATE INDEX "content_versions_content_item_id_idx" ON "content_versions"("content_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_content_item_id_version_number_key" ON "content_versions"("content_item_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_id_content_item_id_key" ON "content_versions"("id", "content_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_series_public_id_key" ON "content_series"("public_id");

-- CreateIndex
CREATE INDEX "content_series_workspace_id_idx" ON "content_series"("workspace_id");

-- CreateIndex
CREATE INDEX "content_series_project_id_idx" ON "content_series"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_series_id_workspace_id_key" ON "content_series"("id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_review_events_public_id_key" ON "content_review_events"("public_id");

-- CreateIndex
CREATE INDEX "content_review_events_content_item_id_idx" ON "content_review_events"("content_item_id");

-- CreateIndex
CREATE INDEX "content_review_events_workspace_id_idx" ON "content_review_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_id_workspace_id_key" ON "media_assets"("id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_id_workspace_id_key" ON "projects"("id", "workspace_id");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_current_version_id_id_fkey" FOREIGN KEY ("current_version_id", "id") REFERENCES "content_versions"("id", "content_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_series_id_workspace_id_fkey" FOREIGN KEY ("series_id", "workspace_id") REFERENCES "content_series"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_featured_media_asset_id_workspace_id_fkey" FOREIGN KEY ("featured_media_asset_id", "workspace_id") REFERENCES "media_assets"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_series" ADD CONSTRAINT "content_series_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_series" ADD CONSTRAINT "content_series_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_series" ADD CONSTRAINT "content_series_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_content_item_id_workspace_id_fkey" FOREIGN KEY ("content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_content_version_id_content_item_id_fkey" FOREIGN KEY ("content_version_id", "content_item_id") REFERENCES "content_versions"("id", "content_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Module 1E: review-comment rules, enforced at the database level as a
-- backstop to DTO/service validation (2000-char bound applies to any
-- comment; REJECTED additionally requires a non-empty, non-whitespace
-- comment). See MODULE 1E ENGINEERING PLAN "Review Comment Limit".
ALTER TABLE "content_review_events" ADD CONSTRAINT "content_review_events_comment_check" CHECK (
  (comment IS NULL OR length(comment) <= 2000)
  AND (action != 'REJECTED' OR (comment IS NOT NULL AND length(trim(comment)) > 0))
);

-- Module 1E: current-version invariant (see MODULE 1E ENGINEERING PLAN —
-- IMPLEMENTATION-READY FINAL, "Corrected Current-Version Invariant"). A
-- deferred trigger defers WHEN it fires, not what data it was queued
-- with — NEW would still reflect the stale INSERT-time row image
-- (current_version_id = NULL) even though a later UPDATE in the same
-- transaction sets it correctly. The function re-reads the row fresh, by
-- id, at execution time, so it validates final committed state, never a
-- stale snapshot.
CREATE FUNCTION content_items_require_current_version() RETURNS trigger AS $$
DECLARE
  final_current_version_id uuid;
  final_deleted_at timestamp;
BEGIN
  SELECT current_version_id, deleted_at
    INTO final_current_version_id, final_deleted_at
  FROM content_items
  WHERE id = NEW.id;

  IF NOT FOUND THEN
    -- Row no longer exists by commit time (hard-deleted within the same
    -- transaction) — not a path Module 1E's own code ever takes, but
    -- nothing to validate against a row that isn't there.
    RETURN NEW;
  END IF;

  IF final_deleted_at IS NULL AND final_current_version_id IS NULL THEN
    RAISE EXCEPTION 'content_items.id=% has no current_version_id at commit (deleted_at IS NULL)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER content_items_current_version_required
  AFTER INSERT OR UPDATE ON content_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION content_items_require_current_version();
