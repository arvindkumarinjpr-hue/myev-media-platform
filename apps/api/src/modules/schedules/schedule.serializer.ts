import type { ScheduledJob } from "../../../generated/prisma";

// publicId only, per Revision 3 §4/§11's "public IDs only" rule — no
// internal id, no workspaceId (redundant/internal within a scope-fixed
// response, same reasoning as background-jobs' own serializer), no
// createdById/updatedById raw internal FKs.
export function serializeSchedule(schedule: ScheduledJob) {
  return {
    publicId: schedule.publicId,
    jobType: schedule.jobType,
    payload: schedule.payloadMetadata,
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    lastSuccessAt: schedule.lastSuccessAt,
    lastFailureAt: schedule.lastFailureAt,
    lastErrorCode: schedule.lastErrorCode,
    lastErrorMessageSafe: schedule.lastErrorMessageSafe,
    version: schedule.version,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}
