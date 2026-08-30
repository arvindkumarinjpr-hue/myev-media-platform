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
 * Module 6 Phase 6.2 — proves each Blog pipeline agent (already
 * registered for real in this worker's own AgentRegistry) completes
 * through the UNMODIFIED durable ai.execute.v1 pipeline against a
 * production-style provider registry (a real OpenAIProvider wrapping a
 * jest-mocked SDK client — same pattern as research-agent.e2e-spec.ts),
 * that malformed provider output fails the job safely, and that the
 * frozen ADR-004 / provider-not-configured behaviours are preserved.
 */

process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM,AI";
process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";

const BRIEF_OUTPUT = {
  searchIntent: "informational",
  targetAudience: "New EV owners setting up home charging",
  primaryKeyword: "home ev charging",
  secondaryKeywords: ["level 2 charger"],
  ctaObjective: "Book a home charger installation assessment",
  rationale: "How-to question from pre-install buyers; informational intent with a soft conversion.",
};
const OUTLINE_OUTPUT = {
  h1: "The Complete Guide to Home EV Charging",
  sections: [
    { level: 2, heading: "Why charge at home", purpose: "cost + convenience case" },
    { level: 2, heading: "Choosing a charger", purpose: "pick a Level 2 unit" },
  ],
  faqPlan: ["How much does home charging cost?"],
};
const DRAFT_OUTPUT = {
  introduction: "Charging at home is the cheapest, most convenient way to keep an EV ready.",
  bodySections: [
    { level: 2, heading: "Why charge at home", content: "A home Level 2 setup costs less per mile than public charging." },
    { level: 2, heading: "Choosing a charger", content: "Look at amperage, cable length, and smart scheduling." },
  ],
  conclusion: "Home charging pays for itself within a year for most drivers.",
  cta: "Book a free home charger installation assessment.",
  faqs: [{ question: "How much does home charging cost?", answer: "A few hundred dollars to install plus your normal electricity rate." }],
};
const SEO_OUTPUT = {
  metaTitle: "Home EV Charging Guide: Costs & Setup",
  metaDescription: "Everything you need to charge your EV at home — Level 2 chargers, install costs, and utility rebates.",
  urlSlug: "home-ev-charging-guide",
  schemaMarkup: { "@type": "Article", headline: "The Complete Guide to Home EV Charging" },
};

interface AgentCase {
  agentName: string;
  input: Record<string, unknown>;
  validOutput: Record<string, unknown>;
}

const CASES: AgentCase[] = [
  { agentName: "blog-brief-agent", input: { topic: "Home EV charging" }, validOutput: BRIEF_OUTPUT },
  {
    agentName: "blog-outline-agent",
    input: { topic: "Home EV charging", searchIntent: "informational", targetAudience: "New EV owners", primaryKeyword: "home ev charging", secondaryKeywords: ["level 2 charger"], ctaObjective: "Book an assessment" },
    validOutput: OUTLINE_OUTPUT,
  },
  {
    agentName: "blog-draft-agent",
    input: {
      topic: "Home EV charging",
      h1: "The Complete Guide to Home EV Charging",
      sections: [{ level: 2, heading: "Why charge at home", purpose: "case" }],
      faqPlan: ["How much does home charging cost?"],
      primaryKeyword: "home ev charging",
      secondaryKeywords: ["level 2 charger"],
      targetAudience: "New EV owners",
      ctaObjective: "Book an assessment",
    },
    validOutput: DRAFT_OUTPUT,
  },
  {
    agentName: "seo-metadata-agent",
    input: { topic: "Home EV charging", title: "The Complete Guide to Home EV Charging", primaryKeyword: "home ev charging", secondaryKeywords: ["level 2 charger"], articleSummary: "How to set up and pay for home charging." },
    validOutput: SEO_OUTPUT,
  },
];

describe("Worker (e2e) — Blog pipeline agents against a production-style provider registry", () => {
  let moduleRef: TestingModule | undefined;

  async function bootstrap(responseContent: string | null): Promise<{ processor: AiExecuteProcessor; prisma: PrismaService; mockCreate: jest.Mock }> {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl_blog_test",
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
    // No provider override — this environment's real registry has "fake"
    // only, so an agent requesting "openai" hits PROVIDER_NOT_CONFIGURED.
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
    const user = await p.user.create({ data: { email: `blog-agent-test-${suffix}@example.invalid`, fullName: "Blog Agent Test", status: "ACTIVE" } });
    const workspace = await p.$transaction(async (tx) => {
      const w = await tx.workspace.create({ data: { name: `Blog Agent WS ${suffix}`, slug: `blog-agent-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: w.id, slug: w.slug } });
      return w;
    });
    return { userId: user.id, workspaceId: workspace.id };
  }

  async function seedKnowledgePack(p: PrismaService, workspaceId: string, userId: string, status: "ACTIVE" | "DRAFT" = "ACTIVE"): Promise<string> {
    const id = randomUUID();
    await p.knowledgePack.create({
      data: { id, workspaceId, name: "Blog Agent Test Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: {}, lineageRootId: id, status, createdById: userId },
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
        expect(finished.modelUsed).toContain("gpt-4o"); // provider records the response's actual model id
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

      it("preserves provider-not-configured behaviour: FAILED with PROVIDER_NOT_CONFIGURED, no output", async () => {
        const { processor, prisma } = await bootstrapDefaultRegistry();
        const finished = await run(processor, prisma, c.agentName, c.input);
        expect(finished.status).toBe("FAILED");
        expect(finished.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
        expect(finished.outputPayload).toBeNull();
      }, 30_000);
    });
  }

  it("the worker's real AgentRegistry resolves all four blog agents at v1", async () => {
    const { processor } = await bootstrapDefaultRegistry();
    // Indirect proof: an unknown agent fails with AI_AGENT_NOT_FOUND;
    // each blog agent instead reaches provider resolution (fails there,
    // in the default fake-only registry) — i.e. it WAS found.
    const prisma = moduleRef!.get(PrismaService);
    for (const c of CASES) {
      const finished = await run(processor, prisma, c.agentName, c.input);
      expect(finished.errorCode).not.toBe("AI_AGENT_NOT_FOUND");
      expect(finished.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
    }
  }, 60_000);
});
