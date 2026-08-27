import { randomUUID } from "crypto";
import { RESEARCH_SOURCE_PROVIDER } from "../src/modules/research/research-source-provider.interface";
import { FakeResearchSourceProvider } from "../src/modules/research/fake-research-source-provider";
import { addActiveMemberWithRole, bootstrapE2eApp, createActiveUserAndLogin, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Module 4 Phase 4.1 — the user-facing Research API
 * (POST/GET /api/v1/workspaces/:workspaceId/research). Proves
 * submission validation, the exact-Knowledge-Pack-version + FR-RES-001
 * active gate, FR-RES-002's source-reachability-check-at-submission
 * behavior, RBAC, and cross-workspace isolation — all against real
 * Postgres. RESEARCH_SOURCE_PROVIDER is overridden to a deterministic
 * FakeResearchSourceProvider (no real network calls in CI). Actual
 * provider EXECUTION (the durable Worker picking the job up and
 * completing it against a mocked OpenAI client) is proven by apps/
 * worker's own research-agent.e2e-spec.ts, mirroring
 * ai-jobs-submission.e2e-spec.ts's own established split exactly —
 * this suite only proves the submission/read boundary is correct.
 */
describe("Research API (e2e)", () => {
  let ctx: E2eApp;
  let ownerAccessToken: string;
  let checkReachableCalls: { url: string; sourceType: string }[][] = [];

  const ALL_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"];

  beforeAll(async () => {
    ctx = await bootstrapE2eApp((builder) =>
      builder.overrideProvider(RESEARCH_SOURCE_PROVIDER).useFactory({
        factory: () => {
          const fake = new FakeResearchSourceProvider("selective", (url) => !url.includes("unreachable"));
          const original = fake.checkReachable.bind(fake);
          fake.checkReachable = async (sources) => {
            checkReachableCalls.push(sources);
            return original(sources);
          };
          return fake;
        },
      }),
    );
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

  async function waitForAllAiJobsTerminal(ws: Workspace): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pendingAiJobs = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      // research-agent can resolve PROVIDER_NOT_CONFIGURED essentially
      // instantly (no real network delay at all, unlike a completing
      // FakeProvider call) — narrow enough that BullMqWorkerManager's own
      // background_jobs/job_history write for the SAME job can still be
      // in flight even after ai_jobs.status has already gone terminal.
      // Waiting for both closes the race that caused
      // `job_history_background_job_id_fkey` violations in cleanup below.
      const pendingBackgroundJobs = await ctx.prisma.backgroundJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      if (pendingAiJobs === 0 && pendingBackgroundJobs === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await waitForAllAiJobsTerminal(ws);
    await ctx.prisma.aiJob.updateMany({ where: { workspaceId: ws.id }, data: { backgroundJobId: null } });
    const backgroundJobs = await ctx.prisma.backgroundJob.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
    const backgroundJobIds = backgroundJobs.map((j) => j.id);
    if (backgroundJobIds.length > 0) {
      await ctx.prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: backgroundJobIds } } });
      await ctx.prisma.backgroundJob.deleteMany({ where: { id: { in: backgroundJobIds } } });
    }
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

  async function createActivePack(ws: Workspace, sources: { sourceType: string; url: string }[]): Promise<string> {
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Research Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packPublicId = createRes.body.data.publicId as string;

    await request(ctx.app.getHttpServer())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packPublicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({
        expectedLockVersion: 1,
        sources,
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

  it("submits research — 202 Accepted, QUEUED, a real ai_jobs row created with the exact topic and reachability-checked sources", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws, [
      { sourceType: "GOVERNMENT", url: "https://reachable.example/gov" },
      { sourceType: "PUBLICATION", url: "https://unreachable.example/news" },
    ]);
    checkReachableCalls = [];

    const res = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "EV battery swap stations", knowledgePackVersionId: packPublicId })
      .expect(202);

    expect(res.body.data.status).toBe("QUEUED");
    expect(res.body.data.topic).toBe("EV battery swap stations");

    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { publicId: res.body.data.publicId, workspaceId: ws.id } });
    expect(job.agentName).toBe("research-agent");
    const input = job.inputPayload as { verifiedSources: { sourceId: string; url: string; reachable: boolean }[] };
    expect(input.verifiedSources).toEqual(
      expect.arrayContaining([
        { sourceId: expect.any(String), url: "https://reachable.example/gov", sourceType: "GOVERNMENT", reachable: true },
        { sourceId: expect.any(String), url: "https://unreachable.example/news", sourceType: "PUBLICATION", reachable: false },
      ]),
    );
    // Module 4 Phase 4.3 — sourceIds are stable and distinct per run,
    // never derived from or guessable by the model (RESEARCH_AGENT_V1's
    // own structural citation enforcement depends on this).
    const sourceIds = input.verifiedSources.map((s) => s.sourceId);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    // The reachability check genuinely ran against the pack's own
    // trusted sources, at submission time — not skipped, not faked.
    expect(checkReachableCalls.length).toBeGreaterThan(0);

    await cleanup(ws);
  });

  it("GET list returns only this workspace's research, newest first", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws, [{ sourceType: "PUBLICATION", url: "https://reachable.example/a" }]);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "first topic", knowledgePackVersionId: packPublicId })
      .expect(202);
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "second topic", knowledgePackVersionId: packPublicId })
      .expect(202);

    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((r: { topic: string }) => r.topic)).toEqual(["second topic", "first topic"]);

    await cleanup(ws);
  });

  it("GET returns the safe read-model shape — never BackgroundJob internals", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws, [{ sourceType: "PUBLICATION", url: "https://reachable.example/a" }]);

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "shape test", knowledgePackVersionId: packPublicId })
      .expect(202);

    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/research/${created.body.data.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    expect(Object.keys(res.body.data).sort()).toEqual(
      ["publicId", "topic", "status", "knowledgePackVersionId", "agentVersion", "providerUsed", "modelUsed", "tokenUsage", "generationSettings", "result", "errorCode", "errorMessageSafe", "correlationId", "createdAt", "startedAt", "completedAt"].sort(),
    );

    await cleanup(ws);
  });

  it("rejects an empty topic — 400, no ai_jobs row created", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws, [{ sourceType: "PUBLICATION", url: "https://reachable.example/a" }]);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "", knowledgePackVersionId: packPublicId })
      .expect(400);

    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
    await cleanup(ws);
  });

  it("rejects a DRAFT (not yet ACTIVE) Knowledge Pack — 422, FR-RES-001's own gate, no row, no reachability check performed", async () => {
    const ws = await createWorkspace();
    const createRes = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ name: "Draft Pack" })
      .expect(201);
    const draftPackPublicId = createRes.body.data.publicId as string;
    checkReachableCalls = [];

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "should not run", knowledgePackVersionId: draftPackPublicId })
      .expect(422);

    const count = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
    expect(checkReachableCalls).toHaveLength(0);
    await cleanup(ws);
  });

  it("rejects a Knowledge Pack from a different workspace — enumeration-safe 404, no row", async () => {
    const ws = await createWorkspace();
    const otherWs = await createWorkspace();
    const otherPackPublicId = await createActivePack(otherWs, [{ sourceType: "PUBLICATION", url: "https://reachable.example/a" }]);

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "cross-workspace", knowledgePackVersionId: otherPackPublicId })
      .expect(404);

    await cleanup(ws);
    await cleanup(otherWs);
  });

  it("rejects a request for another workspace's research — 404, cross-workspace access blocked", async () => {
    const ws = await createWorkspace();
    const otherWs = await createWorkspace();
    const packPublicId = await createActivePack(ws, [{ sourceType: "PUBLICATION", url: "https://reachable.example/a" }]);

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "private topic", knowledgePackVersionId: packPublicId })
      .expect(202);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${otherWs.publicId}/research/${created.body.data.publicId}`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", otherWs.publicId)
      .expect(404);

    await cleanup(ws);
    await cleanup(otherWs);
  });

  it("RBAC — Analyst (no RESEARCH_RUN/RESEARCH_VIEW) is forbidden from submitting and cannot view either", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws, [{ sourceType: "PUBLICATION", url: "https://reachable.example/a" }]);
    const analyst = await createActiveUserAndLogin(ctx, "research-analyst");
    await addActiveMemberWithRole(ctx, ws.id, analyst.userId, "Analyst");

    await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${analyst.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "forbidden", knowledgePackVersionId: packPublicId })
      .expect(403);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${analyst.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(403);

    await cleanup(ws);
  });

  it("RBAC — Content Writer (RESEARCH_RUN + RESEARCH_VIEW) can submit and view", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws, [{ sourceType: "PUBLICATION", url: "https://reachable.example/a" }]);
    const writer = await createActiveUserAndLogin(ctx, "research-writer");
    await addActiveMemberWithRole(ctx, ws.id, writer.userId, "Content Writer");

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${writer.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .send({ topic: "allowed", knowledgePackVersionId: packPublicId })
      .expect(202);

    await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${ws.publicId}/research/${created.body.data.publicId}`)
      .set("Authorization", `Bearer ${writer.accessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .expect(200);

    await cleanup(ws);
  });

  it("never persists provider credentials — inputPayload stays free of secret-looking strings", async () => {
    const ws = await createWorkspace();
    const packPublicId = await createActivePack(ws, [{ sourceType: "PUBLICATION", url: "https://reachable.example/a" }]);
    const correlationId = randomUUID();

    const created = await request(ctx.app.getHttpServer())
      .post(`/api/v1/workspaces/${ws.publicId}/research`)
      .set("Authorization", `Bearer ${ownerAccessToken}`)
      .set("X-Workspace-Id", ws.publicId)
      .set("X-Request-Id", correlationId)
      .send({ topic: "secret check", knowledgePackVersionId: packPublicId })
      .expect(202);

    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { publicId: created.body.data.publicId } });
    expect(job.correlationId).toBe(correlationId);
    expect(JSON.stringify(job.inputPayload)).not.toMatch(/sk-|api[_-]?key|bearer /i);

    await cleanup(ws);
  });
});
