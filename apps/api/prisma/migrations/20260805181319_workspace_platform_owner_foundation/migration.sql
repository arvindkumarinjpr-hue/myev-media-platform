-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "WorkspaceMemberStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "WorkspaceInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'ACCOUNT_ACTIVATION_TOKEN_ROTATED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_SETTINGS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_RESTORED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_OWNERSHIP_TRANSFERRED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_INVITATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_INVITATION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_MEMBER_PENDING_ACTIVATION';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_MEMBER_JOINED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_MEMBER_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_MEMBER_ROLE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_MEMBER_SUSPENDED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_MEMBER_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_MEMBER_LEFT';
ALTER TYPE "AuditAction" ADD VALUE 'WORKSPACE_MEMBER_ACTIVATION_RESENT';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_RESTORED';

-- AlterTable
ALTER TABLE "user_sessions" ADD COLUMN     "last_active_workspace_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_platform_owner" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "owner_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "feature_flags" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_slug_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "workspace_slug_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "WorkspaceMemberStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "invited_by" UUID,
    "joined_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_invitations" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "invited_email" TEXT NOT NULL,
    "invited_user_id" UUID,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "WorkspaceInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_by" UUID NOT NULL,
    "accepted_by" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "public_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "owner_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_slug_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_slug_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_public_id_key" ON "workspaces"("public_id");

-- CreateIndex
CREATE INDEX "workspaces_slug_idx" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_status_idx" ON "workspaces"("status");

-- CreateIndex
CREATE INDEX "workspaces_created_by_idx" ON "workspaces"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_slug_reservations_slug_key" ON "workspace_slug_reservations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_slug_reservations_workspace_id_slug_key" ON "workspace_slug_reservations"("workspace_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_public_id_key" ON "workspace_members"("public_id");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_idx" ON "workspace_members"("workspace_id");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE INDEX "workspace_members_status_idx" ON "workspace_members"("status");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invitations_public_id_key" ON "workspace_invitations"("public_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invitations_token_hash_key" ON "workspace_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_invitations_workspace_id_idx" ON "workspace_invitations"("workspace_id");

-- CreateIndex
CREATE INDEX "workspace_invitations_invited_email_idx" ON "workspace_invitations"("invited_email");

-- CreateIndex
CREATE INDEX "workspace_invitations_status_idx" ON "workspace_invitations"("status");

-- CreateIndex
CREATE INDEX "workspace_invitations_expires_at_idx" ON "workspace_invitations"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "projects_public_id_key" ON "projects"("public_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_idx" ON "projects"("workspace_id");

-- CreateIndex
CREATE INDEX "projects_slug_idx" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_slug_reservations_workspace_id_slug_key" ON "project_slug_reservations"("workspace_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "project_slug_reservations_project_id_slug_key" ON "project_slug_reservations"("project_id", "slug");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_idx" ON "audit_logs"("workspace_id");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_last_active_workspace_id_fkey" FOREIGN KEY ("last_active_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Deferred (not just the composite FK below): workspace creation and its
-- slug reservation are mutually dependent (see MODULE_1C_ENGINEERING PLAN
-- §1) and may be inserted in either order within one transaction. Deferring
-- this FK lets the reservation row be inserted before its workspace row
-- exists yet, with Postgres validating the relationship only at COMMIT.
ALTER TABLE "workspace_slug_reservations" ADD CONSTRAINT "workspace_slug_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_slug_reservations" ADD CONSTRAINT "project_slug_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Deferred for the same reason as workspace_slug_reservations_workspace_id_fkey
-- above — project creation and its slug reservation are mutually dependent
-- and may be inserted in either order within one transaction.
ALTER TABLE "project_slug_reservations" ADD CONSTRAINT "project_slug_reservations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Module 1C Engineering Plan §1: composite foreign keys making it a hard,
-- Postgres-enforced guarantee (not an application-level convention) that
-- workspaces.slug / projects.slug can never hold a value without a matching,
-- permanent reservation row for that exact resource. Deferred for the same
-- circular-dependency reason as the two FKs above; the reservation tables'
-- own UNIQUE constraints (immediate, not deferred) remain the actual
-- collision-detection mechanism — these composite FKs only guarantee
-- consistency between "current slug" and "the reservation ledger", not
-- uniqueness by themselves.
ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_slug_reservation_fkey"
  FOREIGN KEY ("id", "slug") REFERENCES "workspace_slug_reservations" ("workspace_id", "slug")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_slug_reservation_fkey"
  FOREIGN KEY ("id", "slug") REFERENCES "project_slug_reservations" ("project_id", "slug")
  DEFERRABLE INITIALLY DEFERRED;

-- Module 1C Engineering Plan §2: at most one non-deleted user may have
-- is_platform_owner = true. A partial unique index is the correct Postgres
-- idiom here — every row admitted by the predicate has the same indexed
-- value (true), so a second admitted row would collide. Not representable
-- in Prisma's schema DSL (no partial/filtered unique index support), hence
-- raw SQL.
CREATE UNIQUE INDEX "users_single_platform_owner"
  ON "users" ("is_platform_owner")
  WHERE "is_platform_owner" = true AND "deleted_at" IS NULL;

-- Module 1C Engineering Plan §2.C: prevents duplicate concurrent PENDING
-- invitations to the same email within one workspace — a DB-level backstop
-- on top of the application-level "supersede prior pending" check. Not
-- representable in Prisma's schema DSL (no partial/filtered unique index
-- support), hence raw SQL.
CREATE UNIQUE INDEX "workspace_invitations_pending_email_unique"
  ON "workspace_invitations" ("workspace_id", "invited_email")
  WHERE "status" = 'PENDING';
