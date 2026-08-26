import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { CreateResearchDto } from "./dto/create-research.dto";
import { ResearchService, type ResearchJob } from "./research.service";

/**
 * Module 4 Phase 4.1 — the user-facing Research API
 * (POST/GET /api/v1/workspaces/:workspaceId/research). A thin,
 * research-shaped wrapper over Module 3's generic durable AiJob
 * primitive (never a second AI execution system, never a bypass of
 * Knowledge Pack gating/provider abstraction/Worker execution/retry/
 * provenance) — mirrors AiJobsController's own serialize()/guard/
 * decorator shape exactly, with Research's own permissions
 * (RESEARCH_RUN/RESEARCH_VIEW) instead of the generic AI_JOB_CREATE/
 * AI_JOB_VIEW, and the caller-facing `topic` surfaced directly instead
 * of a generic `input` blob.
 */
function serialize(job: ResearchJob) {
  const input = job.inputPayload as { topic?: string } | null;
  return {
    publicId: job.publicId,
    topic: input?.topic ?? null,
    status: job.status,
    knowledgePackVersionId: job.knowledgePack.publicId,
    agentVersion: job.agentVersion,
    providerUsed: job.providerUsed,
    modelUsed: job.modelUsed,
    tokenUsage: job.tokenUsage,
    generationSettings: job.generationSettings,
    // The full structured ResearchAgentOutput once COMPLETED — never
    // exposed unvalidated (Phase 3.1's own parseStructuredOutput
    // guarantee applies before this ever reaches outputPayload).
    result: job.outputPayload,
    errorCode: job.errorCode,
    errorMessageSafe: job.errorMessageSafe,
    correlationId: job.correlationId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

@Controller("api/v1/workspaces/:workspaceId/research")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Post()
  @RequirePermission(PERMISSIONS.RESEARCH_RUN)
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateResearchDto, @Req() req: Request) {
    const correlationId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    const job = await this.research.submit(workspace.id, workspace.userInternalId, dto, correlationId);
    return { data: serialize(job) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.RESEARCH_VIEW)
  async list(@CurrentWorkspace() workspace: WorkspaceContext) {
    const jobs = await this.research.list(workspace.id);
    return { data: jobs.map(serialize) };
  }

  @Get(":researchId")
  @RequirePermission(PERMISSIONS.RESEARCH_VIEW)
  async findOne(@CurrentWorkspace() workspace: WorkspaceContext, @Param("researchId") researchId: string) {
    const job = await this.research.findOne(workspace.id, researchId);
    return { data: serialize(job) };
  }
}
