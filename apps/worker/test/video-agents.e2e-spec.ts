import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type OpenAI from "openai";
import { AI_EXECUTE_V1_MANIFEST, AIProviderRegistryBuilder, OpenAIProvider } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@myev/worker-core";
import { AiExecuteProcessor } from "../src/queue/processors/ai-execute.processor";
import { AI_PROVIDER_REGISTRY } from "../src/ai-provider/ai-provider-registry.module";
import type { AiJob, BackgroundJob } from "../../api/generated/prisma";

/**
 * Module 7 Phase 7.2 — proves each Video pipeline text/advisory agent
 * (already registered for real in this worker's own AgentRegistry)
 * completes through the UNMODIFIED durable ai.execute.v1 pipeline against
 * a production-style provider registry, that malformed provider output
 * fails the job safely, and that the frozen ADR-004 / provider-not-
 * configured behaviours (proven for Blog in blog-agents.e2e-spec.ts) are
 * preserved for every new agent. Mirrors that file's structure exactly.
 */

process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM,AI";
process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";

const BRIEF_OUTPUT = {
  objective: "Show a new EV owner how to start home charging in under a minute.",
  audience: "New EV owners without a home charger yet",
  targetPlatform: "YOUTUBE_SHORTS",
  durationSeconds: 45,
  cta: "Book a free home charger install assessment.",
  rationale: "Shorts audiences need the payoff fast; 45s fits one how-to beat.",
};
const SCRIPT_OUTPUT_RAW = {
  hook: "Charging your EV at home is easier than you think.",
  segments: [
    { order: 1, id: "seg-1", label: "Hook", narration: "Charging your EV at home is easier than you think.", purpose: "stop the scroll" },
    { order: 2, id: "seg-2", label: "Setup", narration: "Plug in, pick a schedule, done.", purpose: "show the steps" },
  ],
  cta: "Book a free install assessment.",
};
// VIDEO_SCRIPT_AGENT_V1's own postProcessOutput deterministically renders
// scriptBody from hook/segments/cta whenever the raw provider response
// omits it (as here) — the real ai_jobs.output_payload always carries it,
// so the "exact structured output persisted" assertion must too.
const SCRIPT_OUTPUT = {
  ...SCRIPT_OUTPUT_RAW,
  scriptBody: [
    `HOOK: ${SCRIPT_OUTPUT_RAW.hook}`,
    "",
    ...SCRIPT_OUTPUT_RAW.segments.flatMap((s) => [`[${s.id}] ${s.label}`, s.narration, ""]),
    `CTA: ${SCRIPT_OUTPUT_RAW.cta}`,
  ].join("\n"),
};
const SCENE_PLAN_OUTPUT = {
  scenePlanVersion: 1,
  targetPlatform: "YOUTUBE_SHORTS",
  scenes: [
    {
      order: 1,
      sceneId: "scene-1",
      scriptSegmentRef: "seg-1",
      startSeconds: 0,
      durationSeconds: 3,
      visualInstruction: "Close on hands plugging in a charger.",
      transition: "cut",
      assetRequirements: [{ kind: "video_clip", description: "Plugging in a Level 2 charger", sourceHint: "stock" }],
    },
    {
      order: 2,
      sceneId: "scene-2",
      scriptSegmentRef: "seg-2",
      startSeconds: 3,
      durationSeconds: 3,
      visualInstruction: "Phone app showing a charge schedule.",
      transition: "fade",
      assetRequirements: [{ kind: "image", description: "Charging app UI", sourceHint: "ai_generated" }],
    },
  ],
};
const SEO_OUTPUT = {
  metaTitle: "Home EV Charging: The Complete Setup Guide",
  metaDescription: "Everything you need to charge your EV at home.",
  tags: ["ev charging", "home charger"],
  chapters: [{ startSeconds: 0, title: "Intro" }],
  hashtags: ["#ev", "#homecharging"],
  schemaMarkup: { "@type": "VideoObject", name: "Home EV Charging: The Complete Setup Guide", description: "A guide to home EV charging.", duration: "PT45S" },
};
const THUMBNAIL_OUTPUT = {
  concepts: [
    { title: "Shocked reaction", visualDirection: "Owner pointing at a low bill", overlayText: "SO CHEAP?!", composition: "Face left, bill right", ctrHypothesis: "Curiosity gap on price." },
    { title: "Before/after", visualDirection: "Split screen gas vs charger", overlayText: "NEVER AGAIN", composition: "Vertical split", ctrHypothesis: "Instant visual contrast." },
  ],
};
const RECOMMENDATIONS_OUTPUT = {
  recommendations: [{ kind: "stronger_hook", suggestion: "Open on the electric bill number.", rationale: "A concrete number earns more retention than an abstract claim." }],
};

interface AgentCase {
  agentName: string;
  input: Record<string, unknown>;
  validOutput: Record<string, unknown>;
}

