import "reflect-metadata";
import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Queue, type Worker } from "bullmq";
import Redis from "ioredis";
import {
  EventPublisher,
  EventRegistryBuilder,
  PermanentProcessorError,
  QueueRegistryBuilder,
  deriveEventConsumerJobType,
  deriveExternalIdempotencyKey,
  deriveProcessorManifestFromEventConsumerManifest,
  EventConsumerJobEnvelopeDto,
  type CategoryAConsumerDeps,
  type CategoryAExecute,
  type CategoryBConsumerDeps,
  type CategoryBExecute,
  type DomainEventWriter,
  type EventConsumerExecutionOutcome,
  type EventConsumerJobEnvelope,
  type EventConsumerManifest,
  type EventRegistry,
  type ProcessorContext,
  type QueueRegistry,
} from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
import { OutboxRelayManager } from "../src/events/outbox-relay.manager";
import { BullMqWorkerManager } from "../src/bullmq/bullmq-worker.manager";
import { EVENT_REGISTRY } from "../src/events/events.module";
import { QUEUE_REGISTRY } from "../src/queue/queue-registry.module";
import {
  PrismaAdvisoryLockAcquirer,
  PrismaProcessedEventReaderWriter,
  PrismaProcessedEventStore,
  PrismaTransactionRunner,
} from "../src/events/prisma-event-consumer-adapters";
import { createExternalEffectEventConsumerHandler, createTransactionalEventConsumerHandler } from "../src/events/event-consumer-executor";
import { Prisma, type DomainEvent } from "../../api/generated/prisma";

/**
 * Milestone 8.3 Phase 4 — proves the complete event-consumer execution
 * path (DomainEvent -> OutboxRelayManager -> BackgroundJob -> BullMQ ->
 * BullMqWorkerManager -> event-consumer executor -> authoritative
 * DomainEvent reload -> execution-time validation -> Category A/B
 * runtime -> ProcessedEvent -> BackgroundJob COMPLETED/FAILED) against
 * real Postgres + real Redis + real BullMQ, no mocking. Registers its
 * OWN test-local EventRegistry AND QueueRegistry via NestJS's standard
 * overrideProvider — never the production EventsModule/QueueRegistryModule,
 * which stay exactly as Milestone 8.1's own frozen Option-A decision
 * requires (no production EventConsumerManifest exists yet anywhere).
 */

class CategoryATestPayload {
  @IsString()
  note!: string;

  // Milestone 5's own failUntilAttempt convention, reused verbatim —
  // proves the EXISTING retry engine's behavior is unaffected by this
  // consumer running through the new Phase 4 executor.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  failUntilAttempt?: number;

  @IsOptional()
  @IsBoolean()
  throwPermanent?: boolean;
}

class CategoryBTestPayload {
  @IsString()
  note!: string;
}

const CATEGORY_A_EVENT_TYPE = "event-consumer-test.category-a-happened.v1";
const CATEGORY_A_CONSUMER_NAME = "event-consumer-test-category-a";
const CATEGORY_B_EVENT_TYPE = "event-consumer-test.category-b-happened.v1";
const CATEGORY_B_CONSUMER_NAME = "event-consumer-test-category-b";
const BUSINESS_TABLE = "event_consumer_test_business_writes";

function categoryAManifest(overrides: Partial<EventConsumerManifest> = {}): EventConsumerManifest {
  return {
    eventType: CATEGORY_A_EVENT_TYPE,
    schemaVersion: 1,
    eventContractVersion: 1,
    consumerName: CATEGORY_A_CONSUMER_NAME,
    producer: "event-consumer-execution-test",
    owningModule: "event-consumer-execution-test",
    status: "active",
    queue: "SYSTEM",
    payloadDto: CategoryATestPayload,
    idempotent: true,
    cancelable: false,
    supportsRetry: true,
    defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 2_000 },
    timeout: 5_000,
    maximumRuntime: 30_000,
    description: "Milestone 8.3 Phase 4 test-local fixture consumer (Category A) — never registered in a production EventsModule.",
    ...overrides,
  } as EventConsumerManifest;
}

function categoryBManifest(overrides: Partial<EventConsumerManifest> = {}): EventConsumerManifest {
  return {
    eventType: CATEGORY_B_EVENT_TYPE,
    schemaVersion: 1,
    eventContractVersion: 1,
    consumerName: CATEGORY_B_CONSUMER_NAME,
    producer: "event-consumer-execution-test",
    owningModule: "event-consumer-execution-test",
    status: "active",
    queue: "SYSTEM",
    payloadDto: CategoryBTestPayload,
    idempotent: true,
    cancelable: false,
    supportsRetry: true,
    defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 2_000 },
    timeout: 5_000,
    maximumRuntime: 30_000,
    description: "Milestone 8.3 Phase 4 test-local fixture consumer (Category B) — never registered in a production EventsModule.",
    ...overrides,
  } as EventConsumerManifest;
}

