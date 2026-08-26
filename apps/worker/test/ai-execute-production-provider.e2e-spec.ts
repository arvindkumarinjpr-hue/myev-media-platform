import "reflect-metadata";
import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { IsString } from "class-validator";
import { AI_EXECUTE_V1_MANIFEST, AgentRegistryBuilder, AIProviderRegistryBuilder, AnthropicProvider, GeminiProvider, OpenAIProvider, type AgentDefinition } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { AiExecuteProcessor } from "../src/queue/processors/ai-execute.processor";
import { AGENT_REGISTRY } from "../src/ai-provider/agent-registry.module";
import { AI_PROVIDER_REGISTRY } from "../src/ai-provider/ai-provider-registry.module";
import type { AiJob, BackgroundJob } from "../../api/generated/prisma";

class ProdProviderTestInput {
  @IsString()
  message!: string;
}

/**
 * Module 3 Phase 3.4 — proves that the durable AI execution pipeline
 * (AiExecuteProcessor's own claim → context-build → resolve → execute →
 * persist chain, entirely unchanged from Phase 3.3) works correctly
 * against a PRODUCTION-STYLE AIProviderRegistry: the real adapter
 * classes wrapping jest-mocked vendor SDK clients — never FakeProvider,
 * never a live network call. This is the regression proof that Phase
 * 3.4's registry-wiring change (real providers registered alongside/
 * instead of FakeProvider) doesn't require and didn't introduce any
 * change to the durable job lifecycle itself: the processor has no idea
 * whether the provider it resolved is real or fake, by design.
 *
 * Module 3 Phase 3.6 — extended to register all three ADR-003 providers
 * (OpenAI, Anthropic, Gemini) simultaneously in one production-style
 * registry (a realistic shape — a real deployment configures more than
 * one), each proven through this identical generic pipeline, closing
 * the "OpenAI path, Anthropic path, Gemini path" proof this phase's own
 * spec calls out by name. Since AiExecuteProcessor and
 * resolveAgentExecution contain zero provider-specific branching, the
 * OpenAI case above already proves the pipeline itself is
 * provider-agnostic; these two additional cases prove each adapter's
 * own real-response mapping is wired correctly end-to-end too, not just
 * unit-tested in isolation (packages/shared's own
 * anthropic/gemini-provider.spec.ts).
 *
 * A dedicated inline AgentDefinition per provider (never exported from
 * packages/shared, only registered inside this one test's own
 * AGENT_REGISTRY override) is used instead of TEST_ECHO_AGENT_V1 so its
 * providerPreference can point at a real provider id without touching
 * the shared fixture every other Phase 3.2/3.3 test also depends on.
 */
