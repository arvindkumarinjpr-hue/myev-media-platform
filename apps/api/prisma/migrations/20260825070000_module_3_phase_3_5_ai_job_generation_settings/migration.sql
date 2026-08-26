-- Module 3 Phase 3.5: Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 migration's own note).
-- Deliberately not applied. Neither constraint is touched by this
-- migration.

-- AlterTable
ALTER TABLE "ai_jobs" ADD COLUMN     "generation_settings" JSONB;
