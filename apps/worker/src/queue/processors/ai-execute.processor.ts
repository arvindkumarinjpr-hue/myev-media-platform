import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  AIProviderError,
  AIProviderErrorCode,
  AI_EXECUTE_V1_MANIFEST,
  PermanentProcessorError,
  type AgentContext,
  type AgentRegistry,
  type AIProviderRegistry,
  type AIRequest,
  type AiExecuteV1Payload,
  type AiExecuteV1Result,
  type ProcessorContext,
  type ProcessorHandler,
} from "@myev/shared";
import { plainToInstance } from "class-transformer";
import type { AiJobStatus, Prisma } from "../../../../api/generated/prisma";
import { AGENT_REGISTRY } from "../../ai-provider/agent-registry.module";
import { AI_PROVIDER_REGISTRY } from "../../ai-provider/ai-provider-registry.module";
import { PrismaService } from "../../prisma/prisma.service";

const KNOWLEDGE_PACK_INCLUDE = {
  knowledgeSources: true,
  promptTemplates: true,
  seoRules: true,
  brandGuidelines: true,
  keywordSets: true,
  competitors: true,
} satisfies Prisma.KnowledgePackInclude;

const TERMINAL_STATUSES: AiJobStatus[] = ["COMPLETED", "FAILED", "TIMED_OUT"];

/**
 * Module 3 Phase 3.3 — the generic durable AI execution processor. This
 * IS the worker-process counterpart to AgentExecutorService's own
 * pipeline (resolve agent -> resolve/gate Knowledge Pack -> build
 * context -> resolve provider -> execute -> normalize -> persist) —
 * apps/worker cannot import apps/api's compiled AgentExecutorService
 * (separate NestJS processes; Module 1F's own firm apps/api-never-
 * executes / apps/worker-only-executes boundary), so this re-implements
 * the same logical steps using the identical packages/shared building
 * blocks (AgentRegistry, AIProviderRegistry, AIRequest/AIResponse) rather
 * than a shortcut that skips validation/context-building/normalization.
 * See ai-provider-registry.module.ts's own doc comment for the full
 * rationale.
 *
 * Never creates an ai_jobs row — only ever advances an EXISTING one
 * (created by AiJobSubmissionService before this job was even enqueued).
 * A retried BackgroundJob therefore always operates on the same AiJob
 * identity by construction, never a new one.
 */
@Injectable()
export class AiExecuteProcessor {
  constructor(
    @Inject(AGENT_REGISTRY) private readonly agentRegistry: AgentRegistry,
    @Inject(AI_PROVIDER_REGISTRY) private readonly providerRegistry: AIProviderRegistry,
    private readonly prisma: PrismaService,
    @InjectPinoLogger(AiExecuteProcessor.name) private readonly logger: PinoLogger,
  ) {}

