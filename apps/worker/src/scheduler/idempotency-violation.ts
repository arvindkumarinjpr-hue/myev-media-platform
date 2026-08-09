import { Prisma } from "../../../api/generated/prisma";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/**
 * Duplicated, Worker-local copy of
 * apps/api/src/modules/background-jobs/background-jobs.service.ts's own
 * isExpectedIdempotencyViolation — the already-approved resolution (this
 * session, prior to Milestone 7 implementation) for "enqueue through the
 * existing Job Lifecycle service": BackgroundJobsService.enqueue()
 * cannot be called across the API/Worker process boundary (no HTTP
 * round-trip per the frozen Open Decision #9, and apps/api/src is not
 * even present in the worker's own Docker image), so the identical
 * algorithm is duplicated here rather than the frozen apps/api file
 * being refactored to share it. Keep this in exact lockstep with the
 * apps/api original if DEFECT-1F-003's fix (the two partial unique
 * indexes) is ever revisited.
 */
export function isExpectedIdempotencyViolation(error: unknown, workspaceId: string | null): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== UNIQUE_CONSTRAINT_VIOLATION) {
    return false;
  }
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  const expected = workspaceId === null ? ["idempotency_key"] : ["workspace_id", "idempotency_key"];
  return targets.length === expected.length && expected.every((column) => targets.includes(column));
}
