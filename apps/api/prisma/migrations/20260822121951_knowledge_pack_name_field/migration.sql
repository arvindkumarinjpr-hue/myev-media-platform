-- Phase 2.2: knowledge_packs.name — see the model comment in schema.prisma.
-- Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 migration's own note).
-- Deliberately not applied. Neither constraint is touched by this
-- migration. Table is empty (no Knowledge Pack has ever been created,
-- Phase 2.2 is the first module to expose a create endpoint), so the
-- required NOT NULL column is safe to add directly.
ALTER TABLE "knowledge_packs" ADD COLUMN "name" TEXT NOT NULL;