  readonly handle: ProcessorHandler<AiExecuteV1Payload, AiExecuteV1Result> = async (
    payload: AiExecuteV1Payload,
    context: ProcessorContext,
  ): Promise<AiExecuteV1Result> => {
    const job = await this.prisma.aiJob.findFirst({ where: { publicId: payload.aiJobPublicId } });
    if (!job) {
      // Data-integrity condition, not a transient one — no retry will
      // ever make a nonexistent ai_jobs row appear.
      throw new PermanentProcessorError("AI_JOB_NOT_FOUND", "Referenced AI Job does not exist.");
    }

    // Idempotent no-op for a duplicate/redelivered execution attempt
    // (at-least-once redelivery, crash-recovery re-drive, or a second
    // concurrent worker) — the job already reached a terminal state, so
    // there is nothing left to do. Covers "one durable submission = one
    // AiJob, retries operate on the same identity" without ever risking
    // a double-execution.
    if (TERMINAL_STATUSES.includes(job.status)) {
      return { aiJobPublicId: job.publicId };
    }

    const definition = this.agentRegistry.has(job.agentName, job.agentVersion) ? this.agentRegistry.resolve(job.agentName, job.agentVersion) : undefined;
    if (!definition) {
      await this.terminal(job.id, "FAILED", "AI_AGENT_NOT_FOUND", "No agent is registered under the given identifier/version.");
      throw new PermanentProcessorError("AI_AGENT_NOT_FOUND", "No agent is registered under the given identifier/version.");
    }

    // Atomic, fenced pickup: only proceed if this row is still QUEUED.
    // Guards against two overlapping executions of the identical AiJob
    // (a concurrent redelivery racing a still-in-flight attempt) — the
    // loser observes count === 0 and treats it as an already-handled
    // no-op rather than executing a second time.
    const claimed = await this.prisma.aiJob.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: job.startedAt ?? new Date(), backgroundJobId: context.jobId },
    });
    if (claimed.count === 0) {
      this.logger.info({ aiJobId: job.publicId, backgroundJobId: context.jobId }, "ai.execute.v1: AiJob already claimed by a concurrent attempt — skipping");
      return { aiJobPublicId: job.publicId };
    }

    await this.recordStep(job.id, "knowledge_pack_resolution", "RUNNING");

    const pack = await this.prisma.knowledgePack.findFirst({
      where: { id: job.knowledgePackId, workspaceId: job.workspaceId, deletedAt: null },
      include: KNOWLEDGE_PACK_INCLUDE,
    });
    if (!pack) {
      await this.recordStep(job.id, "knowledge_pack_resolution", "FAILED");
      await this.terminal(job.id, "FAILED", "AI_JOB_KNOWLEDGE_PACK_NOT_FOUND", "The referenced Knowledge Pack version no longer exists.");
      throw new PermanentProcessorError("AI_JOB_KNOWLEDGE_PACK_NOT_FOUND", "The referenced Knowledge Pack version no longer exists.");
    }
    if (pack.status !== "ACTIVE") {
      await this.recordStep(job.id, "knowledge_pack_resolution", "FAILED");
      await this.terminal(job.id, "FAILED", "AI_JOB_KNOWLEDGE_PACK_NOT_ACTIVE", `Knowledge Pack is "${pack.status}", not ACTIVE — an agent cannot execute against it.`);
      throw new PermanentProcessorError("AI_JOB_KNOWLEDGE_PACK_NOT_ACTIVE", `Knowledge Pack is "${pack.status}", not ACTIVE.`);
    }
    await this.recordStep(job.id, "knowledge_pack_resolution", "COMPLETED");

    const aiContext: AgentContext = {
      workspaceId: pack.workspaceId,
      knowledgePackVersionId: pack.publicId,
      industryProfile: pack.industryProfile as Record<string, unknown>,
      publishingStrategy: pack.publishingStrategy as Record<string, unknown>,
      trustedSources: pack.knowledgeSources.map((s) => ({ sourceType: s.sourceType, url: s.url })),
      promptTemplates: pack.promptTemplates.map((t) => ({ contentType: t.contentType, promptBody: t.promptBody, versionNumber: t.versionNumber })),
      seoRules: pack.seoRules.map((r) => ({
        primaryKeywords: r.primaryKeywords,
        secondaryKeywords: r.secondaryKeywords,
        internalLinkingPolicy: r.internalLinkingPolicy,
        schemaPreferences: r.schemaPreferences,
      })),
      brandGuidelines: pack.brandGuidelines.map((b) => ({ toneOfVoice: b.toneOfVoice, terminology: b.terminology, ctaRules: b.ctaRules })),
      keywords: pack.keywordSets.map((k) => ({ name: k.name, keywords: k.keywords })),
      competitors: pack.competitors.map((c) => ({ domain: c.domain, notes: c.notes })),
    };

    const provider = this.providerRegistry.resolve(definition.providerPreference.provider);
    // Input was already class-validator-validated once, at submission
    // time (AiJobSubmissionService), before this row was ever created —
    // transform only here, not re-validate a value this process itself
    // never received from an external caller.
    const inputInstance = plainToInstance(definition.inputSchema, job.inputPayload as Record<string, unknown>);

    await this.recordStep(job.id, "provider_execution", "RUNNING");

    const { prompt, systemInstructions } = definition.buildPrompt(inputInstance, aiContext);
    const aiRequest: AIRequest = {
      workspaceId: job.workspaceId,
      agentName: definition.identifier,
      prompt,
      systemInstructions,
      knowledgePackReference: aiContext.knowledgePackVersionId,
      ...(definition.outputSchema ? { outputFormat: "json" as const, structuredOutputSchema: definition.outputSchema } : {}),
      timeoutMs: definition.timeoutMs,
      correlationId: context.correlationId,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), definition.timeoutMs);
    try {
      const response = await provider.execute(aiRequest, controller.signal);
      clearTimeout(timeout);

      await this.recordStep(job.id, "provider_execution", "COMPLETED");
      await this.prisma.aiJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          outputPayload: (typeof response.output === "string" ? { text: response.output } : response.output) as Prisma.InputJsonValue,
          providerUsed: response.provider,
          modelUsed: response.model,
          tokenUsage: response.usage as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      this.logger.info({ aiJobId: job.publicId, backgroundJobId: context.jobId, attempt: context.attempt }, "ai.execute.v1: AiJob completed");
      return { aiJobPublicId: job.publicId };
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

      const maxAttempts = AI_EXECUTE_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1;
      const isLastAttempt = context.attempt >= maxAttempts;

      if (providerError.retryable && !isLastAttempt) {
        // Retry boundary (Part 7/8 of this phase's own spec): classify
        // only, never retry here — Module 1F's own retry engine
        // (BullMqWorkerManager) owns scheduling the next attempt. Revert
        // to QUEUED (not a terminal status) so a caller polling GET
        // never sees a false permanent failure while a retry is still
        // pending — the ONLY approved AiJob states are used; no new
        // "RETRYING" status is invented.
        await this.recordStep(job.id, "provider_execution", "FAILED");
        await this.prisma.aiJob.update({
          where: { id: job.id },
          data: { status: "QUEUED", errorCode: providerError.code, errorMessageSafe: providerError.messageSafe },
        });
        this.logger.warn(
          { aiJobId: job.publicId, backgroundJobId: context.jobId, attempt: context.attempt, code: providerError.code },
          "ai.execute.v1: transient provider failure — reverted to QUEUED for retry",
        );
        // Plain Error, deliberately not PermanentProcessorError — lets
        // BullMqWorkerManager's own transient-failure branch schedule the
        // retry per AI_EXECUTE_V1_MANIFEST.defaultRetryPolicy.
        throw new Error(providerError.messageSafe);
      }

      const terminalStatus: AiJobStatus = providerError.code === AIProviderErrorCode.TIMEOUT ? "TIMED_OUT" : "FAILED";
      await this.recordStep(job.id, "provider_execution", terminalStatus);
      await this.terminal(job.id, terminalStatus, providerError.code, providerError.messageSafe);
      throw new PermanentProcessorError(providerError.code, providerError.messageSafe);
    }
  };

  private async terminal(aiJobId: string, status: AiJobStatus, errorCode: string, errorMessageSafe: string): Promise<void> {
    await this.prisma.aiJob.update({
      where: { id: aiJobId },
      data: { status, errorCode, errorMessageSafe, completedAt: new Date() },
    });
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
