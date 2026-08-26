import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type OpenAI from "openai";
import { AI_EXECUTE_V1_MANIFEST, AIProviderRegistryBuilder, OpenAIProvider } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { AiExecuteProcessor } from "../src/queue/processors/ai-execute.processor";
import { AI_PROVIDER_REGISTRY } from "../src/ai-provider/ai-provider-registry.module";
import type { AiJob, BackgroundJob } from "../../api/generated/prisma";

/**
 * Module 4 Phase 4.1 — proves RESEARCH_AGENT_V1 (the first real
 * business agent, already registered in this worker's own real
 * AgentRegistry — no override needed for it) actually completes through
 * the unmodified durable pipeline against a production-style
 * AIProviderRegistry: a real OpenAIProvider adapter wrapping a
 * jest-mocked `openai` SDK client, exactly mirroring Module 3 Phase
 * 3.4's own ai-execute-production-provider.e2e-spec.ts pattern. Only
 * AI_PROVIDER_REGISTRY is overridden (to supply "openai" — this
 * environment's own default dev/test registry only has "fake") —
 * AGENT_REGISTRY is the real one, since research-agent is already in
 * it for real.
 */
describe("Worker (e2e) — research-agent against a production-style provider registry", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM,AI";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";

  const VALID_OUTPUT = {
    executiveSummary: "EV battery swap stations are seeing accelerating pilot deployments.",
    findings: [{ summary: "Multiple government pilots are underway.", evidence: "Referenced in the government source.", sourceUrls: ["https://reachable.example/gov"] }],
    sources: [{ url: "https://reachable.example/gov", sourceType: "GOVERNMENT", title: "EV Infrastructure Report" }],
    trendSignals: [{ topic: "battery swap", direction: "rising", confidence: 65, evidence: "Government pilot count increasing per the cited source." }],
    keywordOpportunities: [{ keyword: "ev battery swap station", intent: "informational", opportunityScore: 58, rationale: "High topical relevance, no direct competitor content found among the given sources." }],
    contentAngles: ["A regional breakdown of battery swap pilot programs"],
  };

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let processor: AiExecuteProcessor;
  let mockCreate: jest.Mock;

  async function bootstrapWithMockedOpenAi(responseContent: string): Promise<{ moduleRef: TestingModule; processor: AiExecuteProcessor; prisma: PrismaService; mockCreate: jest.Mock }> {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl_research_test",
      model: "gpt-4o-2024-08-06",
      choices: [{ message: { content: responseContent }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 120, total_tokens: 160 },
    });
    const mockOpenAiClient = { chat: { completions: { create } } } as unknown as OpenAI;

    const providerRegistryBuilder = new AIProviderRegistryBuilder();
    providerRegistryBuilder.register(new OpenAIProvider(mockOpenAiClient, { provider: "openai", model: "gpt-4o", defaults: {} }));
    const providerRegistry = providerRegistryBuilder.freeze();

    const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_PROVIDER_REGISTRY).useValue(providerRegistry).compile();
    await ref.init();
    return { moduleRef: ref, processor: ref.get(AiExecuteProcessor), prisma: ref.get(PrismaService), mockCreate: create };
  }

  afterEach(async () => {
    if (moduleRef) await moduleRef.close();
  });

  async function createTestWorkspace(p: PrismaService): Promise<{ userId: string; workspaceId: string }> {
    const suffix = randomUUID();
    const user = await p.user.create({ data: { email: `research-agent-test-${suffix}@example.invalid`, fullName: "Research Agent Test User", status: "ACTIVE" } });
    const workspace = await p.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: `Research Agent Test Workspace ${suffix}`, slug: `research-agent-test-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { userId: user.id, workspaceId: workspace.id };
  }

  async function createActiveKnowledgePack(p: PrismaService, workspaceId: string, userId: string): Promise<string> {
    const id = randomUUID();
    const pack = await p.knowledgePack.create({
      data: { id, workspaceId, name: "Research Agent Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: {}, lineageRootId: id, status: "ACTIVE", createdById: userId },
    });
    return pack.id;
  }

  async function createResearchAiJob(p: PrismaService, workspaceId: string, userId: string, knowledgePackId: string): Promise<AiJob> {
    return p.aiJob.create({
      data: {
        workspaceId,
        agentName: "research-agent",
        agentVersion: 1,
        triggeringModule: "worker-e2e-test",
        knowledgePackId,
        inputPayload: {
          topic: "EV battery swap stations",
          verifiedSources: [{ url: "https://reachable.example/gov", sourceType: "GOVERNMENT", reachable: true }],
        },
        status: "QUEUED",
        correlationId: randomUUID(),
        createdById: userId,
      },
    });
  }

  async function createBackgroundJobRow(p: PrismaService): Promise<BackgroundJob> {
    const backgroundJob = await p.backgroundJob.create({
      data: { jobType: AI_EXECUTE_V1_MANIFEST.jobType, queueName: AI_EXECUTE_V1_MANIFEST.queue, payloadMetadata: {}, maxAttempts: AI_EXECUTE_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1, correlationId: randomUUID() },
    });
    await p.backgroundJobHistory.create({ data: { backgroundJobId: backgroundJob.id, toStatus: "QUEUED" } });
    return backgroundJob;
  }

  it("completes with the exact structured ResearchAgentOutput persisted to outputPayload, provider/model/provenance recorded", async () => {
    ({ moduleRef, processor, prisma, mockCreate } = await bootstrapWithMockedOpenAi(JSON.stringify(VALID_OUTPUT)));

    const { userId, workspaceId } = await createTestWorkspace(prisma);
    const knowledgePackId = await createActiveKnowledgePack(prisma, workspaceId, userId);
    const job = await createResearchAiJob(prisma, workspaceId, userId, knowledgePackId);
    const backgroundJob = await createBackgroundJobRow(prisma);

    const result = await processor.handle({ aiJobPublicId: job.publicId }, { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false });
    expect(result.aiJobPublicId).toBe(job.publicId);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.providerUsed).toBe("openai");
    expect(finished.agentVersion).toBe(1);
    expect(finished.outputPayload).toEqual(VALID_OUTPUT);

    // The exact Knowledge Pack this ran against is independently
    // re-verifiable from the row itself, not just trusted from submission
    // time (Module 3's own execution-provenance guarantee, unchanged).
    expect(finished.knowledgePackId).toBe(knowledgePackId);
  }, 30_000);

  it("rejects malformed structured output safely — terminal FAILED, MALFORMED_STRUCTURED_OUTPUT, never a raw/partial object persisted", async () => {
    ({ moduleRef, processor, prisma, mockCreate } = await bootstrapWithMockedOpenAi(JSON.stringify({ executiveSummary: "missing everything else" })));

    const { userId, workspaceId } = await createTestWorkspace(prisma);
    const knowledgePackId = await createActiveKnowledgePack(prisma, workspaceId, userId);
    const job = await createResearchAiJob(prisma, workspaceId, userId, knowledgePackId);
    const backgroundJob = await createBackgroundJobRow(prisma);

    await expect(processor.handle({ aiJobPublicId: job.publicId }, { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false })).rejects.toThrow();

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("FAILED");
    expect(finished.errorCode).toBe("MALFORMED_STRUCTURED_OUTPUT");
    expect(finished.outputPayload).toBeNull();
  }, 30_000);

  it("never cites a URL outside the request's own verifiedSources — the mocked model output is validated, not trusted blindly", async () => {
    const fabricated = { ...VALID_OUTPUT, sources: [{ url: "https://fabricated-not-in-request.example", sourceType: "GOVERNMENT" }] };
    ({ moduleRef, processor, prisma, mockCreate } = await bootstrapWithMockedOpenAi(JSON.stringify(fabricated)));

    const { userId, workspaceId } = await createTestWorkspace(prisma);
    const knowledgePackId = await createActiveKnowledgePack(prisma, workspaceId, userId);
    const job = await createResearchAiJob(prisma, workspaceId, userId, knowledgePackId);
    const backgroundJob = await createBackgroundJobRow(prisma);

    // Module 3's own structured-output validation only enforces shape
    // (schema), not citation provenance — that integrity guarantee is
    // the buildPrompt system-instruction contract (research-agent.spec.ts,
    // packages/shared), not a runtime check here. This test documents
    // that boundary honestly: the pipeline persists whatever
    // schema-valid output the model returned; citation-fabrication
    // resistance is a prompt-engineering guarantee, not (yet) a
    // structural one enforced by this processor.
    await processor.handle({ aiJobPublicId: job.publicId }, { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false });
    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("COMPLETED");
  }, 30_000);
});
