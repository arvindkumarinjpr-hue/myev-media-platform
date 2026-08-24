-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'AI_EXECUTION_REQUESTED';

-- Module 3 Phase 3.2: Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 migration's own note).
-- Deliberately not applied. Neither constraint is touched by this
-- migration.

-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "agent_name" TEXT NOT NULL,
    "agent_version" INTEGER NOT NULL,
    "triggering_module" TEXT NOT NULL,
    "knowledge_pack_id" UUID NOT NULL,
    "input_payload" JSONB NOT NULL,
    "output_payload" JSONB,
    "provider_used" TEXT,
    "model_used" TEXT,
    "token_usage" JSONB,
    "cost_estimate" DECIMAL(10,6),
    "status" "AiJobStatus" NOT NULL DEFAULT 'QUEUED',
    "error_code" TEXT,
    "error_message_safe" TEXT,
    "correlation_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_job_steps" (
    "id" UUID NOT NULL,
    "ai_job_id" UUID NOT NULL,
    "step_name" TEXT NOT NULL,
    "step_status" "AiJobStatus" NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ai_job_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_jobs_public_id_key" ON "ai_jobs"("public_id");

-- CreateIndex
CREATE INDEX "ai_jobs_workspace_id_idx" ON "ai_jobs"("workspace_id");

-- CreateIndex
CREATE INDEX "ai_jobs_status_idx" ON "ai_jobs"("status");

-- CreateIndex
CREATE INDEX "ai_jobs_status_created_at_idx" ON "ai_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "ai_jobs_knowledge_pack_id_idx" ON "ai_jobs"("knowledge_pack_id");

-- CreateIndex
CREATE INDEX "ai_jobs_correlation_id_idx" ON "ai_jobs"("correlation_id");

-- CreateIndex
CREATE INDEX "ai_job_steps_ai_job_id_idx" ON "ai_job_steps"("ai_job_id");

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_knowledge_pack_id_workspace_id_fkey" FOREIGN KEY ("knowledge_pack_id", "workspace_id") REFERENCES "knowledge_packs"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_job_steps" ADD CONSTRAINT "ai_job_steps_ai_job_id_fkey" FOREIGN KEY ("ai_job_id") REFERENCES "ai_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
