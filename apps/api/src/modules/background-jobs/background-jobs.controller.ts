import { Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import type { BackgroundJob } from "../../../generated/prisma";
import { BackgroundJobsService } from "./background-jobs.service";
import { ListBackgroundJobsDto } from "./dto/list-background-jobs.dto";

// Internal FKs (workspaceId — redundant in a workspace-scoped response
// anyway — and createdById/parentJobId's raw internal ids) are
// deliberately omitted rather than resolved to public ids: no consumer
// needs them yet, and omission is always safe (see DEFECT-1D-001's
// precedent for what happens when a raw internal FK leaks instead).
function serializeJob(job: BackgroundJob) {
  return {
    publicId: job.publicId,
    jobType: job.jobType,
    queueName: job.queueName,
    status: job.status,
    payloadMetadata: job.payloadMetadata,
    resultMetadata: job.resultMetadata,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    scheduledAt: job.scheduledAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    cancellationRequestedAt: job.cancellationRequestedAt,
    cancelledAt: job.cancelledAt,
    deadLetteredAt: job.deadLetteredAt,
    errorCode: job.errorCode,
    errorMessageSafe: job.errorMessageSafe,
    correlationId: job.correlationId,
    processorVersion: job.processorVersion,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

@Controller("api/v1/workspaces/:workspaceId/background-jobs")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class BackgroundJobsController {
  constructor(private readonly backgroundJobs: BackgroundJobsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.JOB_VIEW)
  async list(@CurrentWorkspace() workspace: WorkspaceContext, @Query() query: ListBackgroundJobsDto) {
    const jobs = await this.backgroundJobs.list(workspace.id, { status: query.status, jobType: query.jobType, limit: query.limit });
    return { data: jobs.map(serializeJob) };
  }

  @Get(":jobId")
  @RequirePermission(PERMISSIONS.JOB_VIEW)
  async get(@CurrentWorkspace() workspace: WorkspaceContext, @Param("jobId") jobId: string) {
    const job = await this.backgroundJobs.get(workspace.id, jobId);
    return { data: serializeJob(job) };
  }

  @Post(":jobId/cancel")
  @RequirePermission(PERMISSIONS.JOB_MANAGE)
  async cancel(@CurrentWorkspace() workspace: WorkspaceContext, @Param("jobId") jobId: string, @Req() req: Request) {
    const job = await this.backgroundJobs.requestCancel(workspace.id, jobId, workspace.userInternalId, req.ip);
    return { data: serializeJob(job) };
  }

  @Post(":jobId/retry")
  @RequirePermission(PERMISSIONS.JOB_MANAGE)
  async retry(@CurrentWorkspace() workspace: WorkspaceContext, @Param("jobId") jobId: string, @Req() req: Request) {
    const job = await this.backgroundJobs.requestRetry(workspace.id, jobId, workspace.userInternalId, req.ip);
    return { data: serializeJob(job) };
  }
}
