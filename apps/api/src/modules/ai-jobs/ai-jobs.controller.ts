import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import type { AiJob } from "../../../generated/prisma";
import { AiJobSubmissionService } from "./ai-job-submission.service";
import { CreateAiJobDto } from "./dto/create-ai-job.dto";

/**
 * Module 3 Phase 3.3 — the generic, agent-agnostic durable AI Job API
 * (API_AND_INTEGRATION_SPECIFICATION_V1.0.md §20/§22's own async-job
 * pattern: 202 Accepted + QUEUED, poll GET for status). No Research/
 * Blog/Video-specific endpoint — every future content-generation
 * endpoint is meant to become a thin wrapper around this one primitive,
 * per that same spec section, not built here (no business agents exist
 * yet).
 *
 * GET never exposes BackgroundJob internals (bullmqJobId, attempts,
 * processorVersion, etc.) — only the safe, product-useful ai_jobs fields
 * (Part 22 of this phase's own spec).
 */
function serialize(job: AiJob & { knowledgePack: { publicId: string } }) {
  return {
    publicId: job.publicId,
    agentIdentifier: job.agentName,
    agentVersion: job.agentVersion,
    status: job.status,
    knowledgePackVersionId: job.knowledgePack.publicId,
    providerUsed: job.providerUsed,
    modelUsed: job.modelUsed,
    tokenUsage: job.tokenUsage,
    costEstimate: job.costEstimate,
    outputPayload: job.outputPayload,
    errorCode: job.errorCode,
    errorMessageSafe: job.errorMessageSafe,
    correlationId: job.correlationId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

@Controller("api/v1/workspaces/:workspaceId/ai/jobs")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class AiJobsController {
  constructor(private readonly aiJobs: AiJobSubmissionService) {}

  @Post()
  @RequirePermission(PERMISSIONS.AI_JOB_CREATE)
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateAiJobDto, @Req() req: Request) {
    const correlationId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    const job = await this.aiJobs.submit(workspace.id, workspace.userInternalId, dto, correlationId);
    return { data: serialize(job) };
  }

  @Get(":aiJobId")
  @RequirePermission(PERMISSIONS.AI_JOB_VIEW)
  async findOne(@CurrentWorkspace() workspace: WorkspaceContext, @Param("aiJobId") aiJobId: string) {
    const job = await this.aiJobs.findOne(workspace.id, aiJobId);
    return { data: serialize(job) };
  }
}
