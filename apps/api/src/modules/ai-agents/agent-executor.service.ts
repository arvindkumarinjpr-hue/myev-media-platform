import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  AIProviderError,
  AIProviderErrorCode,
  AgentExecutionErrorCode,
  AgentExecutionResolutionError,
  AgentRegistryValidationError,
  resolveAgentExecution,
  type AgentDefinition,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentRegistry,
  type AIProviderRegistry,
  type AIRequest,
} from "@myev/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { AiJobStatus, Prisma } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { KnowledgePacksService } from "../knowledge-packs/knowledge-packs.service";
import { buildAgentContext } from "./agent-context-builder";
import { AGENT_REGISTRY } from "./agent-registry.module";
import { AI_PROVIDER_REGISTRY } from "./ai-provider-registry.module";

/**
 * Module 3 Phase 3.2 — the generic Agent execution core (Part 7 of Phase
 * 3.2's own spec). Executes SYNCHRONOUSLY end-to-end: this is the
 * "internal execution primitive" Part 10 explicitly sanctions when
 * durable async dispatch isn't yet wired ("If a synchronous internal
 * execution primitive is also required for tests, keep it internal and
 * clearly separated from the durable public workflow"). See
 * AiAgentsModule's own doc comment for why durable async dispatch
 * through Module 1F's Queue Engine is deliberately NOT built in this
 * phase.
 *
 * Every execution persists through ai_jobs/ai_job_steps regardless of
 * dispatch mechanism — sync today, durable-async whenever that follow-on
 * work lands, same business record either way.
 *
 * An ai_jobs row is created only once a real, resolved Knowledge Pack
 * exists to satisfy its own NOT NULL FK (ADR-004's "gates on
 * active-Knowledge-Pack existence at Queued-state entry" reads literally
 * here: a request that fails agent resolution, input validation, or
 * Knowledge Pack resolution/activation never reaches Queued state at
 * all, so no row is ever written for it — mirrors exactly how an
 * unknown-agent or invalid-input request is handled).
 */
@Injectable()
export class AgentExecutorService {
  private readonly logger = new Logger(AgentExecutorService.name);

