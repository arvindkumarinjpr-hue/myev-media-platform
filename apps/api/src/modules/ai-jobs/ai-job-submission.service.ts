import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AgentRegistryValidationError, type AgentRegistry } from "@myev/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { AiJob, Prisma } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { BackgroundJobsService } from "../background-jobs/background-jobs.service";
import { KnowledgePacksService } from "../knowledge-packs/knowledge-packs.service";
import { AGENT_REGISTRY } from "../ai-agents/agent-registry.module";
import type { CreateAiJobDto } from "./dto/create-ai-job.dto";

/**
 * Module 3 Phase 3.3 — the durable AI Job submission flow. Mirrors
 * AgentExecutorService's own "resolve agent -> validate input -> resolve
 * and gate the exact Knowledge Pack version" steps (Phase 3.2), since a
 * job must be fully valid before it's allowed to become a durable,
 * queued unit of work — the same small amount of validation logic,
 * intentionally not shared via a common abstraction with
 * AgentExecutorService: this flow's own downstream (create + durably
 * enqueue) is different enough from AgentExecutorService's own downstream
 * (create + execute inline) that forcing a shared abstraction now would
 * cost more than it saves. Provider execution never happens here — this
 * service only creates the ai_jobs row and durably enqueues the generic
 * "ai.execute.v1" job type via the EXISTING BackgroundJobsService.enqueue
 * (Module 1F's own Queue Engine, unmodified — no second queue system).
 */
@Injectable()
export class AiJobSubmissionService {
  constructor(
    @Inject(AGENT_REGISTRY) private readonly agentRegistry: AgentRegistry,
    private readonly knowledgePacks: KnowledgePacksService,
    private readonly backgroundJobs: BackgroundJobsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async submit(
    workspaceId: string,
    actorUserId: string,
    dto: CreateAiJobDto,
    correlationId: string,
  ): Promise<AiJob & { knowledgePack: { publicId: string } }> {
    let definition;
    try {
      definition = this.agentRegistry.resolve(dto.agentIdentifier, dto.agentVersion);
    } catch (err) {
      if (err instanceof AgentRegistryValidationError) {
        throw new NotFoundException({ code: "AI_AGENT_NOT_FOUND", message: "No agent is registered under the given identifier/version." });
      }
      throw err;
    }

    const inputInstance = plainToInstance(definition.inputSchema, dto.input);
    const violations = await validate(inputInstance, { whitelist: true, forbidNonWhitelisted: false });
    if (violations.length > 0) {
      throw new UnprocessableEntityException({
        code: "AI_JOB_INPUT_INVALID",
        message: `Agent input did not match "${definition.identifier}"'s expected schema.`,
        details: violations.map((v) => v.toString()),
      });
    }

    // Enumeration-safe: findOne() throws NotFoundException identically
    // for "no such pack" and "exists in a different workspace" — see
    // AgentExecutorService's own identical reasoning (Phase 3.2).
    const pack = await this.knowledgePacks.findOne(workspaceId, dto.knowledgePackVersionId);
    if (pack.status !== "ACTIVE") {
      throw new UnprocessableEntityException({
        code: "AI_JOB_KNOWLEDGE_PACK_NOT_ACTIVE",
        message: `Knowledge Pack is "${pack.status}", not ACTIVE — an agent cannot execute against it.`,
      });
    }

    // Every prerequisite gate passed — this IS the moment of triggering
    // intent (Queued-state entry), mirroring ADR-004's own wording and
    // AgentExecutorService's identical rejectedBeforeQueued/create-row
    // boundary.
    const job = await this.prisma.aiJob.create({
      data: {
        workspaceId,
        agentName: definition.identifier,
        agentVersion: definition.version,
        triggeringModule: "ai-jobs-api",
        knowledgePackId: pack.id,
        inputPayload: dto.input as Prisma.InputJsonValue,
        status: "QUEUED",
        correlationId,
        createdById: actorUserId,
      },
    });

    const backgroundJob = await this.backgroundJobs.enqueue({
      workspaceId,
      jobType: "ai.execute.v1",
      payload: { aiJobPublicId: job.publicId },
      correlationId,
      createdByUserId: actorUserId,
    });

    const linked = await this.prisma.aiJob.update({
      where: { id: job.id },
      data: { backgroundJobId: backgroundJob.id },
      include: { knowledgePack: { select: { publicId: true } } },
    });

    await this.audit.record({
      action: "AI_EXECUTION_REQUESTED",
      actorUserId,
      workspaceId,
      entityType: "ai_job",
      entityId: job.publicId,
      correlationId,
    });

    return linked;
  }

  async findOne(workspaceId: string, aiJobPublicId: string): Promise<AiJob & { knowledgePack: { publicId: string } }> {
    const job = await this.prisma.aiJob.findFirst({
      where: { workspaceId, publicId: aiJobPublicId, deletedAt: null },
      include: { knowledgePack: { select: { publicId: true } } },
    });
    if (!job) {
      throw new NotFoundException({ code: "AI_JOB_NOT_FOUND", message: "AI Job not found." });
    }
    return job;
  }

  /**
   * Module 4 Phase 4.1 — a small, generic extension (Module 3's own
   * single-item GET was the only read primitive before this): lists this
   * workspace's own ai_jobs rows, optionally scoped to one agent
   * identifier. Reusable by any future business module wanting its own
   * "list my AI jobs" view (Research is the first caller, via
   * ResearchService.list()) — not Research-specific logic itself.
   */
  async findMany(workspaceId: string, filters: { agentIdentifier?: string } = {}): Promise<(AiJob & { knowledgePack: { publicId: string } })[]> {
    return this.prisma.aiJob.findMany({
      where: { workspaceId, deletedAt: null, ...(filters.agentIdentifier ? { agentName: filters.agentIdentifier } : {}) },
      include: { knowledgePack: { select: { publicId: true } } },
      orderBy: { createdAt: "desc" },
    });
  }
}