// Category A business callback — a REAL, transaction-observable Postgres
// write (an ephemeral, test-only table created/dropped entirely within
// this file's own lifecycle — never a tracked migration, never fake
// production schema), so atomicity with ProcessedEvent can be proven
// against real Postgres, not asserted by inspection alone.
const categoryAExecute: CategoryAExecute<Prisma.TransactionClient, { wrote: boolean }> = async (tx, domainEvent, context) => {
  const payload = domainEvent.payload as CategoryATestPayload;
  if (payload.throwPermanent) {
    throw new PermanentProcessorError("SIMULATED_CATEGORY_A_PERMANENT_FAILURE", "Simulated permanent consumer failure for testing.");
  }
  if (payload.failUntilAttempt && context.attempt < payload.failUntilAttempt) {
    throw new Error("Simulated transient consumer failure for testing.");
  }
  await tx.$executeRaw`INSERT INTO ${Prisma.raw(BUSINESS_TABLE)} (domain_event_id, consumer_name, note) VALUES (${domainEvent.id}::uuid, ${CATEGORY_A_CONSUMER_NAME}, ${payload.note})`;
  return { wrote: true };
};

// Category B in-process external-effect test double — no real network
// dependency. Records every call's idempotency key so tests can prove it
// is stable and deterministic.
class CategoryBTestDouble {
  calls: { idempotencyKey: string; note: string }[] = [];
  shouldThrow = false;

  reset(): void {
    this.calls = [];
    this.shouldThrow = false;
  }
}
const categoryBTestDouble = new CategoryBTestDouble();

// Explicitly, per Milestone 8.3's frozen Category B contract: this test
// double IS idempotent (safe to call twice with the same key), but
// infrastructure itself does NOT guarantee exactly-once delivery of the
// external effect — only that ProcessedEvent, once created, prevents any
// FURTHER call for the same (domainEventId, consumerName). A real
// external system that does not honor the passed idempotency key would
// make this consumer's delivery semantics explicitly AT-LEAST-ONCE.
const categoryBExecute: CategoryBExecute<{ delivered: boolean }> = async (domainEvent, _context, externalIdempotencyKey) => {
  const payload = domainEvent.payload as CategoryBTestPayload;
  if (categoryBTestDouble.shouldThrow) {
    throw new Error("Simulated external effect failure for testing.");
  }
  categoryBTestDouble.calls.push({ idempotencyKey: externalIdempotencyKey, note: payload.note });
  return { delivered: true };
};

function toWriter(delegate: Prisma.TransactionClient["domainEvent"]): DomainEventWriter {
  return {
    create: (args) =>
      delegate.create({
        data: { ...args.data, payload: args.data.payload as unknown as Prisma.InputJsonValue },
      }),
  };
}

