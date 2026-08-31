-- Module 8 Phase 8.1 — AI Internal Linking Engine: Domain + Persistence
-- Foundation. Purely additive: one new table, one new enum, two new
-- AuditAction values. No existing table is altered, dropped, or
-- backfilled.
--
-- AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md Appendix G names
-- `internal_links` as the frozen table for this feature. v1 scope is
-- Blog -> Blog only (Module 8 Architecture Checkpoint Correction,
-- corrected D2), but persistence stays content-item-generic (plain FKs
-- to content_items) so a future content type is a business-logic
-- change, not a schema redesign.

-- CreateEnum
CREATE TYPE "InternalLinkStatus" AS ENUM ('GENERATED', 'ACCEPTED', 'REJECTED', 'STALE');

-- CreateTable
CREATE TABLE "internal_links" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_content_item_id" UUID NOT NULL,
    "target_content_item_id" UUID NOT NULL,
    "anchor_text" TEXT NOT NULL,
    "relevance_score" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "InternalLinkStatus" NOT NULL DEFAULT 'GENERATED',
    "engine_version" INTEGER NOT NULL DEFAULT 1,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "stale_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "internal_links_public_id_key" ON "internal_links"("public_id");

-- CreateIndex
CREATE INDEX "internal_links_workspace_id_source_content_item_id_status_idx" ON "internal_links"("workspace_id", "source_content_item_id", "status");

-- CreateIndex
CREATE INDEX "internal_links_workspace_id_target_content_item_id_status_idx" ON "internal_links"("workspace_id", "target_content_item_id", "status");

-- Module 8 Phase 8.1 — the concurrency authority for D9/D11: at most one
-- LIVE (undecided-or-approved) recommendation per (workspace, source,
-- target) at any time. REJECTED and STALE are deliberately excluded from
-- this scope — they are history, not live state — so a fresh GENERATED
-- row for the same pair after a rejection/staleness is always a normal
-- INSERT, never a resurrection of the old row. Not expressible in
-- Prisma's schema DSL; hand-written here, same precedent as
-- KnowledgePack's own "at most one ACTIVE row per lineage root" partial
-- unique index (20260822144016_knowledge_pack_one_successor_per_predecessor).
CREATE UNIQUE INDEX "internal_links_workspace_source_target_active_unique"
ON "internal_links" ("workspace_id", "source_content_item_id", "target_content_item_id")
WHERE "status" NOT IN ('STALE', 'REJECTED');

-- AddForeignKey
ALTER TABLE "internal_links" ADD CONSTRAINT "internal_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_links" ADD CONSTRAINT "internal_links_source_content_item_id_workspace_id_fkey" FOREIGN KEY ("source_content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_links" ADD CONSTRAINT "internal_links_target_content_item_id_workspace_id_fkey" FOREIGN KEY ("target_content_item_id", "workspace_id") REFERENCES "content_items"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_links" ADD CONSTRAINT "internal_links_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterEnum
-- Module 8 Phase 8.1: one generic status-change action (mirrors
-- CONTENT_ITEM_UPDATED's own generic-action-plus-afterState-diff style)
-- rather than one enum value per GENERATED/ACCEPTED/REJECTED/STALE
-- transition.
ALTER TYPE "AuditAction" ADD VALUE 'INTERNAL_LINK_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'INTERNAL_LINK_STATUS_CHANGED';
