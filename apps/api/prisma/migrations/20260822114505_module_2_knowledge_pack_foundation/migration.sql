-- CreateEnum
CREATE TYPE "KnowledgePackStatus" AS ENUM ('DRAFT', 'VALIDATING', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "KnowledgeSourceType" AS ENUM ('GOVERNMENT', 'ASSOCIATION', 'COMPANY', 'PUBLICATION', 'RSS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_PACK_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_PACK_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_PACK_VALIDATION_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_PACK_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_PACK_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_PACK_DELETED';

-- Module 2 Phase 2.1: Prisma's diff engine proposed dropping
-- "projects_slug_reservation_fkey" and "workspaces_slug_reservation_fkey"
-- here. Both are hand-written DEFERRABLE INITIALLY DEFERRED constraints
-- from earlier migrations (Module 1C) that Prisma's schema DSL cannot
-- express and therefore does not know about — its shadow-database diff
-- treats them as "unrecognized" on any migration touching these tables
-- and proposes removing them with no re-add, which would silently break
-- workspace/project slug-reservation referential integrity repo-wide.
-- Deliberately not applied. Neither constraint is touched by this
-- migration.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "knowledge_pack_id" UUID;

-- CreateTable
CREATE TABLE "knowledge_packs" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "industry_profile" JSONB NOT NULL DEFAULT '{}',
    "publishing_strategy" JSONB NOT NULL DEFAULT '{}',
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "current_version_of" UUID,
    "lineage_root_id" UUID NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 1,
    "status" "KnowledgePackStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "knowledge_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" UUID NOT NULL,
    "knowledge_pack_id" UUID NOT NULL,
    "source_type" "KnowledgeSourceType" NOT NULL,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" UUID NOT NULL,
    "knowledge_pack_id" UUID NOT NULL,
    "content_type" "ContentType" NOT NULL,
    "prompt_body" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_rules" (
    "id" UUID NOT NULL,
    "knowledge_pack_id" UUID NOT NULL,
    "primary_keywords" JSONB NOT NULL DEFAULT '[]',
    "secondary_keywords" JSONB NOT NULL DEFAULT '[]',
    "internal_linking_policy" JSONB NOT NULL DEFAULT '{}',
    "schema_preferences" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_guidelines" (
    "id" UUID NOT NULL,
    "knowledge_pack_id" UUID NOT NULL,
    "tone_of_voice" TEXT,
    "terminology" JSONB NOT NULL DEFAULT '{}',
    "cta_rules" TEXT,
    "logo_asset_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_guidelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keyword_sets" (
    "id" UUID NOT NULL,
    "knowledge_pack_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "keyword_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" UUID NOT NULL,
    "knowledge_pack_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_packs_public_id_key" ON "knowledge_packs"("public_id");

-- CreateIndex
CREATE INDEX "knowledge_packs_workspace_id_idx" ON "knowledge_packs"("workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_packs_project_id_idx" ON "knowledge_packs"("project_id");

-- CreateIndex
CREATE INDEX "knowledge_packs_lineage_root_id_idx" ON "knowledge_packs"("lineage_root_id");

-- CreateIndex
CREATE INDEX "knowledge_packs_status_idx" ON "knowledge_packs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_packs_id_workspace_id_key" ON "knowledge_packs"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "knowledge_sources_knowledge_pack_id_idx" ON "knowledge_sources"("knowledge_pack_id");

-- CreateIndex
CREATE INDEX "prompt_templates_knowledge_pack_id_idx" ON "prompt_templates"("knowledge_pack_id");

-- CreateIndex
CREATE INDEX "prompt_templates_knowledge_pack_id_content_type_idx" ON "prompt_templates"("knowledge_pack_id", "content_type");

-- CreateIndex
CREATE INDEX "seo_rules_knowledge_pack_id_idx" ON "seo_rules"("knowledge_pack_id");

-- CreateIndex
CREATE INDEX "brand_guidelines_knowledge_pack_id_idx" ON "brand_guidelines"("knowledge_pack_id");

-- CreateIndex
CREATE INDEX "keyword_sets_knowledge_pack_id_idx" ON "keyword_sets"("knowledge_pack_id");

-- CreateIndex
CREATE INDEX "competitors_knowledge_pack_id_idx" ON "competitors"("knowledge_pack_id");

-- CreateIndex
CREATE INDEX "projects_knowledge_pack_id_idx" ON "projects"("knowledge_pack_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_knowledge_pack_id_workspace_id_fkey" FOREIGN KEY ("knowledge_pack_id", "workspace_id") REFERENCES "knowledge_packs"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_packs" ADD CONSTRAINT "knowledge_packs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_packs" ADD CONSTRAINT "knowledge_packs_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_packs" ADD CONSTRAINT "knowledge_packs_current_version_of_workspace_id_fkey" FOREIGN KEY ("current_version_of", "workspace_id") REFERENCES "knowledge_packs"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_packs" ADD CONSTRAINT "knowledge_packs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_packs" ADD CONSTRAINT "knowledge_packs_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_knowledge_pack_id_fkey" FOREIGN KEY ("knowledge_pack_id") REFERENCES "knowledge_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_knowledge_pack_id_fkey" FOREIGN KEY ("knowledge_pack_id") REFERENCES "knowledge_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_rules" ADD CONSTRAINT "seo_rules_knowledge_pack_id_fkey" FOREIGN KEY ("knowledge_pack_id") REFERENCES "knowledge_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_guidelines" ADD CONSTRAINT "brand_guidelines_knowledge_pack_id_fkey" FOREIGN KEY ("knowledge_pack_id") REFERENCES "knowledge_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_guidelines" ADD CONSTRAINT "brand_guidelines_logo_asset_id_fkey" FOREIGN KEY ("logo_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keyword_sets" ADD CONSTRAINT "keyword_sets_knowledge_pack_id_fkey" FOREIGN KEY ("knowledge_pack_id") REFERENCES "knowledge_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_knowledge_pack_id_fkey" FOREIGN KEY ("knowledge_pack_id") REFERENCES "knowledge_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ACR-014 / ADR-014: at most one non-deleted ACTIVE row per lineage_root_id
-- — the invariant FRD §24.3 requires ("exactly one Active version at a
-- time"). Not expressible in Prisma's schema DSL, same limitation already
-- worked around in Module 1D (media_assets_one_active_version_per_group)
-- and Module 1C (users_single_platform_owner,
-- workspace_invitations_pending_email_unique). Hand-written here.
CREATE UNIQUE INDEX "knowledge_packs_one_active_per_lineage"
  ON "knowledge_packs" ("lineage_root_id")
  WHERE "status" = 'ACTIVE' AND "deleted_at" IS NULL;
