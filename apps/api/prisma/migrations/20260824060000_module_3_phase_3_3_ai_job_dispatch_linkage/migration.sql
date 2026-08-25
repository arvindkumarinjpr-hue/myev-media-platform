-- Module 3 Phase 3.3: Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 migration's own note).
-- Deliberately not applied. Neither constraint is touched by this
-- migration.

-- AlterTable
ALTER TABLE "ai_jobs" ADD COLUMN     "background_job_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "ai_jobs_background_job_id_key" ON "ai_jobs"("background_job_id");

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_background_job_id_fkey" FOREIGN KEY ("background_job_id") REFERENCES "background_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