async function publishEvent(prisma: PrismaService, eventType: string, payload: object): Promise<DomainEvent> {
  const publisher = new EventPublisher();
  return prisma.$transaction(async (tx) => {
    const writer = toWriter(tx.domainEvent);
    return publisher.publish(writer, { eventType, payload }) as unknown as Promise<DomainEvent>;
  });
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function testEnvelope(
  domainEventId: string,
  eventType: string,
  eventVersion: number,
  consumerName: string,
  workspaceId: string | null = null,
  correlationId: string | null = null,
  causationId: string | null = null,
): EventConsumerJobEnvelope {
  return { domainEventId, eventType, eventVersion, consumerName, workspaceId, correlationId, causationId };
}

function testContext(jobId: string, attempt = 1): ProcessorContext {
  return { jobId, correlationId: randomUUID(), attempt, isCancelled: async () => false };
}

function buildEventRegistry(): EventRegistry {
  const builder = new EventRegistryBuilder();
  builder.registerManifest(categoryAManifest());
  builder.registerManifest(categoryBManifest());
  return builder.freeze();
}

function buildQueueRegistry(prisma: PrismaService): QueueRegistry {
  const builder = new QueueRegistryBuilder();

  const categoryA = categoryAManifest();
  const categoryAProcessorManifest = deriveProcessorManifestFromEventConsumerManifest(categoryA);
  builder.registerManifest(categoryAProcessorManifest);
  const categoryADeps: CategoryAConsumerDeps<Prisma.TransactionClient> = {
    transactionRunner: new PrismaTransactionRunner(prisma),
    advisoryLockAcquirer: new PrismaAdvisoryLockAcquirer(),
    processedEventReaderWriter: new PrismaProcessedEventReaderWriter(),
  };
  builder.bindHandler(categoryAProcessorManifest.jobType, createTransactionalEventConsumerHandler(categoryA, prisma, categoryADeps, categoryAExecute));

  const categoryB = categoryBManifest();
  const categoryBProcessorManifest = deriveProcessorManifestFromEventConsumerManifest(categoryB);
  builder.registerManifest(categoryBProcessorManifest);
  const categoryBDeps: CategoryBConsumerDeps = { processedEventStore: new PrismaProcessedEventStore(prisma) };
  builder.bindHandler(categoryBProcessorManifest.jobType, createExternalEffectEventConsumerHandler(categoryB, prisma, categoryBDeps, categoryBExecute));

  return builder.freeze({ requireHandlersForQueues: ["SYSTEM"] });
}

interface ClaimedRow {
  id: string;
  eventType: string;
  eventVersion: number;
  workspaceId: string | null;
  correlationId: string | null;
  causationId: string | null;
  payload: unknown;
  claimToken: string;
  claimExpiresAt: Date;
}
type ConsumerDispatchOutcome = "dispatched" | "permanent-failure" | "transient-failure";
interface OutboxRelayInternals {
  claimUndispatchedEvents: () => Promise<ClaimedRow[]>;
  dispatchToConsumer: (row: ClaimedRow, manifest: EventConsumerManifest, correlationId: string) => Promise<ConsumerDispatchOutcome>;
}
interface BullMqWorkerManagerInternals {
  workers: Worker[];
}

describe("Worker (e2e) — Milestone 8.3 Phase 4 event consumer execution", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "2000";
  process.env.OUTBOX_RELAY_INTERVAL_MS = process.env.OUTBOX_RELAY_INTERVAL_MS ?? "3600000";

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let heartbeat: WorkerHeartbeatService;
  const trackedEventIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EVENT_REGISTRY)
      .useValue(buildEventRegistry())
      .overrideProvider(QUEUE_REGISTRY)
      .useFactory({ factory: (p: PrismaService) => buildQueueRegistry(p), inject: [PrismaService] })
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    heartbeat = moduleRef.get(WorkerHeartbeatService);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS ${BUSINESS_TABLE} (id BIGSERIAL PRIMARY KEY, domain_event_id UUID NOT NULL, consumer_name TEXT NOT NULL, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
  });

  afterEach(async () => {
    categoryBTestDouble.reset();
    for (const domainEventId of trackedEventIds.splice(0)) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const jobs = await prisma.backgroundJob.findMany({ where: { idempotencyKey: { startsWith: `event:${domainEventId}:` } }, select: { id: true } });
          const jobIds = jobs.map((j) => j.id);
          if (jobIds.length > 0) {
            await prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: jobIds } } });
            await prisma.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
          }
          await prisma.processedEvent.deleteMany({ where: { eventId: domainEventId } });
          await prisma.$executeRawUnsafe(`DELETE FROM ${BUSINESS_TABLE} WHERE domain_event_id = $1::uuid`, domainEventId);
          break;
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2003" || attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      await prisma.domainEvent.deleteMany({ where: { id: domainEventId } }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${BUSINESS_TABLE}`);
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } }).catch(() => undefined);
    await moduleRef.close();
  });

  async function publishTracked(eventType: string, payload: object): Promise<DomainEvent> {
    const row = await publishEvent(prisma, eventType, payload);
    trackedEventIds.push(row.id);
    return row;
  }

  describe("manifest / registry consistency", () => {
    it("the derived ProcessorManifest and the frozen QueueRegistry agree on jobType, queue, timeout, retry policy, and payloadDto = EventConsumerJobEnvelopeDto", () => {
      const manifest = categoryAManifest();
      const derived = deriveProcessorManifestFromEventConsumerManifest(manifest);
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const registered = queueRegistry.getManifest(derived.jobType);

      expect(derived.jobType).toBe(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1));
      expect(registered).toBeDefined();
      expect(registered?.queue).toBe(manifest.queue);
      expect(registered?.timeout).toBe(manifest.timeout);
      expect(registered?.defaultRetryPolicy).toEqual(manifest.defaultRetryPolicy);
      expect(registered?.payloadDto).toBe(EventConsumerJobEnvelopeDto);
      expect(queueRegistry.getHandler(derived.jobType)).toBeDefined();
    });
  });

  describe("happy path", () => {
    it("full pipeline: DomainEvent -> OutboxRelayManager -> BackgroundJob -> BullMQ -> BullMqWorkerManager -> executor -> Category A runtime -> ProcessedEvent -> COMPLETED", async () => {
      const outboxManager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
      const bullMqManager = moduleRef.get(BullMqWorkerManager) as unknown as BullMqWorkerManagerInternals;
      const systemWorker = bullMqManager.workers.find((w) => w.name === "SYSTEM")!;
      expect(systemWorker).toBeDefined();

      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "happy-path" });
      const claimed = await outboxManager.claimUndispatchedEvents();
      const row = claimed.find((r) => r.id === event.id)!;
      expect(row).toBeDefined();

      await systemWorker.pause();
      const outcome = await outboxManager.dispatchToConsumer(row, categoryAManifest(), randomUUID());
      expect(outcome).toBe("dispatched");

      const job = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:${CATEGORY_A_CONSUMER_NAME}` } });
      expect(job).not.toBeNull();
      expect(job!.payloadMetadata).not.toHaveProperty("note");
      expect((job!.payloadMetadata as unknown as EventConsumerJobEnvelope).domainEventId).toBe(event.id);

      const verifyConnection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const verifyQueue = new Queue("SYSTEM", { connection: verifyConnection });
      try {
        const bullJob = await verifyQueue.getJob(job!.id);
        expect(bullJob?.data).toEqual(job!.payloadMetadata);

        await systemWorker.resume();
        await waitUntil(async () => {
          const j = await prisma.backgroundJob.findUnique({ where: { id: job!.id } });
          return j?.status === "COMPLETED";
        }, 15_000);
      } finally {
        await verifyQueue.close().catch(() => undefined);
        verifyConnection.disconnect();
      }

      const finalJob = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job!.id } });
      expect(finalJob.status).toBe("COMPLETED");
      expect(finalJob.errorCode).toBeNull();

      const history = await prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: job!.id }, orderBy: { occurredAt: "asc" } });
      expect(history.map((h) => `${h.fromStatus ?? "CREATED"}->${h.toStatus}`)).toEqual(["CREATED->QUEUED", "QUEUED->RUNNING", "RUNNING->COMPLETED"]);

      const processed = await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_A_CONSUMER_NAME } });
      expect(processed).toHaveLength(1);

      const businessRows = await prisma.$queryRawUnsafe<{ note: string }[]>(`SELECT note FROM ${BUSINESS_TABLE} WHERE domain_event_id = $1::uuid`, event.id);
      expect(businessRows).toHaveLength(1);
      expect(businessRows[0].note).toBe("happy-path");
    }, 30_000);
  });

  describe("idempotent redelivery", () => {
    it("redelivering the same event-consumer job reaches ALREADY_PROCESSED, does not repeat the business effect, and ProcessedEvent count stays 1", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "redelivery-proof" });
      const envelope = testEnvelope(event.id, CATEGORY_A_EVENT_TYPE, 1, CATEGORY_A_CONSUMER_NAME);

      const first = (await handler(envelope, testContext("redelivery-1"))) as EventConsumerExecutionOutcome<unknown>;
      expect(first.outcome).toBe("EXECUTED");

      const second = (await handler(envelope, testContext("redelivery-2"))) as EventConsumerExecutionOutcome<unknown>;
      expect(second.outcome).toBe("ALREADY_PROCESSED");

      const businessRows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${BUSINESS_TABLE} WHERE domain_event_id = $1::uuid`, event.id);
      expect(businessRows).toHaveLength(1);

      const processed = await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_A_CONSUMER_NAME } });
      expect(processed).toHaveLength(1);
    }, 15_000);
  });

  describe("concurrent duplicate execution", () => {
    it("two simultaneous attempts for the same (domainEventId, consumerName): exactly one business execution, the other observes ProcessedEvent after acquiring the advisory lock", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "concurrent-proof" });
      const envelope = testEnvelope(event.id, CATEGORY_A_EVENT_TYPE, 1, CATEGORY_A_CONSUMER_NAME);

      const [result1, result2] = await Promise.all([
        handler(envelope, testContext("concurrent-1")),
        handler(envelope, testContext("concurrent-2")),
      ]);
      const outcomes = [result1, result2].map((r) => (r as EventConsumerExecutionOutcome<unknown>).outcome).sort();
      expect(outcomes).toEqual(["ALREADY_PROCESSED", "EXECUTED"]);

      const businessRows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${BUSINESS_TABLE} WHERE domain_event_id = $1::uuid`, event.id);
      expect(businessRows).toHaveLength(1); // exactly one business execution, not merely one surviving ProcessedEvent row

      const processed = await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_A_CONSUMER_NAME } });
      expect(processed).toHaveLength(1);
    }, 15_000);

    it("same event, different consumers: independent execution, no cross-consumer lock contention", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handlerA = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "cross-consumer" });
      const envelopeA = testEnvelope(event.id, CATEGORY_A_EVENT_TYPE, 1, CATEGORY_A_CONSUMER_NAME);

      // A second, differently-named consumer manifest for the SAME
      // eventType, bound to its own handler sharing the same business
      // table — proves the advisory lock's second key component
      // (hashtext(consumerName)) makes this independent of the first
      // consumer's own lock, not serialized behind it.
      const otherConsumerName = "event-consumer-test-category-a-sibling";
      const otherManifest = categoryAManifest({ consumerName: otherConsumerName });
      const otherDeps: CategoryAConsumerDeps<Prisma.TransactionClient> = {
        transactionRunner: new PrismaTransactionRunner(prisma),
        advisoryLockAcquirer: new PrismaAdvisoryLockAcquirer(),
        processedEventReaderWriter: new PrismaProcessedEventReaderWriter(),
      };
      const handlerB = createTransactionalEventConsumerHandler(otherManifest, prisma, otherDeps, categoryAExecute);
      const envelopeB = testEnvelope(event.id, CATEGORY_A_EVENT_TYPE, 1, otherConsumerName);

      const [resultA, resultB] = await Promise.all([handlerA(envelopeA, testContext("cross-a")), handlerB(envelopeB, testContext("cross-b"))]);
      expect((resultA as EventConsumerExecutionOutcome<unknown>).outcome).toBe("EXECUTED");
      expect((resultB as EventConsumerExecutionOutcome<unknown>).outcome).toBe("EXECUTED");

      const processedA = await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_A_CONSUMER_NAME } });
      const processedB = await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: otherConsumerName } });
      expect(processedA).toHaveLength(1);
      expect(processedB).toHaveLength(1);

      const businessRows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${BUSINESS_TABLE} WHERE domain_event_id = $1::uuid`, event.id);
      expect(businessRows).toHaveLength(2); // both consumers' own business writes present
    }, 15_000);
  });

  describe("transient failure then retry", () => {
    it("a normal Error on first execution is scheduled for automatic retry by the existing, unmodified engine; succeeds on the retried attempt; exactly one ProcessedEvent", async () => {
      const outboxManager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "transient-retry", failUntilAttempt: 2 });
      const claimed = await outboxManager.claimUndispatchedEvents();
      const row = claimed.find((r) => r.id === event.id)!;
      const outcome = await outboxManager.dispatchToConsumer(row, categoryAManifest(), randomUUID());
      expect(outcome).toBe("dispatched");

      const job = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:${CATEGORY_A_CONSUMER_NAME}` } });
      await waitUntil(async () => {
        const j = await prisma.backgroundJob.findUnique({ where: { id: job!.id } });
        return j?.status === "QUEUED" && j.attempts === 1;
      }, 15_000);

      const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const queue = new Queue("SYSTEM", { connection });
      try {
        const retryJob = await queue.getJob(`${job!.id}#retry1`);
        expect(retryJob).toBeDefined();
        await retryJob?.promote();
        await waitUntil(async () => {
          const j = await prisma.backgroundJob.findUnique({ where: { id: job!.id } });
          return j?.status === "COMPLETED";
        }, 15_000);
      } finally {
        await queue.close().catch(() => undefined);
        connection.disconnect();
      }

      const finalJob = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job!.id } });
      expect(finalJob.status).toBe("COMPLETED");
      expect(finalJob.attempts).toBe(2);
      expect(finalJob.errorCode).toBeNull();

      const history = await prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: job!.id }, orderBy: { occurredAt: "asc" } });
      expect(history.map((h) => `${h.fromStatus ?? "CREATED"}->${h.toStatus}`)).toEqual([
        "CREATED->QUEUED",
        "QUEUED->RUNNING",
        "RUNNING->QUEUED",
        "QUEUED->RUNNING",
        "RUNNING->COMPLETED",
      ]);

      const processed = await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_A_CONSUMER_NAME } });
      expect(processed).toHaveLength(1);
    }, 20_000);
  });

  describe("permanent consumer failure", () => {
    it("PermanentProcessorError thrown by the consumer dead-letters immediately via the existing Phase 2 branch — no retry BullMQ job, no ProcessedEvent, correct safe errorCode", async () => {
      const outboxManager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "permanent-failure", throwPermanent: true });
      const claimed = await outboxManager.claimUndispatchedEvents();
      const row = claimed.find((r) => r.id === event.id)!;
      const outcome = await outboxManager.dispatchToConsumer(row, categoryAManifest(), randomUUID());
      expect(outcome).toBe("dispatched");

      const job = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:${CATEGORY_A_CONSUMER_NAME}` } });
      await waitUntil(async () => {
        const j = await prisma.backgroundJob.findUnique({ where: { id: job!.id } });
        return j?.status === "FAILED";
      }, 15_000);

      const finalJob = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job!.id } });
      expect(finalJob.status).toBe("FAILED");
      expect(finalJob.attempts).toBe(1);
      expect(finalJob.errorCode).toBe("SIMULATED_CATEGORY_A_PERMANENT_FAILURE");
      expect(finalJob.deadLetteredAt).not.toBeNull();

      const history = await prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: job!.id }, orderBy: { occurredAt: "asc" } });
      expect(history.map((h) => `${h.fromStatus ?? "CREATED"}->${h.toStatus}`)).toEqual(["CREATED->QUEUED", "QUEUED->RUNNING", "RUNNING->FAILED"]);

      const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const queue = new Queue("SYSTEM", { connection });
      try {
        expect(await queue.getJob(`${job!.id}#retry1`)).toBeUndefined();
      } finally {
        await queue.close().catch(() => undefined);
        connection.disconnect();
      }

      const processed = await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_A_CONSUMER_NAME } });
      expect(processed).toHaveLength(0);

      const businessRows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${BUSINESS_TABLE} WHERE domain_event_id = $1::uuid`, event.id);
      expect(businessRows).toHaveLength(0);
    }, 15_000);
  });

  describe("envelope / domain event mismatch", () => {
    it("wrong domainEventId -> PermanentProcessorError DOMAIN_EVENT_NOT_FOUND, no ProcessedEvent", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1))!;
      const bogusId = randomUUID();
      const envelope = testEnvelope(bogusId, CATEGORY_A_EVENT_TYPE, 1, CATEGORY_A_CONSUMER_NAME);

      const error = await handler(envelope, testContext("mismatch-1")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermanentProcessorError);
      expect((error as PermanentProcessorError).errorCode).toBe("DOMAIN_EVENT_NOT_FOUND");

      expect(await prisma.processedEvent.findMany({ where: { eventId: bogusId } })).toHaveLength(0);
    }, 10_000);

    it("wrong eventType -> PermanentProcessorError EVENT_ENVELOPE_MISMATCH, no business callback, no ProcessedEvent", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "wrong-eventType" });
      const envelope = testEnvelope(event.id, "outbox.unrelated-event.v1", 1, CATEGORY_A_CONSUMER_NAME);

      const error = await handler(envelope, testContext("mismatch-2")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermanentProcessorError);
      expect((error as PermanentProcessorError).errorCode).toBe("EVENT_ENVELOPE_MISMATCH");

      const businessRows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${BUSINESS_TABLE} WHERE domain_event_id = $1::uuid`, event.id);
      expect(businessRows).toHaveLength(0);
      expect(await prisma.processedEvent.findMany({ where: { eventId: event.id } })).toHaveLength(0);
    }, 10_000);

    it("wrong eventVersion -> PermanentProcessorError EVENT_ENVELOPE_MISMATCH, no business callback, no ProcessedEvent", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "wrong-eventVersion" });
      const envelope = testEnvelope(event.id, CATEGORY_A_EVENT_TYPE, 2, CATEGORY_A_CONSUMER_NAME);

      const error = await handler(envelope, testContext("mismatch-3")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermanentProcessorError);
      expect((error as PermanentProcessorError).errorCode).toBe("EVENT_ENVELOPE_MISMATCH");

      expect(await prisma.processedEvent.findMany({ where: { eventId: event.id } })).toHaveLength(0);
    }, 10_000);

    it("wrong consumerName -> PermanentProcessorError EVENT_ENVELOPE_MISMATCH, no business callback, no ProcessedEvent", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "wrong-consumerName" });
      const envelope = testEnvelope(event.id, CATEGORY_A_EVENT_TYPE, 1, "some-other-consumer-entirely");

      const error = await handler(envelope, testContext("mismatch-4")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermanentProcessorError);
      expect((error as PermanentProcessorError).errorCode).toBe("EVENT_ENVELOPE_MISMATCH");

      expect(await prisma.processedEvent.findMany({ where: { eventId: event.id } })).toHaveLength(0);
    }, 10_000);
  });

  describe("execution-time payload revalidation", () => {
    it("queued envelope never contains the business payload (payloadMetadata is envelope-shaped only)", async () => {
      const outboxManager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
      const event = await publishTracked(CATEGORY_A_EVENT_TYPE, { note: "no-business-payload-in-envelope" });
      const claimed = await outboxManager.claimUndispatchedEvents();
      const row = claimed.find((r) => r.id === event.id)!;
      await outboxManager.dispatchToConsumer(row, categoryAManifest(), randomUUID());

      const job = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:${CATEGORY_A_CONSUMER_NAME}` } });
      expect(job!.payloadMetadata).not.toHaveProperty("note");
      expect(job!.payloadMetadata).toMatchObject({ domainEventId: event.id, eventType: CATEGORY_A_EVENT_TYPE, consumerName: CATEGORY_A_CONSUMER_NAME });
    }, 10_000);

    it("a stale/malformed DomainEvent.payload (bypassing relay-time validation entirely) fails permanently at execution time, never invoking the consumer", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_A_CONSUMER_NAME, 1))!;
      // Directly inserted, bypassing EventPublisher/OutboxRelayManager's
      // own relay-time validation — simulates a consumer's payloadDto
      // changing after this row was already durably stored, or any other
      // historical/version-mismatch scenario execution-time revalidation
      // exists specifically to catch.
      const event = await prisma.domainEvent.create({ data: { eventType: CATEGORY_A_EVENT_TYPE, eventVersion: 1, payload: { wrongShape: true } } });
      trackedEventIds.push(event.id);
      const envelope = testEnvelope(event.id, CATEGORY_A_EVENT_TYPE, 1, CATEGORY_A_CONSUMER_NAME);

      const error = await handler(envelope, testContext("malformed-payload")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PermanentProcessorError);
      expect((error as PermanentProcessorError).errorCode).toBe("PAYLOAD_VALIDATION_FAILED");

      const businessRows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${BUSINESS_TABLE} WHERE domain_event_id = $1::uuid`, event.id);
      expect(businessRows).toHaveLength(0);
    }, 10_000);
  });

  describe("Category B external-effect consumer", () => {
    it("first delivery invokes the external effect with the deterministic domainEventId:consumerName idempotency key and creates ProcessedEvent", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_B_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_B_EVENT_TYPE, { note: "category-b-first" });
      const envelope = testEnvelope(event.id, CATEGORY_B_EVENT_TYPE, 1, CATEGORY_B_CONSUMER_NAME);

      const outcome = (await handler(envelope, testContext("category-b-1"))) as EventConsumerExecutionOutcome<unknown>;
      expect(outcome.outcome).toBe("EXECUTED");
      expect(categoryBTestDouble.calls).toHaveLength(1);
      expect(categoryBTestDouble.calls[0].idempotencyKey).toBe(deriveExternalIdempotencyKey(event.id, CATEGORY_B_CONSUMER_NAME));
      expect(categoryBTestDouble.calls[0].idempotencyKey).toBe(`${event.id}:${CATEGORY_B_CONSUMER_NAME}`);

      expect(await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_B_CONSUMER_NAME } })).toHaveLength(1);
    }, 10_000);

    it("redelivery skips the external effect once already processed — same idempotency key would be reused if the effect ran again", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_B_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_B_EVENT_TYPE, { note: "category-b-redelivery" });
      const envelope = testEnvelope(event.id, CATEGORY_B_EVENT_TYPE, 1, CATEGORY_B_CONSUMER_NAME);

      await handler(envelope, testContext("category-b-2a"));
      expect(categoryBTestDouble.calls).toHaveLength(1);

      const second = (await handler(envelope, testContext("category-b-2b"))) as EventConsumerExecutionOutcome<unknown>;
      expect(second.outcome).toBe("ALREADY_PROCESSED");
      expect(categoryBTestDouble.calls).toHaveLength(1); // the external effect was never invoked a second time

      expect(await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_B_CONSUMER_NAME } })).toHaveLength(1);
    }, 10_000);

    it("an external-effect failure prevents ProcessedEvent from being created", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_B_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_B_EVENT_TYPE, { note: "category-b-failure" });
      const envelope = testEnvelope(event.id, CATEGORY_B_EVENT_TYPE, 1, CATEGORY_B_CONSUMER_NAME);

      categoryBTestDouble.shouldThrow = true;
      const error = await handler(envelope, testContext("category-b-3")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);

      expect(await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_B_CONSUMER_NAME } })).toHaveLength(0);
    }, 10_000);

    it("no transaction context is passed to the Category B callback — the wired deps expose only a ProcessedEventStore, never a TransactionRunner", () => {
      const deps: CategoryBConsumerDeps = { processedEventStore: new PrismaProcessedEventStore(prisma) };
      expect(Object.keys(deps)).toEqual(["processedEventStore"]);
      expect("transactionRunner" in deps).toBe(false);
      expect("advisoryLockAcquirer" in deps).toBe(false);
    });

    /**
     * Milestone 8.3 Phase 5 M3 — Category B's own frozen contract
     * (event-consumer-runtime.ts's own doc comment) explicitly documents
     * "a race here is possible and accepted" under concurrent delivery of
     * the same (domainEventId, consumerName), unlike Category A's
     * advisory-lock-serialized exclusivity (proven separately, above,
     * under the "concurrent duplicate execution" describe block). This
     * proves that documented AT-LEAST-ONCE behavior against real
     * concurrency for the first time — not a stronger, invented
     * exactly-once requirement. `find`/`create` race against real
     * Postgres with no lock: multiple concurrent callers may each see
     * `find` -> null and invoke the external effect before any of them
     * commits `create`; ProcessedEvent's own unique constraint
     * (eventId, consumerName) then admits exactly one of those `create`
     * calls, surfacing a Postgres unique-constraint violation
     * (Prisma P2002) to every other caller whose `create` lost the race —
     * an expected, analyzable consequence of the accepted race, not an
     * undocumented failure mode. In production that rejection is an
     * ordinary thrown error from the caller's own ProcessorHandler,
     * which BullMqWorkerManager.process()'s existing, unmodified retry
     * path already treats as transient and retries — on that retry,
     * `find` correctly observes the now-durable ProcessedEvent and
     * returns ALREADY_PROCESSED, so the system already self-heals via
     * the pre-existing generic retry engine without any lock in Category
     * B. No production code is touched by this test.
     */
    it("concurrent delivery (20 simultaneous attempts): deterministic idempotency key on every execution, AT-LEAST-ONCE external-effect semantics, exactly one durable ProcessedEvent, and a clean post-race ALREADY_PROCESSED", async () => {
      const queueRegistry = moduleRef.get<QueueRegistry>(QUEUE_REGISTRY);
      const handler = queueRegistry.getHandler(deriveEventConsumerJobType(CATEGORY_B_CONSUMER_NAME, 1))!;
      const event = await publishTracked(CATEGORY_B_EVENT_TYPE, { note: "category-b-concurrency" });
      const envelope = testEnvelope(event.id, CATEGORY_B_EVENT_TYPE, 1, CATEGORY_B_CONSUMER_NAME);

      // Reconfirmed inline for this specific race, not merely assumed
      // from the sibling test above.
      const deps: CategoryBConsumerDeps = { processedEventStore: new PrismaProcessedEventStore(prisma) };
      expect("transactionRunner" in deps).toBe(false);

      const CONCURRENCY = 20;
      const attempts = Array.from({ length: CONCURRENCY }, (_, i) => handler(envelope, testContext(`concurrency-${i}`)));
      const settled = await Promise.allSettled(attempts);

      const executed = settled.filter((r) => r.status === "fulfilled" && (r.value as EventConsumerExecutionOutcome<unknown>).outcome === "EXECUTED");
      const alreadyProcessed = settled.filter((r) => r.status === "fulfilled" && (r.value as EventConsumerExecutionOutcome<unknown>).outcome === "ALREADY_PROCESSED");
      const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      // Every settled outcome must be one of these three known shapes.
      // Anything else would be exactly the "undocumented exception class
      // escaping normal Category B execution" this test exists to rule out.
      expect(executed.length + alreadyProcessed.length + rejected.length).toBe(CONCURRENCY);

      // Every rejection must be the specific, known Postgres
      // unique-constraint violation on ProcessedEvent's own
      // (eventId, consumerName) constraint — the frozen contract's own
      // documented consequence of the accepted race. Nothing else may
      // surface here.
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((r.reason as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
      }

      // The unique constraint guarantees exactly one caller's create()
      // can ever succeed — deterministic regardless of how many
      // concurrent callers raced past find().
      expect(executed).toHaveLength(1);

      // AT-LEAST-ONCE, not exactly-once, by design: the frozen contract's
      // essential requirement is more than one external-effect
      // invocation under a genuine race — not a specific fixed count.
      // No upper bound is asserted either: this test must not fail
      // merely because the external effect fired more than once.
      expect(categoryBTestDouble.calls.length).toBeGreaterThan(1);

      // Deterministic identity: every external-effect invocation that
      // occurred received the identical, correctly-derived idempotency
      // key — never a per-attempt or random variant.
      const expectedKey = deriveExternalIdempotencyKey(event.id, CATEGORY_B_CONSUMER_NAME);
      for (const call of categoryBTestDouble.calls) {
        expect(call.idempotencyKey).toBe(expectedKey);
      }

      const processed = await prisma.processedEvent.findMany({ where: { eventId: event.id, consumerName: CATEGORY_B_CONSUMER_NAME } });
      expect(processed).toHaveLength(1);

      // Post-race delivery: the race has fully settled — a further
      // delivery must be clean, not another race.
      const callsBeforePostRace = categoryBTestDouble.calls.length;
      const postRace = (await handler(envelope, testContext("concurrency-post-race"))) as EventConsumerExecutionOutcome<unknown>;
      expect(postRace.outcome).toBe("ALREADY_PROCESSED");
      expect(categoryBTestDouble.calls.length).toBe(callsBeforePostRace);
    }, 20_000);
  });
});
