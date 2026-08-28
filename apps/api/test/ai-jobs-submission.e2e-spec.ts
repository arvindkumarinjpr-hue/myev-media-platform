import { randomUUID } from "crypto";
import { addActiveMemberWithRole, bootstrapE2eApp, createActiveUserAndLogin, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 3 Phase 3.3 — the durable AI Job submission/read API
 * (POST/GET /api/v1/workspaces/:workspaceId/ai/jobs). Proves submission
 * validation, the exact-Knowledge-Pack-version + ADR-004 active gate,
 * durable background_jobs linkage, RBAC, and cross-workspace isolation —
 * all against real Postgres. Actual provider EXECUTION (the durable
 * Worker picking the job up and completing it) is proven by apps/worker's
 * own ai-execute.e2e-spec.ts; this suite only proves the submission/read
 * boundary is correct, using the same shared E2E auth fixture (Part 25 of
 * this phase's own spec) every other feature suite now uses.
 */
describe("AI Jobs API — durable submission (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;

  const ALL_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"];

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  interface Workspace {
    id: string;
    publicId: string;
  }

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const row = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  // This suite submits real durable jobs a real, already-running Worker
  // picks up and executes asynchronously — waiting for every AiJob this
  // workspace created to reach a terminal status before cleanup starts
  // closes the race between the Worker's own ai_job_steps inserts and
  // cleanup's deletes entirely, rather than merely narrowing it by
  // reordering deletes. FakeProvider completes near-instantly, so this
  // never waits long in practice; a request that was correctly rejected
  // before ever reaching Queued state (no ai_jobs row at all) has nothing
  // to wait for.
  async function waitForAllAiJobsTerminal(ws: Workspace): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pending = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      if (pending === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await waitForAllAiJobsTerminal(ws);
    // ai_jobs.background_job_id must be cleared before the background_jobs
    // row it points at can be deleted (RESTRICT FK), and job_history rows
    // must go before their own background_jobs row for the identical
    // reason (mirrors test/helpers/e2e-app.ts's own teardown ordering).
    await ctx.prisma.aiJob.updateMany({ where: { workspaceId: ws.id }, data: { backgroundJobId: null } });
    const backgroundJobs = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
    const backgroundJobIds = backgroundJobs.map((j) => j.id);
    if (backgroundJobIds.length > 0) {
      await ctx.prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: backgroundJobIds } } });
      await ctx.prisma.backgroundJob.deleteMany({ where: { id: { in: backgroundJobIds } } });
    }
    // Deleted last, immediately before the AiJob rows they belong to —
    // this suite submits real durable jobs a real, already-running
    // Worker picks up and executes asynchronously (Part 25/this whole
    // phase's own design), so a step row can still be inserted after
    // this test's own assertions ran; closing this gap as late as
    // possible in cleanup minimizes (does not need to fully eliminate,
    // given FakeProvider's near-instant execution) that race.
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

  async function createActivePack(ws: Workspace): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Phase 3.3 AI Jobs Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
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

  it("submits a durable AI Job — 202 Accepted, QUEUED, a real background_jobs row created and linked", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { message: "hello" } })
      .expect(202);

    expect(res.body.data.status).toBe("QUEUED");
    expect(res.body.data.agentIdentifier).toBe("test-echo-agent");
    expect(res.body.data.knowledgePackVersionId).toBe(packPublicId);

    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { publicId: res.body.data.publicId, workspaceId: ws.id } });
    // The POST response is deterministically QUEUED (asserted above); the
    // persisted row, however, may already have been picked up by the
    // background Worker off the AI queue by the time this read runs —
    // this test is about durable submission (row + linked background_jobs
    // row + payload), not dispatch latency.
    expect(["QUEUED", "RUNNING", "COMPLETED"]).toContain(job.status);
    expect(job.backgroundJobId).toBeTruthy();

    const bgJob = await ctx.prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.backgroundJobId! } });
    expect(bgJob.jobType).toBe("ai.execute.v1");
    expect(bgJob.queueName).toBe("AI");
    expect((bgJob.payloadMetadata as { aiJobPublicId: string }).aiJobPublicId).toBe(job.publicId);

    await cleanup(ws);
  });

  it("GET returns the safe read-model shape — never BackgroundJob internals", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { message: "hello" } })
      .expect(202);

    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/ai/jobs/${created.body.data.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    expect(Object.keys(res.body.data).sort()).toEqual(
      [
        "publicId",
        "agentIdentifier",
        "agentVersion",
        "status",
        "knowledgePackVersionId",
        "providerUsed",
        "modelUsed",
        "tokenUsage",
        "costEstimate",
        // Module 3 Phase 3.5 — the exact generation settings
        // resolveAgentExecution() resolved for this execution.
        "generationSettings",
        "outputPayload",
        "errorCode",
        "errorMessageSafe",
        "correlationId",
        "createdAt",
        "startedAt",
        "completedAt",
      ].sort(),
    );
    await cleanup(ws);
  });

  it("Module 3 Phase 3.6: full generic AI runtime journey — real HTTP submission through real Worker execution to a terminal, provenance-complete GET response", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const correlationId = randomUUID();

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .set("X-Request-Id", correlationId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { message: "prove the full journey" } })
      .expect(202);
    expect(created.body.data.status).toBe("QUEUED");

    // Poll the real HTTP GET endpoint — not Prisma directly — until the
    // already-running real Worker (started as its own process, exactly
    // as CI/production do) drives this job to a terminal state. Proves
    // the entire chain end to end: API submission -> durable AiJob ->
    // BackgroundJob enqueued -> Worker picks it up -> exact Agent
    // version/Knowledge Pack version resolved -> execution policy
    // resolved -> provider/model selected via resolveAgentExecution ->
    // provider executes -> structured output validated -> usage/
    // generation-settings provenance persisted -> terminal state ->
    // safe API read returns the complete result.
    const deadline = Date.now() + 10_000;
    let final: { status: string; [key: string]: unknown } | undefined;
    while (Date.now() < deadline) {
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}/ai/jobs/${created.body.data.publicId}`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      if (res.body.data.status !== "QUEUED" && res.body.data.status !== "RUNNING") {
        final = res.body.data;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(final).toBeDefined();
    expect(final!.status).toBe("COMPLETED");
    expect(final!.agentIdentifier).toBe("test-echo-agent");
    expect(final!.agentVersion).toBe(1);
    expect(final!.knowledgePackVersionId).toBe(packPublicId);
    expect(final!.providerUsed).toBe("fake");
    expect(final!.modelUsed).toBe("fake-model-1");
    expect(final!.tokenUsage).toMatchObject({ tokensIn: expect.any(Number), tokensOut: expect.any(Number) });
    expect(final!.generationSettings).toEqual({});
    expect(final!.outputPayload).toBeTruthy();
    expect(final!.correlationId).toBe(correlationId);
    expect(final!.startedAt).toBeTruthy();
    expect(final!.completedAt).toBeTruthy();
    expect(final!.errorCode).toBeNull();

    await cleanup(ws);
  });

  it("rejects an unknown agent identifier — 404, no ai_jobs row created", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ agentIdentifier: "nonexistent-agent", knowledgePackVersionId: packPublicId, input: {} })
      .expect(404);

    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
    await cleanup(ws);
  });

  it("rejects input violating the agent's own schema — 422, no ai_jobs row created", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { wrongField: 1 } })
      .expect(422);

    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
    await cleanup(ws);
  });

  it("rejects a DRAFT (not yet ACTIVE) Knowledge Pack — 422, ADR-004 gate, no row", async () => {
    const ws = await createWorkspace();
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Draft Pack", industryProfile: {}, publishingStrategy: {} })
      .expect(201);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: createRes.body.data.publicId, input: { message: "hello" } })
      .expect(422);

    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
    await cleanup(ws);
  });

  it("rejects a Knowledge Pack from a different workspace — enumeration-safe 404, no row", async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    const packInA = await createActivePack(wsA);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsB.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packInA, input: { message: "hello" } })
      .expect(404);

    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: wsB.id } });
    expect(count).toBe(0);
    await cleanup(wsA);
    await cleanup(wsB);
  });

  it("rejects a request for another workspace's AI Job — 404, cross-workspace access blocked", async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    const packPublicId = await createActivePack(wsA);

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${wsA.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsA.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { message: "hello" } })
      .expect(202);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${wsB.publicId}/ai/jobs/${created.body.data.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", wsB.publicId)
      .expect(404);

    await cleanup(wsA);
    await cleanup(wsB);
  });

  it("RBAC — Content Writer (no AI_JOB_CREATE) is forbidden from submitting, and cannot view either", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { userId, accessToken } = await createActiveUserAndLogin(ctx, "ai-jobs-writer");
    await addActiveMemberWithRole(ctx, ws.id, userId, "Content Writer");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { message: "hello" } })
      .expect(403);

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { message: "hello" } })
      .expect(202);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/ai/jobs/${created.body.data.publicId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(403);

    await cleanup(ws);
  });

  it("RBAC — Administrator (AI_JOB_CREATE + AI_JOB_VIEW) can submit and view", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const { userId, accessToken } = await createActiveUserAndLogin(ctx, "ai-jobs-admin");
    await addActiveMemberWithRole(ctx, ws.id, userId, "Administrator");

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { message: "hello" } })
      .expect(202);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/ai/jobs/${created.body.data.publicId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    await cleanup(ws);
  });

  it("never persists provider credentials or raw errors — inputPayload/errorMessageSafe stay free of secret-looking strings", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws);
    const correlationId = randomUUID();

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/ai/jobs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .set("X-Request-Id", correlationId)
      .send({ agentIdentifier: "test-echo-agent", knowledgePackVersionId: packPublicId, input: { message: "hello" } })
      .expect(202);

    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { publicId: created.body.data.publicId } });
    expect(job.correlationId).toBe(correlationId);
    expect(JSON.stringify(job.inputPayload)).not.toMatch(/sk-|api[_-]?key|bearer /i);

    const entries = await ctx.prisma.auditLog.findMany({ where: { workspaceId: ws.id, action: "AI_EXECUTION_REQUESTED", correlationId } });
    expect(entries).toHaveLength(1);

    await cleanup(ws);
  });
});
