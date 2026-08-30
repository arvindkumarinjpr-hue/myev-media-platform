import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { AI_EXECUTE_V1_MANIFEST } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@myev/worker-core";
import { AiExecuteProcessor } from "../src/queue/processors/ai-execute.processor";
import type { AiJob, BackgroundJob } from "../../api/generated/prisma";

/**
 * Module 3 Phase 3.3 — proves the durable AI execution pipeline against
 * real Postgres + Redis + BullMQ, mirroring system-ping.e2e-spec.ts's
 * own precedent exactly (this worker process has no enqueue-side API of
 * its own, so background_jobs/ai_jobs rows and the real Workspace/User/
 * KnowledgePack fixtures they require are all created directly via
 * Prisma, then a real BullMQ job is pushed with jobId = the
 * background_jobs row's own id, matching production's own convention).
 *
 * Happy-path and permanent-failure go through the REAL bootstrapped
 * QueueRegistry/BullMqWorkerManager end-to-end (both complete without
 * waiting through a real retry backoff — permanent failure dead-letters
 * on attempt 1, no wait). Retry-then-succeed, timeout, and idempotent-
 * redelivery are proven via direct, repeated calls to the REAL
 * DI-resolved AiExecuteProcessor.handle() instead: BullMQ's own retry
 * *scheduling* (the backoff delay itself) is already extensively proven
 * by the existing retry-dead-letter.e2e-spec.ts suite (Part 21 of this
 * phase's own spec: "do not recreate the entire DEFECT-1F-006 test
 * suite") — what THIS suite needs to prove is that this processor's own
 * classification/persistence/idempotency logic is correct, which direct
 * invocation proves deterministically and fast.
 */