const CASES: AgentCase[] = [
  { agentName: "video-brief-agent", input: { topic: "Home EV charging", targetPlatform: "YOUTUBE_SHORTS" }, validOutput: BRIEF_OUTPUT },
  {
    agentName: "video-script-agent",
    input: { topic: "Home EV charging", targetPlatform: "YOUTUBE_SHORTS", objective: "Teach setup", audience: "New EV owners", durationSeconds: 45, cta: "Book an assessment" },
    validOutput: SCRIPT_OUTPUT,
  },
  {
    agentName: "video-scene-planner-agent",
    input: { topic: "Home EV charging", targetPlatform: "YOUTUBE_SHORTS", durationSeconds: 45, hook: SCRIPT_OUTPUT.hook, segments: SCRIPT_OUTPUT.segments },
    validOutput: SCENE_PLAN_OUTPUT,
  },
  {
    agentName: "video-seo-metadata-agent",
    input: {
      topic: "Home EV charging",
      targetPlatform: "YOUTUBE_SHORTS",
      objective: "Teach setup",
      audience: "New EV owners",
      durationSeconds: 45,
      hook: SCRIPT_OUTPUT.hook,
      scriptSummary: "Plug in, pick a schedule, done.",
      segmentOutline: [{ label: "Hook", startSeconds: 0 }],
    },
    validOutput: SEO_OUTPUT,
  },
  {
    agentName: "thumbnail-concept-agent",
    input: { topic: "Home EV charging", targetPlatform: "YOUTUBE_SHORTS", hook: SCRIPT_OUTPUT.hook, objective: "Teach setup", audience: "New EV owners" },
    validOutput: THUMBNAIL_OUTPUT,
  },
  {
    agentName: "video-recommendations-agent",
    input: { topic: "Home EV charging", targetPlatform: "YOUTUBE_SHORTS", objective: "Teach setup", hook: SCRIPT_OUTPUT.hook, scriptSummary: "Plug in, pick a schedule, done." },
    validOutput: RECOMMENDATIONS_OUTPUT,
  },
];

