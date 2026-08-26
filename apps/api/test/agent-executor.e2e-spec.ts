import { randomUUID } from "crypto";
import {
  AgentRegistryBuilder,
  AIProviderRegistryBuilder,
  FakeProvider,
  TEST_ECHO_AGENT_V1,
  TEST_POST_PROCESS_AGENT_V1,
  type AgentExecutionRequest,
  type AgentRegistry,
  type AIProviderRegistry,
  type FakeProviderMode,
} from "@myev/shared";
import { AgentExecutorService } from "../src/modules/ai-agents/agent-executor.service";
import { AuditService } from "../src/modules/audit/audit.service";
import { KnowledgePacksService } from "../src/modules/knowledge-packs/knowledge-packs.service";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 3 Phase 3.2 — proves the full Agent Framework end-to-end
 * against real Postgres (ai_jobs/ai_job_steps + Module 2's real
 * Knowledge Pack lifecycle), with zero paid/network AI calls
 * (FakeProvider only, per Part 17's own requirement). AgentExecutorService
 * is instantiated directly (not resolved from the app's DI container) so
 * each test can swap in its own AIProviderRegistry/AgentRegistry —
 * KnowledgePacksService/PrismaService/AuditService are the real,
 * DI-resolved instances from the one bootstrapped app either way.
 *
 * AgentExecutionRequest.workspaceId is the INTERNAL workspace id (the
 * same value every controller resolves via WorkspaceContextGuard's
 * `@CurrentWorkspace()` before calling a service — see
 * KnowledgePacksController.findOne passing `workspace.id`, never
 * `workspace.publicId`) — AgentExecutorService is an internal
 * service-layer primitive, not an HTTP boundary, so it follows that same
 * internal-id convention. `Workspace` below resolves both once per test.
 */
describe("AgentExecutorService (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let knowledgePacks: KnowledgePacksService;
  let audit: AuditService;

  const ALL_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"];

  interface Workspace {
    id: string;
    publicId: string;
  }

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
    knowledgePacks = ctx.app.get(KnowledgePacksService);
    audit = ctx.app.get(AuditService);
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const row = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  async function cleanupKnowledgePacks(ws: Workspace): Promise<void> {
    await ctx.prisma.aiJobStep.deleteMany({ where: { aiJob: { workspaceId: ws.id } } });
    await ctx.prisma.aiJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.project.updateMany({ where: { workspaceId: ws.id }, data: { knowledgePackId: null } });
    const packs = await ctx.prisma.knowledgePack.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
    const packIds = packs.map((p) => p.id);
    if (packIds.length === 0) return;
    await ctx.prisma.knowledgeSource.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.promptTemplate.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.knowledgePackSeoRule.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.brandGuideline.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.keywordSet.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.competitor.deleteMany({ where: { knowledgePackId: { in: packIds } } });
    await ctx.prisma.knowledgePack.updateMany({ where: { id: { in: packIds } }, data: { currentVersionOfId: null } });
    await ctx.prisma.knowledgePack.deleteMany({ where: { id: { in: packIds } } });
  }

  /** Creates a Draft with every FR-KP-005 gate satisfied, then validates it to ACTIVE. */
  async function createActivePack(ws: Workspace): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Phase 3.2 Agent Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ALL_CONTENT_TYPES.map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}/validate`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    return packPublicId;
  }

  function executorWithProvider(mode: FakeProviderMode, structuredPayload: Record<string, unknown> = {}): { executor: AgentExecutorService; agentRegistry: AgentRegistry; providerRegistry: AIProviderRegistry } {
    const agentBuilder = new AgentRegistryBuilder();
    agentBuilder.register(TEST_ECHO_AGENT_V1);
    const agentRegistry = agentBuilder.freeze();

    const providerBuilder = new AIProviderRegistryBuilder();
    providerBuilder.register(new FakeProvider(mode, structuredPayload));
    const providerRegistry = providerBuilder.freeze();

    const executor = new AgentExecutorService(agentRegistry, providerRegistry, knowledgePacks, ctx.prisma, audit);
    return { executor, agentRegistry, providerRegistry };
  }

  function executorWithPostProcessAgent(structuredPayload: Record<string, unknown>): { executor: AgentExecutorService } {
    const agentBuilder = new AgentRegistryBuilder();
    agentBuilder.register(TEST_POST_PROCESS_AGENT_V1);
    const agentRegistry = agentBuilder.freeze();

    const providerBuilder = new AIProviderRegistryBuilder();
    providerBuilder.register(new FakeProvider("structured_success", structuredPayload));
    const providerRegistry = providerBuilder.freeze();

    const executor = new AgentExecutorService(agentRegistry, providerRegistry, knowledgePacks, ctx.prisma, audit);
    return { executor };
  }

  function baseRequest(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
    return {
      agentIdentifier: "test-echo-agent",
      workspaceId: "",
      knowledgePackVersionId: "",
      input: { message: "hello agent framework" },
      correlationId: randomUUID(),
      ...overrides,
    };
  }

  it("executes successfully end-to-end and returns a schema-validated structured output", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("structured_success", { echo: "hello agent framework" });

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toMatchObject({ echo: "hello agent framework" });
    expect(result.providerUsed).toBe("fake");
    expect(result.modelUsed).toBe("fake-model-1");
    await cleanupKnowledgePacks(ws);
  });

  it("propagates normalized token usage metadata into the result", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("structured_success", { echo: "x" });

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.tokenUsage).toEqual({ tokensIn: 10, tokensOut: 20, tokensTotal: 30 });
    await cleanupKnowledgePacks(ws);
  });

  it("Module 4 Phase 4.2: invokes AgentDefinition.postProcessOutput when defined, and persists the transformed (not raw) output", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithPostProcessAgent({ echo: "raw provider output" });

    const result = await executor.execute(baseRequest({ agentIdentifier: "test-post-process-agent", workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ echo: "raw provider output [processed]" });

    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, agentName: "test-post-process-agent" } });
    expect(job.outputPayload).toEqual({ echo: "raw provider output [processed]" });
    await cleanupKnowledgePacks(ws);
  });

  it("records exact agent version and Knowledge Pack version used, in both the result and the persisted ai_jobs row", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("structured_success", { echo: "x" });

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.agentVersionUsed).toBe(1);
    expect(result.knowledgePackVersionUsed).toBe(packPublicId);

    const dbPack = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: packPublicId } });
    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(job.agentName).toBe("test-echo-agent");
    expect(job.agentVersion).toBe(1);
    expect(job.knowledgePackId).toBe(dbPack.id);
    expect(job.status).toBe("COMPLETED");
    await cleanupKnowledgePacks(ws);
  });

  it("records both ai_job_steps for a successful execution", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("structured_success", { echo: "x" });

    await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id } });
    const steps = await ctx.prisma.aiJobStep.findMany({ where: { aiJobId: job.id } });
    const stepNames = steps.map((s) => `${s.stepName}:${s.stepStatus}`).sort();
    expect(stepNames).toEqual(["knowledge_pack_resolution:COMPLETED", "provider_execution:COMPLETED"]);
    await cleanupKnowledgePacks(ws);
  });

  it("rejects an unknown agent identifier — FAILED, no ai_jobs row created", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("success");

    const result = await executor.execute(baseRequest({ agentIdentifier: "nonexistent-agent", workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("UNKNOWN_AGENT");
    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
    await cleanupKnowledgePacks(ws);
  });

  it("rejects input that violates the agent's own input schema — FAILED, no ai_jobs row created", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("success");

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId, input: { wrongField: 123 } }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("INPUT_VALIDATION_FAILED");
    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
    await cleanupKnowledgePacks(ws);
  });

  it("rejects a Knowledge Pack that exists but belongs to a different workspace — enumeration-safe FAILED, no row", async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    const packInA = await createActivePack(wsA);
    const { executor } = executorWithProvider("success");

    const result = await executor.execute(baseRequest({ workspaceId: wsB.id, knowledgePackVersionId: packInA }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("KNOWLEDGE_PACK_NOT_FOUND");
    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: wsB.id } });
    expect(count).toBe(0);
    await cleanupKnowledgePacks(wsA);
    await cleanupKnowledgePacks(wsB);
  });

  it("rejects a nonexistent Knowledge Pack id — FAILED, no row", async () => {
    const ws = await createWorkspace();
    const { executor } = executorWithProvider("success");

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: randomUUID() }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("KNOWLEDGE_PACK_NOT_FOUND");
  });

  it("rejects a DRAFT (not yet ACTIVE) Knowledge Pack — ADR-004 gate, FAILED, no row", async () => {
    const ws = await createWorkspace();
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Draft Pack", industryProfile: {}, publishingStrategy: {} })
      .expect(201);
    const draftPackId = createRes.body.data.publicId as string;
    const { executor } = executorWithProvider("success");

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: draftPackId }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("KNOWLEDGE_PACK_NOT_ACTIVE");
    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
    await cleanupKnowledgePacks(ws);
  });

  it("rejects malformed structured output from the provider — FAILED, PROVIDER_ERROR/MALFORMED_STRUCTURED_OUTPUT", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    // "echo" must be a string per TestEchoAgentOutput's own @IsString() —
    // this payload violates that schema.
    const { executor } = executorWithProvider("structured_success", { echo: 12345 });

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("PROVIDER_ERROR");
    expect(result.failure?.providerErrorCode).toBe("MALFORMED_STRUCTURED_OUTPUT");
    await cleanupKnowledgePacks(ws);
  });

  it("classifies a transient provider failure as retryable and does not swallow it", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("transient_error");

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.providerErrorCode).toBe("TRANSIENT_NETWORK");
    expect(result.failure?.retryable).toBe(true);
    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("TRANSIENT_NETWORK");
    await cleanupKnowledgePacks(ws);
  });

  it("classifies a permanent provider failure as non-retryable", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("permanent_error");

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.providerErrorCode).toBe("INVALID_REQUEST");
    expect(result.failure?.retryable).toBe(false);
    await cleanupKnowledgePacks(ws);
  });

  it("classifies a rate-limited provider failure as retryable, distinct from a timeout", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("rate_limit");

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.providerErrorCode).toBe("RATE_LIMIT");
    expect(result.failure?.retryable).toBe(true);
    await cleanupKnowledgePacks(ws);
  });

  it("maps a provider timeout to the exact TIMED_OUT status (distinct from FAILED)", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("timeout");

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("TIMED_OUT");
    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(job.status).toBe("TIMED_OUT");
    const steps = await ctx.prisma.aiJobStep.findMany({ where: { aiJobId: job.id, stepName: "provider_execution" } });
    expect(steps[0]?.stepStatus).toBe("TIMED_OUT");
    await cleanupKnowledgePacks(ws);
  });

  it("never leaks a raw error message into the persisted or returned failure — messageSafe only", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("transient_error");

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.failure?.messageSafe).not.toMatch(/at Object\.|at async|\.ts:\d+/);
    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(job.errorMessageSafe).not.toMatch(/at Object\.|at async|\.ts:\d+/);
    await cleanupKnowledgePacks(ws);
  });

  it("produces deterministic execution provenance for the same input across repeated runs", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("structured_success", { echo: "stable" });

    const first = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId, correlationId: randomUUID() }), "test-harness");
    const second = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId, correlationId: randomUUID() }), "test-harness");

    expect(first.output).toEqual(second.output);
    expect(first.tokenUsage).toEqual(second.tokenUsage);
    expect(first.agentVersionUsed).toBe(second.agentVersionUsed);
    expect(first.knowledgePackVersionUsed).toBe(second.knowledgePackVersionUsed);
    await cleanupKnowledgePacks(ws);
  });

  it("records an AI_EXECUTION_REQUESTED audit entry only once the request reaches Queued state", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("structured_success", { echo: "x" });
    const correlationId = randomUUID();

    await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId, correlationId }), "test-harness");

    const entries = await ctx.prisma.auditLog.findMany({ where: { workspaceId: ws.id, action: "AI_EXECUTION_REQUESTED", correlationId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entityType).toBe("ai_job");
    await cleanupKnowledgePacks(ws);
  });

  it("does NOT audit AI_EXECUTION_REQUESTED for a request rejected before Queued state (unknown agent)", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { executor } = executorWithProvider("success");
    const correlationId = randomUUID();

    await executor.execute(baseRequest({ agentIdentifier: "nonexistent-agent", workspaceId: ws.id, knowledgePackVersionId: packPublicId, correlationId }), "test-harness");

    const entries = await ctx.prisma.auditLog.findMany({ where: { workspaceId: ws.id, action: "AI_EXECUTION_REQUESTED", correlationId } });
    expect(entries).toHaveLength(0);
    await cleanupKnowledgePacks(ws);
  });

  it("Module 3 Phase 3.5: an agent whose required provider is not registered terminates cleanly FAILED/PROVIDER_NOT_CONFIGURED — the ai_jobs row already exists by this point, so it must never be left stuck QUEUED/RUNNING", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);

    // An empty provider registry — TEST_ECHO_AGENT_V1's own "fake"
    // provider preference is never registered, simulating a real
    // production environment where the required provider's credentials
    // aren't configured.
    const agentBuilder = new AgentRegistryBuilder();
    agentBuilder.register(TEST_ECHO_AGENT_V1);
    const agentRegistry = agentBuilder.freeze();
    const providerRegistry = new AIProviderRegistryBuilder().freeze();
    const executor = new AgentExecutorService(agentRegistry, providerRegistry, knowledgePacks, ctx.prisma, audit);

    const result = await executor.execute(baseRequest({ workspaceId: ws.id, knowledgePackVersionId: packPublicId }), "test-harness");

    expect(result.status).toBe("FAILED");
    expect(result.failure?.code).toBe("PROVIDER_NOT_CONFIGURED");

    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id } });
    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
    await cleanupKnowledgePacks(ws);
  });
});