describe("Worker (e2e) — ai.execute.v1 durable AI execution", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM,AI";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let processor: AiExecuteProcessor;
  let queue: Queue;
  let queueEvents: QueueEvents;
  const createdBackgroundJobIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    processor = moduleRef.get(AiExecuteProcessor);

    const connection = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    queue = new Queue(AI_EXECUTE_V1_MANIFEST.queue, { connection });
    queueEvents = new QueueEvents(AI_EXECUTE_V1_MANIFEST.queue, { connection });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    await queueEvents.close();
    await queue.close();
    await moduleRef.close();
  });

  async function createTestWorkspace(): Promise<{ userId: string; workspaceId: string }> {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { email: `ai-execute-test-${suffix}@example.invalid`, fullName: "AI Execute Test User", status: "ACTIVE" },
    });
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: { name: `AI Execute Test Workspace ${suffix}`, slug: `ai-execute-test-${suffix}`, ownerId: user.id, createdById: user.id },
      });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { userId: user.id, workspaceId: workspace.id };
  }

  async function createActiveKnowledgePack(workspaceId: string, userId: string): Promise<string> {
    const id = randomUUID();
    const pack = await prisma.knowledgePack.create({
      data: {
        id,
        workspaceId,
        name: "AI Execute Test Pack",
        industryProfile: {},
        publishingStrategy: {},
        lineageRootId: id,
        status: "ACTIVE",
        createdById: userId,
      },
    });
    return pack.id;
  }

  async function createAiJob(workspaceId: string, userId: string, knowledgePackId: string, agentName: string, agentVersion = 1): Promise<AiJob> {
    return prisma.aiJob.create({
      data: {
        workspaceId,
        agentName,
        agentVersion,
        triggeringModule: "worker-e2e-test",
        knowledgePackId,
        inputPayload: { message: "hello from worker e2e" },
        status: "QUEUED",
        correlationId: randomUUID(),
        createdById: userId,
      },
    });
  }

  // A real background_jobs row, matching production's own shape
  // (AiJobSubmissionService.submit creates one identically) — required
  // even for a direct .handle() invocation that never touches BullMQ:
  // the processor's own atomic-claim step writes context.jobId onto
  // AiJob.backgroundJobId, a real FK, so it must reference an existing
  // row, never an arbitrary id.
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
    createdBackgroundJobIds.push(backgroundJob.id);
    return backgroundJob;
  }

  async function dispatchAndWait(aiJobPublicId: string): Promise<BackgroundJob> {
    const backgroundJob = await prisma.backgroundJob.create({
      data: {
        jobType: AI_EXECUTE_V1_MANIFEST.jobType,
        queueName: AI_EXECUTE_V1_MANIFEST.queue,
        payloadMetadata: { aiJobPublicId },
        maxAttempts: AI_EXECUTE_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1,
        correlationId: randomUUID(),
      },
    });
    await prisma.backgroundJobHistory.create({ data: { backgroundJobId: backgroundJob.id, toStatus: "QUEUED" } });
    createdBackgroundJobIds.push(backgroundJob.id);

    await queue.add(AI_EXECUTE_V1_MANIFEST.jobType, { aiJobPublicId }, { jobId: backgroundJob.id });
    await queueEvents.waitUntilReady();

    const deadline = Date.now() + 20_000;
    let row = backgroundJob;
    while (Date.now() < deadline) {
      row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: backgroundJob.id } });
      if (["COMPLETED", "FAILED", "TIMED_OUT"].includes(row.status)) return row;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`background job ${backgroundJob.id} did not reach a terminal status within the deadline — last seen: ${row.status}`);
  }

  it("executes a QUEUED AiJob end-to-end through real BullMQ dispatch and marks it COMPLETED", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId, "test-echo-agent");

    const bgJob = await dispatchAndWait(job.publicId);
    expect(bgJob.status).toBe("COMPLETED");

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("COMPLETED");
    expect(finished.providerUsed).toBe("fake");
    expect(finished.backgroundJobId).toBe(bgJob.id);
    expect(finished.outputPayload).toMatchObject({ echo: "test-echo-agent-default-response" });

    const steps = await prisma.aiJobStep.findMany({ where: { aiJobId: job.id } });
    const stepNames = steps.map((s) => `${s.stepName}:${s.stepStatus}`).sort();
    expect(stepNames).toEqual(["knowledge_pack_resolution:COMPLETED", "provider_execution:COMPLETED"]);
  }, 30_000);

  it("dead-letters a permanent provider failure immediately — terminal FAILED, no retry wait", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId, "test-permanent-fail-agent");

    const bgJob = await dispatchAndWait(job.publicId);
    expect(bgJob.status).toBe("FAILED");
    expect(bgJob.attempts).toBe(1);

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("FAILED");
    expect(finished.errorCode).toBe("INVALID_REQUEST");
    expect(finished.errorMessageSafe).toBeTruthy();
  }, 30_000);

  it("processes an unknown AiJob reference as a permanent condition, not a retry", async () => {
    const bogusPublicId = randomUUID();
    const bgJob = await dispatchAndWait(bogusPublicId);
    expect(bgJob.status).toBe("FAILED");
    expect(bgJob.attempts).toBe(1);
    expect(bgJob.errorCode).toBe("AI_JOB_NOT_FOUND");
  }, 30_000);

  it("direct invocation: transient failure then eventual success reuses the SAME AiJob — no duplicate rows, retry state never looks like a false permanent failure", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId, "test-flaky-agent");
    const backgroundJob = await createBackgroundJobRow();

    const ctx = (attempt: number) => ({ jobId: backgroundJob.id, correlationId: job.correlationId, attempt, isCancelled: async () => false });

    // Attempt 1 — fake-flaky's own failuresBeforeSuccess=1 means this
    // one transient failure, then success from attempt 2 onward.
    await expect(processor.handle({ aiJobPublicId: job.publicId }, ctx(1))).rejects.toThrow();
    const afterAttempt1 = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    // QUEUED, never a terminal status — a caller polling GET must never
    // see a false permanent failure while a retry is still pending.
    expect(afterAttempt1.status).toBe("QUEUED");
    expect(afterAttempt1.errorCode).toBe("TRANSIENT_NETWORK");

    const beforeCount = await prisma.aiJob.count({ where: { workspaceId } });

    // Attempt 2 — same AiJob identity, same correlationId — succeeds.
    const result = await processor.handle({ aiJobPublicId: job.publicId }, ctx(2));
    expect(result.aiJobPublicId).toBe(job.publicId);

    const afterCount = await prisma.aiJob.count({ where: { workspaceId } });
    expect(afterCount).toBe(beforeCount); // no duplicate AiJob created by the retry

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("COMPLETED");
  }, 30_000);

  it("direct invocation: a provider timeout on the final attempt maps to the exact TIMED_OUT status, not FAILED", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId, "test-timeout-agent");
    const backgroundJob = await createBackgroundJobRow();

    // TEST_TIMEOUT_AGENT_V1's own executionPolicy is inert metadata here
    // (Phase 3.2's own documented design) — the JOB TYPE's manifest-level
    // retry policy is what actually governs attempt counting
    // (AI_EXECUTE_V1_MANIFEST.defaultRetryPolicy.maxAttempts). Presenting
    // an attempt number already at that ceiling exercises the terminal
    // branch deterministically without waiting through real intermediate
    // BullMQ backoff delays.
    const maxAttempts = AI_EXECUTE_V1_MANIFEST.defaultRetryPolicy?.maxAttempts ?? 1;
    await expect(
      processor.handle({ aiJobPublicId: job.publicId }, { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: maxAttempts, isCancelled: async () => false }),
    ).rejects.toThrow();

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("TIMED_OUT");
    expect(finished.errorCode).toBe("TIMEOUT");
  }, 30_000);

  it("direct invocation: a redelivered execution of an already-COMPLETED AiJob is a safe no-op, never a second execution", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId, "test-echo-agent");
    const backgroundJob = await createBackgroundJobRow();
    const ctx = { jobId: backgroundJob.id, correlationId: job.correlationId, attempt: 1, isCancelled: async () => false };

    await processor.handle({ aiJobPublicId: job.publicId }, ctx);
    const afterFirst = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterFirst.status).toBe("COMPLETED");
    const completedAtFirst = afterFirst.completedAt?.getTime();

    // A second, redelivered execution attempt (crash-recovery re-drive,
    // or a duplicate BullMQ delivery) against the identical AiJob.
    const secondResult = await processor.handle({ aiJobPublicId: job.publicId }, { ...ctx, attempt: 2 });
    expect(secondResult.aiJobPublicId).toBe(job.publicId);

    const afterSecond = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterSecond.status).toBe("COMPLETED");
    expect(afterSecond.completedAt?.getTime()).toBe(completedAtFirst); // untouched — no re-execution happened

    const steps = await prisma.aiJobStep.findMany({ where: { aiJobId: job.id, stepName: "provider_execution" } });
    expect(steps).toHaveLength(1); // only the first, real execution ever recorded a step
  }, 30_000);

  it("rejects an AiJob referencing an unregistered agent as permanent — no retry attempted", async () => {
    const { userId, workspaceId } = await createTestWorkspace();
    const knowledgePackId = await createActiveKnowledgePack(workspaceId, userId);
    const job = await createAiJob(workspaceId, userId, knowledgePackId, "nonexistent-agent");

    const bgJob = await dispatchAndWait(job.publicId);
    expect(bgJob.status).toBe("FAILED");
    expect(bgJob.attempts).toBe(1);

    const finished = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe("FAILED");
    expect(finished.errorCode).toBe("AI_AGENT_NOT_FOUND");
  }, 30_000);
});
