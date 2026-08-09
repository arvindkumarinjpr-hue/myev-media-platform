-- CreateEnum
CREATE TYPE "QueueName" AS ENUM ('CRITICAL', 'REALTIME', 'AI', 'MEDIA', 'PUBLISHING', 'ANALYTICS', 'MAINTENANCE', 'NOTIFICATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "BackgroundJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'JOB_CANCELLATION_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'JOB_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'JOB_RETRY_REQUESTED';

-- Module 1F correction (same as every prior module's migration): Prisma's
-- diff engine generated DROP statements here for
-- workspaces_slug_reservation_fkey / projects_slug_reservation_fkey —
-- Module 1C's hand-written DEFERRABLE INITIALLY DEFERRED composite FKs,
-- invisible to Prisma's schema DSL. Left completely untouched; removed
-- from this migration deliberately. Re-verified via the live Postgres
-- catalog after this migration applies (condeferrable=t, condeferred=t
-- for both, unchanged).

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID,
    "job_type" TEXT NOT NULL,
    "queue_name" "QueueName" NOT NULL,
    "bullmq_job_id" TEXT,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload_metadata" JSONB NOT NULL DEFAULT '{}',
    "result_metadata" JSONB,
    "progress" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "idempotency_key" TEXT,
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "cancellation_requested_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "dead_lettered_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_message_safe" TEXT,
    "correlation_id" TEXT NOT NULL,
    "parent_job_id" UUID,
    "processor_version" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_history" (
    "id" UUID NOT NULL,
    "background_job_id" UUID NOT NULL,
    "from_status" "BackgroundJobStatus",
    "to_status" "BackgroundJobStatus" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB,

    CONSTRAINT "job_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "worker_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "process_id" INTEGER NOT NULL,
    "application_version" TEXT NOT NULL,
    "queue_assignments" JSONB NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL,
    "workspace_id" UUID,
    "correlation_id" TEXT,
    "causation_id" TEXT,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMP(3),

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_public_id_key" ON "background_jobs"("public_id");

-- CreateIndex
CREATE INDEX "background_jobs_workspace_id_idx" ON "background_jobs"("workspace_id");

-- CreateIndex
CREATE INDEX "background_jobs_status_idx" ON "background_jobs"("status");

-- CreateIndex
CREATE INDEX "background_jobs_job_type_idx" ON "background_jobs"("job_type");

-- CreateIndex
CREATE INDEX "background_jobs_queue_name_idx" ON "background_jobs"("queue_name");

-- CreateIndex
CREATE INDEX "background_jobs_parent_job_id_idx" ON "background_jobs"("parent_job_id");

-- CreateIndex
CREATE INDEX "background_jobs_correlation_id_idx" ON "background_jobs"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_workspace_id_idempotency_key_key" ON "background_jobs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "job_history_background_job_id_idx" ON "job_history"("background_job_id");

-- CreateIndex
CREATE INDEX "worker_heartbeats_last_heartbeat_at_idx" ON "worker_heartbeats"("last_heartbeat_at");

-- CreateIndex
CREATE INDEX "domain_events_workspace_id_idx" ON "domain_events"("workspace_id");

-- CreateIndex
CREATE INDEX "domain_events_correlation_id_idx" ON "domain_events"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_event_id_consumer_name_key" ON "processed_events"("event_id", "consumer_name");

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_parent_job_id_fkey" FOREIGN KEY ("parent_job_id") REFERENCES "background_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_history" ADD CONSTRAINT "job_history_background_job_id_fkey" FOREIGN KEY ("background_job_id") REFERENCES "background_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "domain_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Module 1F: hand-written partial index — Prisma's schema DSL cannot
-- express a WHERE clause on an index. This is the outbox relay's actual
-- poll query shape (Module 1F Engineering Plan §11): undispatched rows,
-- oldest first. A plain index on dispatched_at would also work but scans
-- a growing number of already-dispatched rows the relay never needs;
-- this partial index only ever contains the (small, bounded) undispatched
-- subset, keeping the poll cheap regardless of how large domain_events
-- grows overall.
CREATE INDEX "domain_events_undispatched_idx" ON "domain_events" ("occurred_at") WHERE "dispatched_at" IS NULL;
