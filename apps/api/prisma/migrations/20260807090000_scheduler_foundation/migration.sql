-- Module 1F Milestone 7 (Scheduler Foundation), Revision 3.
-- New, purely additive: one enum, one table, five new AuditAction
-- values. Nothing from any prior milestone is altered here (the two
-- pre-existing, unrelated projects/workspaces slug-reservation FK drift
-- items surfaced by `prisma migrate diff` are intentionally NOT included
-- in this migration — they predate Milestone 7 and are out of scope).

-- CreateEnum
CREATE TYPE "ScheduleIdempotencyStrategy" AS ENUM ('SCHEDULE_TICK_TIMESTAMP');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_ENABLED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_DELETED';

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID,
    "job_type" TEXT NOT NULL,
    "payload_metadata" JSONB NOT NULL DEFAULT '{}',
    "cron_expression" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "last_error_message_safe" TEXT,
    "idempotency_strategy" "ScheduleIdempotencyStrategy" NOT NULL DEFAULT 'SCHEDULE_TICK_TIMESTAMP',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_public_id_key" ON "scheduled_jobs"("public_id");

-- CreateIndex
CREATE INDEX "scheduled_jobs_workspace_id_idx" ON "scheduled_jobs"("workspace_id");

-- CreateIndex
CREATE INDEX "scheduled_jobs_enabled_idx" ON "scheduled_jobs"("enabled");

-- CreateIndex
CREATE INDEX "scheduled_jobs_job_type_idx" ON "scheduled_jobs"("job_type");

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