describe("Worker (e2e) — Video pipeline agents against a production-style provider registry", () => {
  let moduleRef: TestingModule | undefined;

  async function bootstrap(responseContent: string | null): Promise<{ processor: AiExecuteProcessor; prisma: PrismaService; mockCreate: jest.Mock }> {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl_video_test",
      model: "gpt-4o-2024-08-06",
      choices: [{ message: { content: responseContent ?? "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 120, total_tokens: 150 },
    });
    const mockClient = { chat: { completions: { create } } } as unknown as OpenAI;
    const builder = new AIProviderRegistryBuilder();
    builder.register(new OpenAIProvider(mockClient, { provider: "openai", model: "gpt-4o", defaults: {} }));
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_PROVIDER_REGISTRY).useValue(builder.freeze()).compile();
    await moduleRef.init();
    return { processor: moduleRef.get(AiExecuteProcessor), prisma: moduleRef.get(PrismaService), mockCreate: create };
  }

  async function bootstrapDefaultRegistry(): Promise<{ processor: AiExecuteProcessor; prisma: PrismaService }> {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    return { processor: moduleRef.get(AiExecuteProcessor), prisma: moduleRef.get(PrismaService) };
  }

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined;
    }
  });

  async function seedWorkspace(p: PrismaService): Promise<{ userId: string; workspaceId: string }> {
    const suffix = randomUUID();
    const user = await p.user.create({ data: { email: `video-agent-test-${suffix}@example.invalid`, fullName: "Video Agent Test", status: "ACTIVE" } });
    const workspace = await p.$transaction(async (tx) => {
      const w = await tx.workspace.create({ data: { name: `Video Agent WS ${suffix}`, slug: `video-agent-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: w.id, slug: w.slug } });
      return w;
    });
    return { userId: user.id, workspaceId: workspace.id };
  }

  async function seedKnowledgePack(p: PrismaService, workspaceId: string, userId: string, status: "ACTIVE" | "DRAFT" = "ACTIVE"): Promise<string> {
    const id = randomUUID();
    await p.knowledgePack.create({
      data: { id, workspaceId, name: "Video Agent Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: {}, lineageRootId: id, status, createdById: userId },
    });
    return id;
  }

  async function seedAiJob(p: PrismaService, workspaceId: string, userId: string, knowledgePackId: string, agentName: string, input: Record<string, unknown>): Promise<AiJob> {
    return p.aiJob.create({
      data: { workspaceId, agentName, agentVersion: 1, triggeringModule: "worker-e2e-test", knowledgePackId, inputPayload: input as object, status: "QUEUED", correlationId: randomUUID(), createdById: userId },
    });
  }

  async function seedBackgroundJob(p: PrismaService): Promise<BackgroundJob> {
    const bj = await p.backgroundJob.create({
      data: { jobType: AI_EXECUTE_V1_MANIFEST.jobType, queueName: AI_EXECUTE_V1_MANIFEST.queue, payloadMetadata: {}, maxAttempts: AI_EXECUTE_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1, correlationId: randomUUID() },
    });
    await p.backgroundJobHistory.create({ data: { backgroundJobId: bj.id, toStatus: "QUEUED" } });
    return bj;
  }

  async function run(processor: AiExecuteProcessor, prisma: PrismaService, agentName: string, input: Record<string, unknown>, kpStatus: "ACTIVE" | "DRAFT" = "ACTIVE"): Promise<AiJob> {
    const { userId, workspaceId } = await seedWorkspace(prisma);
    const kpId = await seedKnowledgePack(prisma, workspaceId, userId, kpStatus);
    const job = await seedAiJob(prisma, workspaceId, userId, kpId, agentName, input);
    const bj = await seedBackgroundJob(prisma);
    await processor.handle({ aiJobPublicId: job.publicId }, { jobId: bj.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false }).catch(() => undefined);
    return prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
  }

  for (const c of CASES) {
    describe(c.agentName, () => {
      it("completes with the exact structured output persisted, provider/model/KP-version recorded", async () => {
        const { processor, prisma, mockCreate } = await bootstrap(JSON.stringify(c.validOutput));
        const finished = await run(processor, prisma, c.agentName, c.input);
        expect(finished.status).toBe("COMPLETED");
        expect(finished.providerUsed).toBe("openai");
        expect(finished.modelUsed).toContain("gpt-4o");
        expect(finished.agentVersion).toBe(1);
        expect(finished.outputPayload).toEqual(c.validOutput);
        expect(finished.knowledgePackId).toBeTruthy();
        expect(mockCreate).toHaveBeenCalledTimes(1);
      }, 30_000);

      it("fails safely (FAILED, no fabricated artifact) when the provider returns malformed output", async () => {
        const { processor, prisma } = await bootstrap('{"totally":"wrong shape"}');
        const finished = await run(processor, prisma, c.agentName, c.input);
        expect(finished.status).toBe("FAILED");
        expect(finished.outputPayload).toBeNull();
        expect(finished.errorCode).toBeTruthy();
      }, 30_000);

      it("preserves ADR-004: a non-ACTIVE Knowledge Pack fails the job with AI_JOB_KNOWLEDGE_PACK_NOT_ACTIVE", async () => {
        const { processor, prisma } = await bootstrap(JSON.stringify(c.validOutput));
        const finished = await run(processor, prisma, c.agentName, c.input, "DRAFT");
        expect(finished.status).toBe("FAILED");
        expect(finished.errorCode).toBe("AI_JOB_KNOWLEDGE_PACK_NOT_ACTIVE");
        expect(finished.outputPayload).toBeNull();
      }, 30_000);

      it("preserves provider-not-configured behaviour: FAILED with PROVIDER_NOT_CONFIGURED, no output, no endless polling", async () => {
        const { processor, prisma } = await bootstrapDefaultRegistry();
        const finished = await run(processor, prisma, c.agentName, c.input);
        expect(finished.status).toBe("FAILED");
        expect(finished.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
        expect(finished.outputPayload).toBeNull();
      }, 30_000);
    });
  }

  it("video-scene-planner-agent: postProcessOutput's D8 cross-check never fabricates/repairs a plan that leaves a script segment uncovered", async () => {
    // AgentDefinition's own framework contract (agent-executor.service.ts /
    // ai-execute.processor.ts, Module 4 Phase 4.2): a postProcessOutput
    // hook that throws NEVER fails the underlying job — the AI generation
    // itself already succeeded, so the job COMPLETES with the raw,
    // unprocessed output ("logs a warning, persists unprocessed output").
    // The scene planner's D8 cross-check therefore cannot reject a bad
    // plan at the raw ai_jobs level by design — VideoPipelineService's own
    // pipeline-level validateVideoScenePlan check (proven in
    // video-pipeline.e2e-spec.ts's "the versioned Scene Plan (D8) is
    // rejected..." test) is the actual, authoritative safety net. What
    // this test proves at the agent layer: the malformed plan is
    // persisted EXACTLY as the provider returned it — never silently
    // "fixed" into a false-complete plan.
    const incompletePlan = { ...SCENE_PLAN_OUTPUT, scenes: [SCENE_PLAN_OUTPUT.scenes[0]] }; // seg-2 never covered
    const { processor, prisma } = await bootstrap(JSON.stringify(incompletePlan));
    const finished = await run(processor, prisma, "video-scene-planner-agent", CASES.find((c) => c.agentName === "video-scene-planner-agent")!.input);
    expect(finished.status).toBe("COMPLETED");
    expect(finished.outputPayload).toEqual(incompletePlan);
  }, 30_000);

  it("the worker's real AgentRegistry resolves all six video agents at v1", async () => {
    const { processor } = await bootstrapDefaultRegistry();
    const prisma = moduleRef!.get(PrismaService);
    for (const c of CASES) {
      const finished = await run(processor, prisma, c.agentName, c.input);
      expect(finished.errorCode).not.toBe("AI_AGENT_NOT_FOUND");
      expect(finished.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
    }
  }, 60_000);
});