  constructor(
    @Inject(AGENT_REGISTRY) private readonly agentRegistry: AgentRegistry,
    @Inject(AI_PROVIDER_REGISTRY) private readonly providerRegistry: AIProviderRegistry,
    private readonly knowledgePacks: KnowledgePacksService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async execute(request: AgentExecutionRequest, triggeringModule: string): Promise<AgentExecutionResult> {
    const startedAt = Date.now();

    // 1. Resolve Agent definition — before anything else touches the
    // database (Part 2/3: clean unknown-agent failure, no ai_jobs row for
    // a request naming a nonexistent agent).
    let definition;
    try {
      definition = this.agentRegistry.resolve(request.agentIdentifier, request.agentVersion);
    } catch (err) {
      if (err instanceof AgentRegistryValidationError) {
        return this.rejectedBeforeQueued(request, { code: AgentExecutionErrorCode.UNKNOWN_AGENT, messageSafe: "No agent is registered under the given identifier/version." }, startedAt);
      }
      throw err;
    }

    // 2. Validate input against the resolved definition's own schema.
    const inputInstance = plainToInstance(definition.inputSchema, request.input);
    const violations = await validate(inputInstance, { whitelist: true, forbidNonWhitelisted: false });
    if (violations.length > 0) {
      return this.rejectedBeforeQueued(
        request,
        { code: AgentExecutionErrorCode.INPUT_VALIDATION_FAILED, messageSafe: `Agent input did not match "${definition.identifier}"'s expected schema (${violations.length} violation(s)).` },
        startedAt,
        definition.identifier,
        definition.version,
      );
    }

    // 3. Resolve the EXACT Knowledge Pack version — reuses
    // KnowledgePacksService.findOne, never duplicating its
    // workspace-scoping/enumeration-safe-not-found logic (Part 5). Covers
    // both "no such pack" and "exists in a different workspace"
    // identically (see AgentExecutionErrorCode.KNOWLEDGE_PACK_NOT_FOUND's
    // own doc comment).
    let pack;
    try {
      pack = await this.knowledgePacks.findOne(request.workspaceId, request.knowledgePackVersionId);
    } catch {
      return this.rejectedBeforeQueued(
        request,
        { code: AgentExecutionErrorCode.KNOWLEDGE_PACK_NOT_FOUND, messageSafe: "The referenced Knowledge Pack version does not exist in this workspace." },
        startedAt,
        definition.identifier,
        definition.version,
      );
    }

    // ADR-004: no AI agent may execute without an ACTIVE, validated
    // Knowledge Pack.
    if (pack.status !== "ACTIVE") {
      return this.rejectedBeforeQueued(
        request,
        { code: AgentExecutionErrorCode.KNOWLEDGE_PACK_NOT_ACTIVE, messageSafe: `Knowledge Pack is "${pack.status}", not ACTIVE — an agent cannot execute against it.` },
        startedAt,
        definition.identifier,
        definition.version,
        pack.publicId,
      );
    }

    // 4. Every prerequisite gate passed — this IS the moment of
    // triggering intent (Queued-state entry). Create the ai_jobs row and
    // audit it once here, mirroring JOB_CANCELLATION_REQUESTED's own
    // "audit the request, not every routine downstream transition"
    // precedent.
    const job = await this.prisma.aiJob.create({
      data: {
        workspaceId: request.workspaceId,
        agentName: definition.identifier,
        agentVersion: definition.version,
        triggeringModule,
        knowledgePackId: pack.id,
        inputPayload: request.input as Prisma.InputJsonValue,
        status: "QUEUED",
        correlationId: request.correlationId,
        createdById: request.requestedByUserId ?? null,
      },
    });
    await this.audit.record({
      action: "AI_EXECUTION_REQUESTED",
      actorUserId: request.requestedByUserId ?? null,
      workspaceId: request.workspaceId,
      entityType: "ai_job",
      entityId: job.publicId,
      correlationId: request.correlationId,
    });
    await this.recordStep(job.id, "knowledge_pack_resolution", "COMPLETED");

    // 5. Build the provider-neutral Agent context — the only place a
    // Knowledge Pack Prisma entity is touched (Part 6).
    const context = buildAgentContext(pack);

    // 6. Resolve provider + model + generation settings through the
    // Phase 3.5 resolver (packages/shared) — the ai_jobs row already
    // exists at this point, so an unconfigured provider must terminate
    // it cleanly rather than throw uncaught (see resolveAgentExecution's
    // own doc comment for the bug this closes).
    let resolved;
    try {
      resolved = resolveAgentExecution(definition, this.providerRegistry);
    } catch (err) {
      if (err instanceof AgentExecutionResolutionError) {
        await this.recordStep(job.id, "provider_execution", "FAILED");
        await this.prisma.aiJob.update({
          where: { id: job.id },
          data: { status: "FAILED", errorCode: err.failure.code, errorMessageSafe: err.failure.messageSafe, completedAt: new Date() },
        });
        return {
          status: "FAILED",
          latencyMs: Date.now() - startedAt,
          failure: err.failure,
          knowledgePackVersionUsed: pack.publicId,
          agentIdentifierUsed: definition.identifier,
          agentVersionUsed: definition.version,
          correlationId: request.correlationId,
        };
      }
      throw err;
    }
    const provider = resolved.provider;

    // 7. Transition RUNNING, construct the normalized AIRequest, and
    // execute — bounded by definition.timeoutMs via AbortController, the
    // one cancellation mechanism Phase 3.1's AIProvider interface defines.
    await this.prisma.aiJob.update({ where: { id: job.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await this.recordStep(job.id, "provider_execution", "RUNNING");

    const { prompt, systemInstructions } = definition.buildPrompt(inputInstance, context);
    const aiRequest: AIRequest = {
      workspaceId: request.workspaceId,
      agentName: definition.identifier,
      prompt,
      systemInstructions,
      knowledgePackReference: context.knowledgePackVersionId,
      ...(definition.outputSchema ? { outputFormat: "json" as const, structuredOutputSchema: definition.outputSchema } : {}),
      // Explicit values here win over the resolved provider's own
      // configured ModelConfig.defaults (Phase 3.1's own
      // resolveGenerationSettings, applied inside each adapter) — an
      // unset field stays unset, so a provider's own default still
      // applies when this agent declares no preference.
      temperature: resolved.generationSettings.temperature,
      maxTokens: resolved.generationSettings.maxTokens,
      timeoutMs: resolved.generationSettings.timeoutMs ?? definition.timeoutMs,
      correlationId: request.correlationId,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), definition.timeoutMs);
    try {
      const response = await provider.execute(aiRequest, controller.signal);
      clearTimeout(timeout);

      const finalOutput = this.applyPostProcessing(definition as AgentDefinition, job.publicId, response.output, inputInstance);

      await this.recordStep(job.id, "provider_execution", "COMPLETED");
      await this.prisma.aiJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          outputPayload: (typeof finalOutput === "string" ? { text: finalOutput } : finalOutput) as Prisma.InputJsonValue,
          providerUsed: response.provider,
          modelUsed: response.model,
          tokenUsage: response.usage as unknown as Prisma.InputJsonValue,
          generationSettings: resolved.generationSettings as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      return {
        status: "COMPLETED",
        output: finalOutput,
        providerUsed: response.provider,
        modelUsed: response.model,
        tokenUsage: response.usage,
        costEstimate: response.costEstimate,
        latencyMs: Date.now() - startedAt,
        knowledgePackVersionUsed: pack.publicId,
        agentIdentifierUsed: definition.identifier,
        agentVersionUsed: definition.version,
        correlationId: request.correlationId,
      };
    } catch (err) {
      clearTimeout(timeout);
      const providerError =
        err instanceof AIProviderError
          ? err
          : new AIProviderError(
              controller.signal.aborted ? AIProviderErrorCode.TIMEOUT : AIProviderErrorCode.UNKNOWN,
              "Agent execution failed.",
              definition.providerPreference.provider,
            );
      const terminalStatus: AiJobStatus = providerError.code === AIProviderErrorCode.TIMEOUT ? "TIMED_OUT" : "FAILED";

      await this.recordStep(job.id, "provider_execution", terminalStatus);
      await this.prisma.aiJob.update({
        where: { id: job.id },
        data: { status: terminalStatus, errorCode: providerError.code, errorMessageSafe: providerError.messageSafe, generationSettings: resolved.generationSettings as Prisma.InputJsonValue, completedAt: new Date() },
      });

      return {
        status: terminalStatus,
        latencyMs: Date.now() - startedAt,
        failure: { code: AgentExecutionErrorCode.PROVIDER_ERROR, messageSafe: providerError.messageSafe, providerErrorCode: providerError.code, retryable: providerError.retryable },
        knowledgePackVersionUsed: pack.publicId,
        agentIdentifierUsed: definition.identifier,
        agentVersionUsed: definition.version,
        correlationId: request.correlationId,
      };
    }
  }

  /**
   * A failure that occurs before the request ever reaches Queued state
   * (unknown agent, invalid input, unresolvable/inactive Knowledge Pack)
   * — no ai_jobs row, no audit entry: there was no legitimate queued
   * execution to record, matching ADR-004's own "gates ... at
   * Queued-state entry" wording literally.
   */
  private rejectedBeforeQueued(
    request: AgentExecutionRequest,
    failure: { code: AgentExecutionErrorCode; messageSafe: string },
    startedAt: number,
    agentIdentifier: string = request.agentIdentifier,
    agentVersion: number = request.agentVersion ?? 0,
    knowledgePackVersionUsed: string = request.knowledgePackVersionId,
  ): AgentExecutionResult {
    return {
      status: "FAILED",
      latencyMs: Date.now() - startedAt,
      failure,
      knowledgePackVersionUsed,
      agentIdentifierUsed: agentIdentifier,
      agentVersionUsed: agentVersion,
      correlationId: request.correlationId,
    };
  }

  /**
   * Module 4 Phase 4.2 — invokes AgentDefinition.postProcessOutput when
   * defined, on a successful response's output only. A hook that throws
   * never fails the job (FR-RES-004's own "deduplication failure does
   * not block the job" generalized to any future post-processing hook):
   * the AI generation itself already succeeded, so the unprocessed
   * output is persisted instead.
   */
  private applyPostProcessing(definition: AgentDefinition, aiJobPublicId: string, output: string | Record<string, unknown>, input: object): string | Record<string, unknown> {
    if (!definition.postProcessOutput || typeof output !== "object") {
      return output;
    }
    try {
      return definition.postProcessOutput(output, input) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(`postProcessOutput failed for aiJob ${aiJobPublicId} (${definition.identifier}), persisting unprocessed output: ${err instanceof Error ? err.message : "unknown error"}`);
      return output;
    }
  }

  private async recordStep(aiJobId: string, stepName: string, stepStatus: AiJobStatus): Promise<void> {
    const terminal: AiJobStatus[] = ["COMPLETED", "FAILED", "TIMED_OUT"];
    if (!terminal.includes(stepStatus)) {
      await this.prisma.aiJobStep.create({ data: { aiJobId, stepName, stepStatus, startedAt: new Date() } });
      return;
    }
    const existing = await this.prisma.aiJobStep.findFirst({ where: { aiJobId, stepName }, orderBy: { startedAt: "desc" } });
    if (existing) {
      await this.prisma.aiJobStep.update({ where: { id: existing.id }, data: { stepStatus, completedAt: new Date() } });
    } else {
      await this.prisma.aiJobStep.create({ data: { aiJobId, stepName, stepStatus, startedAt: new Date(), completedAt: new Date() } });
    }
  }
}
