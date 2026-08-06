import { Test, type TestingModule } from "@nestjs/testing";
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { SYSTEM_PING_V1_MANIFEST, type SystemPingResult } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";

/**
 * Module 1F Milestone 3 proof: the whole pipeline — BullMQ dispatch, the
 * frozen QueueRegistry's fail-fast bootstrap, the bound system.ping.v1
 * handler, and Worker Heartbeat reporting — working end-to-end against
 * real Redis and Postgres (the dev Docker Compose stack), no mocking.
 * This is deliberately the ONLY job type Module 1F itself owns; it is not
 * a business job and no future module may depend on it.
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
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } });
    await queueEvents.close();
    await queue.close();
    await moduleRef.close();
  });

  it("processes a system.ping.v1 job through the real Worker and returns the expected result", async () => {
    const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, { echo: "hello-e2e" });

    const result = (await job.waitUntilFinished(queueEvents, 10_000)) as SystemPingResult;

    expect(result.echo).toBe("hello-e2e");
    expect(new Date(result.respondedAt).toString()).not.toBe("Invalid Date");
  });

  it("defaults echo to 'pong' when no payload is given", async () => {
    const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, {});
    const result = (await job.waitUntilFinished(queueEvents, 10_000)) as SystemPingResult;
    expect(result.echo).toBe("pong");
  });

  it("rejects a job whose payload fails class-validator validation", async () => {
    const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, { echo: 12345 });
    await expect(job.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow();
  });

  it("reports a live WorkerHeartbeat row for this process", async () => {
    const row = await prisma.workerHeartbeat.findUnique({ where: { workerId: heartbeat.workerId } });
    expect(row).not.toBeNull();
    expect(row?.queueAssignments).toEqual(["SYSTEM"]);
    expect(row?.applicationVersion).toBe("e2e-test");
  });
});
