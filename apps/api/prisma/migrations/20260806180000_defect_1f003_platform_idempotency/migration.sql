-- DEFECT-1F-003: standard UNIQUE(workspace_id, idempotency_key) does not
-- deduplicate rows where workspace_id IS NULL (standard SQL NULL
-- semantics — NULL is never equal to NULL), silently disabling
-- authoritative idempotency for the schema's own documented, intended
-- "genuine platform-level system job" state. Replaced with two explicit
-- partial unique indexes so Postgres enforces uniqueness correctly in
-- both cases, without any application-only workaround.

DROP INDEX "background_jobs_workspace_id_idempotency_key_key";

-- Workspace-scoped jobs: uniqueness per (workspace_id, idempotency_key),
-- only when both are actually present.
CREATE UNIQUE INDEX "background_jobs_workspace_idempotency_unique"
ON "background_jobs" ("workspace_id", "idempotency_key")
WHERE "workspace_id" IS NOT NULL
  AND "idempotency_key" IS NOT NULL;

-- Platform-level jobs (workspace_id IS NULL): uniqueness per
-- idempotency_key alone within that scope.
CREATE UNIQUE INDEX "background_jobs_platform_idempotency_unique"
ON "background_jobs" ("idempotency_key")
WHERE "workspace_id" IS NULL
  AND "idempotency_key" IS NOT NULL;

-- Deployment note (not a request to change this migration): plain
-- CREATE UNIQUE INDEX is used intentionally here, not CREATE INDEX
-- CONCURRENTLY, because Prisma's `migrate deploy` executes each
-- migration.sql inside a single transaction, and CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block (verified directly
-- against Postgres: "ERROR: CREATE INDEX CONCURRENTLY cannot run inside
-- a transaction block"). At this migration's original deployment size
-- (a few hundred rows), the brief table lock this takes is negligible.
-- If `background_jobs` has grown substantially by the time this ships to
-- a real production environment, apply the two CREATE UNIQUE INDEX
-- statements above as a separate, dedicated non-transactional migration
-- using CREATE INDEX CONCURRENTLY instead, following Prisma's documented
-- workflow for concurrent index creation
-- (https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations#create-indexes-concurrently)
-- rather than replaying this file verbatim against a large, live table.
