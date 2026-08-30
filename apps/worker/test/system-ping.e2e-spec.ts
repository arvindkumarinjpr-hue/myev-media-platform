import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { SYSTEM_PING_V1_MANIFEST, type SystemPingResult } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@myev/worker-core";
import { WorkerHeartbeatService } from "@myev/worker-core";
import type { BackgroundJob } from "../../api/generated/prisma";

/**
 * Module 1F Milestone 3/4 proof: the whole pipeline — BullMQ dispatch, the
 * frozen QueueRegistry's fail-fast bootstrap, the bound system.ping.v1
 * handler, real background_jobs lifecycle persistence, and Worker
 * Heartbeat reporting — working end-to-end against real Redis and
 * Postgres (the dev Docker Compose stack), no mocking. This is
 * deliberately the ONLY job type Module 1F itself owns; it is not a
 * business job and no future module may depend on it.
 *
 * A BullMQ job's `id` IS the background_jobs row's internal `id` in
 * production (set by apps/api's BackgroundJobsService.enqueue) — this
 * suite constructs that row directly via Prisma (the Worker process has
 * no enqueue-side API of its own) to exercise the real correlation
 * mechanism, not a synthetic BullMQ-only id no row would ever match.
 */
describe("Worker (e2e) — system.ping.v1 end-to-end pipeline", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "2000";

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let heartbeat: WorkerHeartbeatService;
  let queue: Queue;
  let queueEvents: QueueEvents;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // .init() runs the same onModuleInit/onApplicationBootstrap lifecycle
    // NestFactory.createApplicationContext() runs in production — this is
    // the real bootstrap path (fail-fast registry validation included),
    // not a stub.
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    heartbeat = moduleRef.get(WorkerHeartbeatService);

    const connection = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    queue = new Queue(SYSTEM_PING_V1_MANIFEST.queue, { connection });
    queueEvents = new QueueEvents(SYSTEM_PING_V1_MANIFEST.queue, { connection: connection.duplicate() });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    await prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: createdJobIds } } });
    await prisma.backgroundJob.deleteMany({ where: { id: { in: createdJobIds } } });
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } });
    await queueEvents.close();
    await queue.close();
    await moduleRef.close();
  });

  async function createQueuedJobRow(): Promise<BackgroundJob> {
    const row = await prisma.backgroundJob.create({
      data: {
        jobType: SYSTEM_PING_V1_MANIFEST.jobType,
        queueName: SYSTEM_PING_V1_MANIFEST.queue,
        correlationId: randomUUID(),
      },
    });
    createdJobIds.push(row.id);
    return row;
  }

  it("processes a system.ping.v1 job through the real Worker, persists lifecycle, and returns the expected result", async () => {
    const row = await createQueuedJobRow();
    const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, { echo: "hello-e2e" }, { jobId: row.id });

    const result = (await job.waitUntilFinished(queueEvents, 10_000)) as SystemPingResult;

    expect(result.echo).toBe("hello-e2e");
    expect(new Date(result.respondedAt).toString()).not.toBe("Invalid Date");

    const updated = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.attempts).toBe(1);
    expect(updated.startedAt).not.toBeNull();
    expect(updated.completedAt).not.toBeNull();
    // Not a hardcoded literal: the CI workflow's own e2e job sets
    // WORKER_APPLICATION_VERSION to "ci-e2e" (distinct from this
    // describe block's own "e2e-test" fallback, which only applies when
    // nothing else has already set it) — asserting against whatever
    // value is actually configured proves the same end-to-end
    // propagation regardless of which environment set it.
    expect(updated.processorVersion).toBe(process.env.WORKER_APPLICATION_VERSION);

    const history = await prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: row.id }, orderBy: { occurredAt: "asc" } });
    expect(history.map((h) => h.toStatus)).toEqual(["RUNNING", "COMPLETED"]);
  });

  it("defaults echo to 'pong' when no payload is given", async () => {
    const row = await createQueuedJobRow();
    const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, {}, { jobId: row.id });
    const result = (await job.waitUntilFinished(queueEvents, 10_000)) as SystemPingResult;
    expect(result.echo).toBe("pong");
  });

  it("rejects a job whose payload fails class-validator validation, and marks the row FAILED", async () => {
    const row = await createQueuedJobRow();
    const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, { echo: 12345 }, { jobId: row.id });
    await expect(job.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow();

    const updated = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.errorCode).toBe("PAYLOAD_VALIDATION_FAILED");
  });

  it("cooperative cancellation: a job that observes isCancelled() mid-flight ends CANCELLED, not COMPLETED", async () => {
    const row = await createQueuedJobRow();
    const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, { echo: "cancel-me", delayMs: 1_500 }, { jobId: row.id });

    // Give the Worker a moment to pick the job up and transition it to
    // RUNNING before requesting cancellation — this proves the checker
    // is a live, per-call DB read, not a value captured once at pickup.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await prisma.backgroundJob.update({ where: { id: row.id }, data: { cancellationRequestedAt: new Date() } });

    await expect(job.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow();

    const updated = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.errorCode).toBe("JOB_CANCELLED_BY_USER");
    expect(updated.cancelledAt).not.toBeNull();
  });

  it("reports a live WorkerHeartbeat row for this process", async () => {
    const row = await prisma.workerHeartbeat.findUnique({ where: { workerId: heartbeat.workerId } });
    expect(row).not.toBeNull();
    // Module 3 Phase 3.3: asserts the actually-configured value, not a
    // literal that only happened to match before WORKER_QUEUES gained a
    // second category (AI) — same principle as the applicationVersion
    // assertion right below, now applied consistently to this one too.
    expect(row?.queueAssignments).toEqual((process.env.WORKER_QUEUES as string).split(","));
    expect(row?.applicationVersion).toBe(process.env.WORKER_APPLICATION_VERSION);
  });
});