describe("Worker (e2e) — ai.execute.v1 against a production-style provider registry", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM,AI";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";

  const PROD_STYLE_AGENT: AgentDefinition<ProdProviderTestInput, object> = {
    identifier: "test-openai-production-style-agent",
    version: 1,
    purpose: "Test-only agent proving the durable pipeline resolves a real provider adapter class through a production-style registry.",
    type: "test",
    providerPreference: { provider: "openai", model: "gpt-4o" },
    inputSchema: ProdProviderTestInput,
    buildPrompt: (input) => ({ prompt: input.message }),
    timeoutMs: 5_000,
    executionPolicy: { maxAttempts: 1 },
  };

  const ANTHROPIC_PROD_STYLE_AGENT: AgentDefinition<ProdProviderTestInput, object> = {
    ...PROD_STYLE_AGENT,
    identifier: "test-anthropic-production-style-agent",
    providerPreference: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
  };

  const GEMINI_PROD_STYLE_AGENT: AgentDefinition<ProdProviderTestInput, object> = {
    ...PROD_STYLE_AGENT,
    identifier: "test-gemini-production-style-agent",
    providerPreference: { provider: "gemini", model: "gemini-1.5-pro" },
  };

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let processor: AiExecuteProcessor;
  let mockCreate: jest.Mock;
  let mockAnthropicCreate: jest.Mock;
  let mockGeminiGenerateContent: jest.Mock;

  beforeAll(async () => {
    const agentRegistryBuilder = new AgentRegistryBuilder();
    agentRegistryBuilder.register(PROD_STYLE_AGENT);
    agentRegistryBuilder.register(ANTHROPIC_PROD_STYLE_AGENT);
    agentRegistryBuilder.register(GEMINI_PROD_STYLE_AGENT);
    const agentRegistry = agentRegistryBuilder.freeze();

    mockCreate = jest.fn().mockResolvedValue({
      id: "chatcmpl_prod_style_test",
      model: "gpt-4o-2024-08-06",
      choices: [{ message: { content: "production-style provider response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });
    const mockOpenAiClient = { chat: { completions: { create: mockCreate } } } as unknown as OpenAI;

    mockAnthropicCreate = jest.fn().mockResolvedValue({
      id: "msg_prod_style_test",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "production-style anthropic response" }],
      usage: { input_tokens: 5, output_tokens: 4 },
      stop_reason: "end_turn",
    });
    const mockAnthropicClient = { messages: { create: mockAnthropicCreate } } as unknown as Anthropic;

    mockGeminiGenerateContent = jest.fn().mockResolvedValue({
      text: "production-style gemini response",
      responseId: "gemini_prod_style_test",
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 5, totalTokenCount: 11 },
      candidates: [{ finishReason: "STOP" }],
    });
    const mockGeminiClient = { models: { generateContent: mockGeminiGenerateContent } } as unknown as GoogleGenAI;

    const providerRegistryBuilder = new AIProviderRegistryBuilder();
    providerRegistryBuilder.register(new OpenAIProvider(mockOpenAiClient, { provider: "openai", model: "gpt-4o", defaults: {} }));
    providerRegistryBuilder.register(new AnthropicProvider(mockAnthropicClient, { provider: "anthropic", model: "claude-3-5-sonnet-20241022", defaults: {} }));
    providerRegistryBuilder.register(new GeminiProvider(mockGeminiClient, { provider: "gemini", model: "gemini-1.5-pro", defaults: {} }));
    const providerRegistry = providerRegistryBuilder.freeze();

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_REGISTRY)
      .useValue(agentRegistry)
      .overrideProvider(AI_PROVIDER_REGISTRY)
      .useValue(providerRegistry)
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    processor = moduleRef.get(AiExecuteProcessor);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function createTestWorkspace(): Promise<{ userId: string; workspaceId: string }> {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { email: `ai-execute-prod-provider-test-${suffix}@example.invalid`, fullName: "AI Execute Prod Provider Test User", status: "ACTIVE" },
    });
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: { name: `AI Execute Prod Provider Test Workspace ${suffix}`, slug: `ai-execute-prod-provider-test-${suffix}`, ownerId: user.id, createdById: user.id },
      });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { userId: user.id, workspaceId: workspace.id };
  }

  async function createActiveKnowledgePack(workspaceId: string, userId: string): Promise<string> {
    const id = randomUUID();
    const pack = await prisma.knowledgePack.create({
      data: { id, workspaceId, name: "AI Execute Prod Provider Test Pack", industryProfile: {}, publishingStrategy: {}, lineageRootId: id, status: "ACTIVE", createdById: userId },
    });
    return pack.id;
  }

  async function createAiJob(workspaceId: string, userId: string, knowledgePackId: string, agent: AgentDefinition<ProdProviderTestInput, object> = PROD_STYLE_AGENT): Promise<AiJob> {
    return prisma.aiJob.create({
      data: {
        workspaceId,
        agentName: agent.identifier,
        agentVersion: agent.version,
        triggeringModule: "worker-e2e-test",
        knowledgePackId,
        inputPayload: { message: "hello from the production-provider e2e test" },
        status: "QUEUED",
        correlationId: randomUUID(),
        createdById: userId,
      },
    });
  }

  async function createBackgroundJobRow(): Promise<BackgroundJob> {
    const backgroundJob = await prisma.backgroundJob.create({
      data: {
        jobType: AI_EXECUTE_V1_MANIFEST.jobType,
        queueName: AI_EXECUTE_V1_MANIFEST.queue,
        payloadMetadata: {},
        maxAttempts: AI_EXECUTE_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1,
        correlationId: randomUUID(),
      },
    });
    await prisma.backgroundJobHistory.create({ data: { backgroundJobId: backgroundJob.id, toStatus: "QUEUED" } });
    return backgroundJob;
  }

  it("resolves the real OpenAIProvider adapter through a production-style registry and completes the AiJob — no FakeProvider anywhere in the chain", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId);
    const backgroundJob = await createBackgroundJobRow();

    const result = await processor.handle({ aiJobPublicId: job.publicId }, { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false });
    expect(result.aiJobPublicId).toBe(job.publicId);

    // The mocked SDK client was actually invoked — proves the real
    // OpenAIProvider adapter, not a shortcut, executed the request.
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.providerUsed).toBe("openai");
    expect(finished.outputPayload).toEqual({ text: "production-style provider response" });
  }, 30_000);

  it("resolves the real AnthropicProvider adapter through a production-style registry and completes the AiJob — no FakeProvider anywhere in the chain", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId, ANTHROPIC_PROD_STYLE_AGENT);
    const backgroundJob = await createBackgroundJobRow();

    const result = await processor.handle({ aiJobPublicId: job.publicId }, { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false });
    expect(result.aiJobPublicId).toBe(job.publicId);

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.providerUsed).toBe("anthropic");
    expect(finished.outputPayload).toEqual({ text: "production-style anthropic response" });
  }, 30_000);

  it("resolves the real GeminiProvider adapter through a production-style registry and completes the AiJob — no FakeProvider anywhere in the chain", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId, GEMINI_PROD_STYLE_AGENT);
    const backgroundJob = await createBackgroundJobRow();

    const result = await processor.handle({ aiJobPublicId: job.publicId }, { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false });
    expect(result.aiJobPublicId).toBe(job.publicId);

    expect(mockGeminiGenerateContent).toHaveBeenCalledTimes(1);

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.providerUsed).toBe("gemini");
    expect(finished.outputPayload).toEqual({ text: "production-style gemini response" });
  }, 30_000);

  it("Module 3 Phase 3.5: an agent whose required provider is not registered in a production-style registry terminates cleanly FAILED — never stuck RUNNING, and a redelivery does not report a false success", async () => {
    const UNCONFIGURED_AGENT: AgentDefinition<ProdProviderTestInput, object> = {
      identifier: "test-unconfigured-provider-agent",
      version: 1,
      purpose: "Test-only agent proving an unconfigured provider terminates the durable pipeline cleanly instead of leaving the AiJob stuck RUNNING.",
      type: "test",
      // "anthropic" is deliberately never registered in this test's own
      // provider registry below — simulating a real production
      // environment where ANTHROPIC_API_KEY is not set.
      providerPreference: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      inputSchema: ProdProviderTestInput,
      buildPrompt: (input) => ({ prompt: input.message }),
      timeoutMs: 5_000,
      executionPolicy: { maxAttempts: 1 },
    };

    const agentRegistryBuilder = new AgentRegistryBuilder();
    agentRegistryBuilder.register(UNCONFIGURED_AGENT);
    const unconfiguredAgentRegistry = agentRegistryBuilder.freeze();
    // Deliberately empty — this is the "no credentials configured" case.
    const emptyProviderRegistry = new AIProviderRegistryBuilder().freeze();

    const unconfiguredModuleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_REGISTRY)
      .useValue(unconfiguredAgentRegistry)
      .overrideProvider(AI_PROVIDER_REGISTRY)
      .useValue(emptyProviderRegistry)
      .compile();
    await unconfiguredModuleRef.init();
    const unconfiguredProcessor = unconfiguredModuleRef.get(AiExecuteProcessor);

    try {
      const { userId, workspaceId } = await createTestWorkspace();
      const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
      const job = await prisma.aiJob.create({
        data: {
          workspaceId,
          agentName: UNCONFIGURED_AGENT.identifier,
          agentVersion: UNCONFIGURED_AGENT.version,
          triggeringModule: "worker-e2e-test",
          knowledgePackId,
          inputPayload: { message: "should never reach a provider call" },
          status: "QUEUED",
          correlationId: randomUUID(),
          createdById: userId,
        },
      });
      const backgroundJob = await createBackgroundJobRow();
      const ctx = { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false };

      await expect(unconfiguredProcessor.handle({ aiJobPublicId: job.publicId }, ctx)).rejects.toThrow();

      const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(finished.status).toBe("FAILED");
      expect(finished.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
      // Never claimed into RUNNING at all — resolution happens before
      // the atomic claim, per this phase's own fix.
      expect(finished.backgroundJobId).toBeNull();

      // A redelivered attempt against the same (already-terminal) AiJob
      // must stay a safe no-op, exactly like every other terminal-state
      // redelivery — not a second attempt at a resolution that will only
      // ever fail the same way.
      const redelivered = await unconfiguredProcessor.handle({ aiJobPublicId: job.publicId }, { ...ctx, attempt: 2 });
      expect(redelivered.aiJobPublicId).toBe(job.publicId);
      const stillFinished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(stillFinished.status).toBe("FAILED");
    } finally {
      await unconfiguredModuleRef.close();
    }
  }, 30_000);
});
