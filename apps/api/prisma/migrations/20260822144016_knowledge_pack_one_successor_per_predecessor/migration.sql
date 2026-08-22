-- Phase 2.4: version-creation concurrency. Two concurrent requests to
-- create the next Draft version from the same Active predecessor must not
-- be able to produce two divergent successors (and therefore two rows
-- both computing the same next version_number). Not expressible in
-- Prisma's schema DSL (a partial index) — same hand-written-migration
-- pattern already established for knowledge_packs_one_active_per_lineage,
-- users_single_platform_owner, workspace_invitations_pending_email_unique,
-- and media_assets_one_active_version_per_group.
--
-- Excludes soft-deleted rows: if a Draft successor is deleted (KP_DELETE,
-- Draft-only), the predecessor must be able to spawn a fresh successor.
CREATE UNIQUE INDEX "knowledge_packs_one_successor_per_predecessor"
  ON "knowledge_packs" ("current_version_of")
  WHERE "current_version_of" IS NOT NULL AND "deleted_at" IS NULL;
