-- CreateEnum
CREATE TYPE "SearchIntent" AS ENUM ('INFORMATIONAL', 'TRANSACTIONAL', 'NAVIGATIONAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "KeywordClusterMembership" AS ENUM ('PRIMARY', 'SECONDARY');

-- Module 5 Phase 5.1: Prisma's diff engine again proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here (the same hand-written DEFERRABLE constraints its shadow-database
-- diff doesn't recognize — see the Phase 2.1 migration's own note).
-- Deliberately not applied. Neither constraint is touched by this
-- migration.

-- CreateTable
CREATE TABLE "keywords" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "search_intent" "SearchIntent" NOT NULL,
    "opportunity_score" INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keyword_clusters" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "source_ai_job_id" UUID NOT NULL,
    "knowledge_pack_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "keyword_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keyword_cluster_members" (
    "id" UUID NOT NULL,
    "keyword_cluster_id" UUID NOT NULL,
    "keyword_id" UUID NOT NULL,
    "membership" "KeywordClusterMembership" NOT NULL,

    CONSTRAINT "keyword_cluster_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_clusters" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyword_cluster_id" UUID NOT NULL,
    "content_series_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topic_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "keywords_public_id_key" ON "keywords"("public_id");

-- CreateIndex
CREATE INDEX "keywords_workspace_id_idx" ON "keywords"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "keywords_workspace_id_term_key" ON "keywords"("workspace_id", "term");

-- CreateIndex
CREATE UNIQUE INDEX "keyword_clusters_public_id_key" ON "keyword_clusters"("public_id");

-- CreateIndex
CREATE INDEX "keyword_clusters_workspace_id_idx" ON "keyword_clusters"("workspace_id");

-- CreateIndex
CREATE INDEX "keyword_clusters_source_ai_job_id_idx" ON "keyword_clusters"("source_ai_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "keyword_clusters_workspace_id_source_ai_job_id_topic_key" ON "keyword_clusters"("workspace_id", "source_ai_job_id", "topic");

-- CreateIndex
CREATE INDEX "keyword_cluster_members_keyword_cluster_id_idx" ON "keyword_cluster_members"("keyword_cluster_id");

-- CreateIndex
CREATE INDEX "keyword_cluster_members_keyword_id_idx" ON "keyword_cluster_members"("keyword_id");

-- CreateIndex
CREATE UNIQUE INDEX "keyword_cluster_members_keyword_cluster_id_keyword_id_key" ON "keyword_cluster_members"("keyword_cluster_id", "keyword_id");

-- CreateIndex
CREATE UNIQUE INDEX "topic_clusters_public_id_key" ON "topic_clusters"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "topic_clusters_keyword_cluster_id_key" ON "topic_clusters"("keyword_cluster_id");

-- CreateIndex
CREATE INDEX "topic_clusters_workspace_id_idx" ON "topic_clusters"("workspace_id");

-- CreateIndex
CREATE INDEX "topic_clusters_content_series_id_idx" ON "topic_clusters"("content_series_id");

-- AddForeignKey
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_clusters" ADD CONSTRAINT "keyword_clusters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_clusters" ADD CONSTRAINT "keyword_clusters_source_ai_job_id_fkey" FOREIGN KEY ("source_ai_job_id") REFERENCES "ai_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_clusters" ADD CONSTRAINT "keyword_clusters_knowledge_pack_id_workspace_id_fkey" FOREIGN KEY ("knowledge_pack_id", "workspace_id") REFERENCES "knowledge_packs"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_clusters" ADD CONSTRAINT "keyword_clusters_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_cluster_members" ADD CONSTRAINT "keyword_cluster_members_keyword_cluster_id_fkey" FOREIGN KEY ("keyword_cluster_id") REFERENCES "keyword_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_cluster_members" ADD CONSTRAINT "keyword_cluster_members_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_clusters" ADD CONSTRAINT "topic_clusters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_clusters" ADD CONSTRAINT "topic_clusters_keyword_cluster_id_fkey" FOREIGN KEY ("keyword_cluster_id") REFERENCES "keyword_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_clusters" ADD CONSTRAINT "topic_clusters_content_series_id_workspace_id_fkey" FOREIGN KEY ("content_series_id", "workspace_id") REFERENCES "content_series"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_clusters" ADD CONSTRAINT "topic_clusters_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'TOPIC_CLUSTER_CREATED';
