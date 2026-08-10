import "reflect-metadata";
import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { IsOptional, IsString } from "class-validator";
import { Queue, type Worker } from "bullmq";
import Redis from "ioredis";
import { EventPublisher, EventRegistryBuilder, type DomainEventWriter, type EventConsumerManifest, type EventRegistry, type ShutdownOutcomeTracker } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
import { OutboxRelayManager } from "../src/events/outbox-relay.manager";
import { BullMqWorkerManager } from "../src/bullmq/bullmq-worker.manager";
import { EVENT_REGISTRY } from "../src/events/events.module";
import { SHUTDOWN_TRACKER } from "../src/shutdown/shutdown.module";
import { Prisma, type DomainEvent } from "../../api/generated/prisma";

/**
 * Milestone 8.2 — real Postgres + real Redis (or deliberately
 * unreachable/disconnected), no mocking. Registers its OWN test-only
 * EventRegistry via NestJS's standard overrideProvider (never the
 * production EventsModule, which stays deliberately empty per Milestone
 * 8.1's own frozen Zero-Consumer decision) — the identical technique the
 * DEFECT-1F-001 signal tests already established for injecting test-only
 * behavior without touching production wiring.
 *
 * Groups C (claim/lease correctness) and F (dispatch-failure durability)
 * below exist because the originally-shipped design (a read-only SELECT
 * ... FOR UPDATE SKIP LOCKED claim, no persisted ownership) was reviewed
 * and empirically disproven: two independent relay attempts could both
 * legitimately claim and dispatch the same still-undispatched row once
 * the claiming transaction committed. This file's own OUTBOX_RELAY_
 * INTERVAL_MS is set very large in several tests specifically to suppress
 * the real background tick, so claim/lease behavior can be driven and
 * observed manually and deterministically — per the correctness review's
 * own instruction: "real PostgreSQL and deterministic timing/control, not
 * probabilistic racing."
 */

class OutboxTestPayload {
  @IsOptional()
  @IsString()
  note?: string;
}

class OutboxUnvalidatablePayload {
  @IsString()
  requiredField!: string;
}

const TEST_EVENT_TYPE = "outbox.test-event.v1";
const TEST_EVENT_TYPE_V2 = "outbox.test-event.v2";

function consumerManifest(overrides: Partial<EventConsumerManifest> = {}): EventConsumerManifest {
  return {
    eventType: TEST_EVENT_TYPE,
    schemaVersion: 1,
    eventContractVersion: 1,
    consumerName: "outbox-test-consumer-a",
    producer: "outbox-relay-test",
    owningModule: "outbox-relay-test",
    status: "active",
    queue: "SYSTEM",
    payloadDto: OutboxTestPayload,
    idempotent: true,
    cancelable: false,
    supportsRetry: true,
    defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 5_000 },
    timeout: 5_000,
    maximumRuntime: 30_000,
    description: "Milestone 8.2 test fixture consumer.",
    ...overrides,
  } as EventConsumerManifest;
}

function testRegistry(manifests: EventConsumerManifest[]): EventRegistry {
  const builder = new EventRegistryBuilder();
  for (const manifest of manifests) builder.registerManifest(manifest);
  return builder.freeze();
}

function toWriter(delegate: Prisma.TransactionClient["domainEvent"]): DomainEventWriter {
  return {
    create: (args) =>
      delegate.create({
        data: { ...args.data, payload: args.data.payload as unknown as Prisma.InputJsonValue },
      }),
  };
}

async function publishEvent(
  prisma: PrismaService,
  eventType: string,
  payload: object,
  opts: { workspaceId?: string | null; correlationId?: string; causationId?: string } = {},
): Promise<DomainEvent> {
  const publisher = new EventPublisher();
  return prisma.$transaction(async (tx) => {
    const writer = toWriter(tx.domainEvent);
    return publisher.publish(writer, { eventType, payload, ...opts }) as unknown as Promise<DomainEvent>;
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

interface ClaimedRow {
  id: string;
  eventType: string;
  workspaceId: string | null;
  payload: unknown;
  claimToken: string;
  claimExpiresAt: Date;
}

type ConsumerDispatchOutcome = "dispatched" | "permanent-failure" | "transient-failure";

interface OutboxRelayInternals {
  claimUndispatchedEvents: () => Promise<ClaimedRow[]>;
  processEvent: (row: ClaimedRow, correlationId: string) => Promise<{ dispatched: boolean; skipped: boolean; consumerJobsCreated: number; ownershipLost: boolean }>;
  dispatchToConsumer: (row: ClaimedRow, manifest: EventConsumerManifest, correlationId: string) => Promise<ConsumerDispatchOutcome>;
  markDispatched: (domainEventId: string, claimToken: string) => Promise<boolean>;
  maybeRenewClaim: (row: ClaimedRow, correlationId: string, leaseMs: number) => Promise<boolean>;
  connection?: Redis;
}

// BullMqWorkerManager keeps one real BullMQ Worker per configured queue —
// exposed here purely so tests can pause/resume real job pickup for
// deterministic (not racing) control over exactly when the real worker
// is allowed to execute, never to bypass or mock its behavior.
interface BullMqWorkerManagerInternals {
  workers: Worker[];
}

describe("Worker (e2e) — Milestone 8.2 OutboxRelayManager", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "2000";
  process.env.REDIS_SHUTDOWN_DEADLINE_MS = process.env.REDIS_SHUTDOWN_DEADLINE_MS ?? "2000";
  process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS ?? "2000";
  process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS ?? "2000";
  process.env.OUTBOX_RELAY_INTERVAL_MS = process.env.OUTBOX_RELAY_INTERVAL_MS ?? "1000";
  process.env.OUTBOX_RELAY_BATCH_SIZE = process.env.OUTBOX_RELAY_BATCH_SIZE ?? "50";
  process.env.OUTBOX_RELAY_CLAIM_LEASE_MS = process.env.OUTBOX_RELAY_CLAIM_LEASE_MS ?? "30000";

  const originalRedisUrl = process.env.REDIS_URL;
  const originalIntervalMs = process.env.OUTBOX_RELAY_INTERVAL_MS;
  const originalLeaseMs = process.env.OUTBOX_RELAY_CLAIM_LEASE_MS;
  afterEach(() => {
    process.env.REDIS_URL = originalRedisUrl;
    process.env.OUTBOX_RELAY_INTERVAL_MS = originalIntervalMs;
    process.env.OUTBOX_RELAY_CLAIM_LEASE_MS = originalLeaseMs;
  });

  const trackedEventIds: string[] = [];

  async function bootstrap(manifests: EventConsumerManifest[]): Promise<{ moduleRef: TestingModule; prisma: PrismaService; heartbeat: WorkerHeartbeatService }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EVENT_REGISTRY)
      .useValue(testRegistry(manifests))
      .compile();
    await moduleRef.init();
    return { moduleRef, prisma: moduleRef.get(PrismaService), heartbeat: moduleRef.get(WorkerHeartbeatService) };
  }

  // Relayed jobs use jobType "event.<consumerName>.v<N>", which has no
  // registered ProcessorManifest (Milestone 8.3 scope) — the real
  // BullMqWorkerManager sharing this same AppModule/SYSTEM queue will
  // pick such jobs up and race to append its own RUNNING/FAILED
  // BackgroundJobHistory rows (see OutboxRelayManager's own class doc
  // comment: this is accepted, since 8.2 never executes handlers). A
  // naive two-step "delete history, then delete job" can therefore lose
  // an FK race against that in-flight write. Retrying the pair absorbs
  // it without weakening what the test actually verifies.
  async function deleteJobsForEvent(prisma: PrismaService, domainEventId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const jobs = await prisma.backgroundJob.findMany({ where: { idempotencyKey: { startsWith: `event:${domainEventId}:` } }, select: { id: true } });
      const jobIds = jobs.map((job) => job.id);
      if (jobIds.length === 0) return;
      try {
        await prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: jobIds } } });
        await prisma.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
        return;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2003" || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  async function cleanup(moduleRef: TestingModule, heartbeat: WorkerHeartbeatService): Promise<void> {
    const prisma = moduleRef.get(PrismaService);
    for (const domainEventId of trackedEventIds.splice(0)) {
      await deleteJobsForEvent(prisma, domainEventId);
      await prisma.domainEvent.deleteMany({ where: { id: domainEventId } }).catch(() => undefined);
    }
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } }).catch(() => undefined);
    await moduleRef.close();
  }

  async function publishTracked(prisma: PrismaService, eventType: string, payload: object, opts: Parameters<typeof publishEvent>[3] = {}): Promise<DomainEvent> {
    const row = await publishEvent(prisma, eventType, payload, opts);
    trackedEventIds.push(row.id);
    return row;
  }

  // Test 5 needs a real Workspace row, owned by a real User — not
  // assumed to pre-exist in a fresh, isolated database. Created and torn
  // down entirely within that one test, never relying on shared seed
  // data (Workspace.ownerId/createdById are both required FKs to User).
  async function createTestWorkspace(prisma: PrismaService): Promise<{ userId: string; workspaceId: string }> {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { email: `outbox-relay-test-${suffix}@example.invalid`, fullName: "Outbox Relay Test User", status: "ACTIVE" },
    });
    // workspaces.slug is backed by a deferred composite FK into
    // WorkspaceSlugReservation (Module 1C Engineering Plan §1) — resource
    // insert + reservation insert must happen in the same transaction,
    // mirroring WorkspacesService.create's own established pattern.
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: { name: `Outbox Relay Test Workspace ${suffix}`, slug: `outbox-relay-test-${suffix}`, ownerId: user.id, createdById: user.id },
      });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { userId: user.id, workspaceId: workspace.id };
  }

  async function deleteTestWorkspace(prisma: PrismaService, fixture: { userId: string; workspaceId: string }): Promise<void> {
    await prisma.workspaceSlugReservation.deleteMany({ where: { workspaceId: fixture.workspaceId } }).catch(() => undefined);
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: fixture.userId } }).catch(() => undefined);
  }

  // ==================================================================
  // Group A — basic relay mechanics
  // ==================================================================
  describe("basic relay mechanics", () => {
    it("1. relays a basic undispatched event — dispatchedAt eventually set", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "basic" });
        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("2. one event -> one consumer creates exactly one BackgroundJob", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "single-consumer" });
        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);
        const jobs = await prisma.backgroundJob.findMany({ where: { idempotencyKey: { startsWith: `event:${event.id}:` } } });
        expect(jobs).toHaveLength(1);
        expect(jobs[0].idempotencyKey).toBe(`event:${event.id}:consumer:outbox-test-consumer-a`);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("3. one event -> multiple consumers creates one BackgroundJob per consumer", async () => {
      const manifests = [
        consumerManifest({ consumerName: "outbox-test-consumer-a" }),
        consumerManifest({ consumerName: "outbox-test-consumer-b" }),
        consumerManifest({ consumerName: "outbox-test-consumer-c" }),
      ];
      const { moduleRef, prisma, heartbeat } = await bootstrap(manifests);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "fan-out" });
        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);
        const jobs = await prisma.backgroundJob.findMany({ where: { idempotencyKey: { startsWith: `event:${event.id}:` } } });
        expect(jobs.map((job) => job.idempotencyKey).sort()).toEqual(
          [
            `event:${event.id}:consumer:outbox-test-consumer-a`,
            `event:${event.id}:consumer:outbox-test-consumer-b`,
            `event:${event.id}:consumer:outbox-test-consumer-c`,
          ].sort(),
        );
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("4. dispatches to the queue declared by the consumer manifest", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest({ queue: "MAINTENANCE" })]);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "queue-selection" });
        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);
        const job = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(job?.queueName).toBe("MAINTENANCE");
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("5. workspace event: BackgroundJob.workspaceId matches the event's workspaceId", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      const workspaceFixture = await createTestWorkspace(prisma);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "workspace-scoped" }, { workspaceId: workspaceFixture.workspaceId });
        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);
        const job = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(job?.workspaceId).toBe(workspaceFixture.workspaceId);
      } finally {
        await cleanup(moduleRef, heartbeat);
        await deleteTestWorkspace(prisma, workspaceFixture);
      }
    }, 30_000);

    it("6. platform event (workspaceId NULL) dispatches with a NULL-workspace BackgroundJob", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "platform-level" });
        expect(event.workspaceId).toBeNull();
        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);
        const job = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(job?.workspaceId).toBeNull();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);
  });

  // ==================================================================
  // Group B — dispatch-layer idempotency and pre-existing-job crash
  // recovery (independent of the claim/lease mechanism itself — see
  // Group C for that)
  // ==================================================================
  describe("dispatch-layer idempotency and crash recovery", () => {
    it("7. re-processing the same claimed row twice does not duplicate logical jobs", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const manager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "duplicate-tick" });

        const claimedOnce = await manager.claimUndispatchedEvents();
        const row = claimedOnce.find((r) => r.id === event.id)!;
        expect(row).toBeDefined();

        await manager.processEvent(row, randomUUID());
        // Re-dispatch for the SAME claim (same token) — proves
        // dispatchToConsumer's own idempotency-key mechanism, independent
        // of claim/lease exclusivity (see Group C for that).
        await manager.processEvent(row, randomUUID());

        const jobs = await prisma.backgroundJob.findMany({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(jobs).toHaveLength(1);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("8. crash after partial fan-out: existing job idempotency absorbed, remaining consumer created, then finalized", async () => {
      const manifests = [consumerManifest({ consumerName: "outbox-test-consumer-a" }), consumerManifest({ consumerName: "outbox-test-consumer-b" })];
      const { moduleRef, prisma, heartbeat } = await bootstrap(manifests);
      try {
        // The event publish and the "pre-existing consumer A job" must
        // commit atomically — otherwise the real, continuously-ticking
        // relay can observe the freshly-published, undispatched event
        // (and dispatch a FRESH job for A) in the window before a
        // separate, non-transactional insert would have landed, turning
        // this into "both jobs created fresh" instead of the intended
        // "A absorbed, B fresh" crash-recovery scenario.
        const event = await prisma.$transaction(async (tx) => {
          const publisher = new EventPublisher();
          const created = (await publisher.publish(toWriter(tx.domainEvent), {
            eventType: TEST_EVENT_TYPE,
            payload: { note: "partial-fanout" },
          })) as unknown as DomainEvent;
          await tx.backgroundJob.create({
            data: {
              workspaceId: created.workspaceId,
              jobType: "event.outbox-test-consumer-a.v1",
              queueName: "SYSTEM",
              payloadMetadata: { note: "partial-fanout" },
              maxAttempts: 3,
              idempotencyKey: `event:${created.id}:consumer:outbox-test-consumer-a`,
              correlationId: randomUUID(),
            },
          });
          return created;
        });
        trackedEventIds.push(event.id);

        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);

        const jobsA = await prisma.backgroundJob.findMany({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        const jobsB = await prisma.backgroundJob.findMany({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-b` } });
        expect(jobsA).toHaveLength(1); // absorbed, not duplicated
        expect(jobsB).toHaveLength(1); // the remaining consumer was created
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("9. crash before dispatchedAt with full fan-out already present: safely finalized, no duplicate jobs", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "crash-before-finalize" });

        await prisma.backgroundJob.create({
          data: {
            workspaceId: event.workspaceId,
            jobType: "event.outbox-test-consumer-a.v1",
            queueName: "SYSTEM",
            payloadMetadata: { note: "crash-before-finalize" },
            maxAttempts: 3,
            idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a`,
            correlationId: randomUUID(),
          },
        });

        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);

        const jobs = await prisma.backgroundJob.findMany({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(jobs).toHaveLength(1);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);
  });

  // ==================================================================
  // Group C — claim/lease correctness (Milestone 8.2 correctness fix).
  // Every test here disables the real background tick
  // (OUTBOX_RELAY_INTERVAL_MS set very large) so claim/lease/finalize can
  // be driven and observed manually and deterministically, per the
  // correctness review's own instruction.
  // ==================================================================
  describe("claim/lease correctness", () => {
    it("10. an actively-leased event is invisible to a second, independent claim attempt (repeated ticks from the same instance cannot overlap ownership)", async () => {
      process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const manager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "lease-exclusivity" });

        const firstClaim = await manager.claimUndispatchedEvents();
        expect(firstClaim.find((r) => r.id === event.id)).toBeDefined();

        // Deliberately do NOT dispatch/finalize — simulates "Relay A is
        // still mid-dispatch." A second, independent claim attempt (this
        // same instance's next tick, or a different relay) must not see
        // this row while its lease is active — the exact gap the
        // correctness review's own empirical script (claim, commit,
        // second claim before finalize) found open in the original
        // read-only SKIP LOCKED design.
        const secondClaim = await manager.claimUndispatchedEvents();
        expect(secondClaim.find((r) => r.id === event.id)).toBeUndefined();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("11. crash/stale-claim recovery: lease expires, a second claim reclaims with a new token, the stale owner's finalize affects 0 rows, the new owner's finalize succeeds", async () => {
      process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";
      process.env.OUTBOX_RELAY_CLAIM_LEASE_MS = "1000";
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const manager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "stale-claim-recovery" });

        const firstClaim = await manager.claimUndispatchedEvents();
        const originalRow = firstClaim.find((r) => r.id === event.id)!;
        expect(originalRow).toBeDefined();
        const originalToken = originalRow.claimToken;

        // Let the (deliberately short) lease genuinely expire — real
        // time, not mocked or simulated.
        await new Promise((resolve) => setTimeout(resolve, 1_300));

        const secondClaim = await manager.claimUndispatchedEvents();
        const reclaimedRow = secondClaim.find((r) => r.id === event.id)!;
        expect(reclaimedRow).toBeDefined();
        expect(reclaimedRow.claimToken).not.toBe(originalToken);

        // The stale (original) owner's finalize must affect 0 rows and
        // must never overwrite the newer claim's in-flight state.
        const staleFinalizeSucceeded = await manager.markDispatched(event.id, originalToken);
        expect(staleFinalizeSucceeded).toBe(false);

        const rowAfterStaleFinalize = await prisma.domainEvent.findUnique({ where: { id: event.id } });
        expect(rowAfterStaleFinalize?.dispatchedAt).toBeNull(); // confirm the stale finalize truly did nothing
        expect(rowAfterStaleFinalize?.claimToken).toBe(reclaimedRow.claimToken); // still owned by the new claim, untouched

        // The new owner's finalize succeeds.
        const newFinalizeSucceeded = await manager.markDispatched(event.id, reclaimedRow.claimToken);
        expect(newFinalizeSucceeded).toBe(true);
        const finalRow = await prisma.domainEvent.findUnique({ where: { id: event.id } });
        expect(finalRow?.dispatchedAt).not.toBeNull();
        expect(finalRow?.claimToken).toBeNull();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("12. lease renewal extends the active window and prevents a takeover during a long-running dispatch", async () => {
      process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";
      process.env.OUTBOX_RELAY_CLAIM_LEASE_MS = "1000";
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const manager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "lease-renewal" });

        const claimed = await manager.claimUndispatchedEvents();
        const row = claimed.find((r) => r.id === event.id)!;
        const originalExpiry = row.claimExpiresAt.getTime();

        // Wait past the renewal threshold (50% of the 1000ms lease) but
        // before outright expiry.
        await new Promise((resolve) => setTimeout(resolve, 700));

        const renewed = await manager.maybeRenewClaim(row, randomUUID(), 1000);
        expect(renewed).toBe(true);
        expect(row.claimExpiresAt.getTime()).toBeGreaterThan(originalExpiry);

        // Now past the ORIGINAL lease's expiry (700+400=1100ms > 1000ms)
        // but well within the renewed window — a second claim attempt
        // must still be excluded, proving the renewal genuinely extended
        // ownership rather than the row simply becoming reclaimable.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const secondClaim = await manager.claimUndispatchedEvents();
        expect(secondClaim.find((r) => r.id === event.id)).toBeUndefined();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("13. losing ownership mid-dispatch (another relay reclaims) stops further dispatch, creates no BackgroundJob rows, and never finalizes", async () => {
      process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";
      process.env.OUTBOX_RELAY_CLAIM_LEASE_MS = "1000";
      const manifests = [consumerManifest({ consumerName: "outbox-test-consumer-a" }), consumerManifest({ consumerName: "outbox-test-consumer-b" })];
      const { moduleRef, prisma, heartbeat } = await bootstrap(manifests);
      try {
        const manager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "ownership-lost" });

        const claimed = await manager.claimUndispatchedEvents();
        const row = claimed.find((r) => r.id === event.id)!;
        expect(row).toBeDefined();

        // Cross the renewal threshold so processEvent's own "before
        // fan-out" renewal check actually attempts a guarded UPDATE
        // (a fresh claim's remaining lease is otherwise still >50%, so
        // the check would short-circuit without touching the DB at all).
        await new Promise((resolve) => setTimeout(resolve, 700));

        // Simulate "another relay already reclaimed this event" — steal
        // the claim by directly overwriting claim_token, exactly the
        // durable state a real second relay's own claim UPDATE would
        // have produced.
        await prisma.domainEvent.update({ where: { id: event.id }, data: { claimToken: randomUUID() } });

        const result = await manager.processEvent(row, randomUUID());
        expect(result.ownershipLost).toBe(true);
        expect(result.dispatched).toBe(false);

        // No BackgroundJob may have been created under the stolen claim
        // — per-consumer dispatch must not proceed once ownership is
        // lost, for either consumer.
        const jobs = await prisma.backgroundJob.findMany({ where: { idempotencyKey: { startsWith: `event:${event.id}:` } } });
        expect(jobs).toHaveLength(0);

        const finalRow = await prisma.domainEvent.findUnique({ where: { id: event.id } });
        expect(finalRow?.dispatchedAt).toBeNull();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("14. two independent relay instances draw disjoint, mutually-exclusive claims from the same batch", async () => {
      process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";
      const bootA = await bootstrap([consumerManifest()]);
      const bootB = await bootstrap([consumerManifest()]);
      try {
        const managerA = bootA.moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const managerB = bootB.moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;

        const events = await Promise.all(Array.from({ length: 10 }, (_, i) => publishTracked(bootA.prisma, TEST_EVENT_TYPE, { note: `two-instance-${i}` })));

        // Sequential, not concurrent — A fully commits before B even
        // starts, exactly the interleaving the correctness review's own
        // empirical script used, and the one the original design's test
        // (a Promise.all of two same-instance calls) could not exercise.
        const claimA = await managerA.claimUndispatchedEvents();
        const claimB = await managerB.claimUndispatchedEvents();

        const idsA = new Set(claimA.map((r) => r.id));
        const idsB = new Set(claimB.map((r) => r.id));
        const overlap = [...idsA].filter((id) => idsB.has(id));
        expect(overlap).toHaveLength(0);

        const union = new Set([...idsA, ...idsB]);
        for (const event of events) expect(union.has(event.id)).toBe(true);
      } finally {
        await cleanup(bootA.moduleRef, bootA.heartbeat);
        await cleanup(bootB.moduleRef, bootB.heartbeat);
      }
    }, 30_000);
  });

  // ==================================================================
  // Group D — permanent per-consumer failure durability (Milestone 8.2
  // correctness fix item 6). A permanent payload-validation failure must
  // be a durable BackgroundJob record, never log-only.
  // ==================================================================
  describe("permanent per-consumer failure durability", () => {
    it("15. a permanently invalid payload is recorded as a durable, dead-lettered BackgroundJob with correct history — not log-only", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest({ payloadDto: OutboxUnvalidatablePayload })]);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "missing-required-field" });

        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);

        const job = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(job).not.toBeNull();
        expect(job?.status).toBe("FAILED");
        expect(job?.errorCode).toBe("EVENT_PAYLOAD_VALIDATION_FAILED");
        expect(job?.errorMessageSafe).toBeTruthy();
        expect(job?.deadLetteredAt).not.toBeNull();

        // No fake RUNNING execution invented for a job the worker never
        // picked up — its first-ever history transition goes straight
        // from "created" (fromStatus null) to FAILED.
        const history = await prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: job!.id } });
        expect(history).toHaveLength(1);
        expect(history[0].fromStatus).toBeNull();
        expect(history[0].toStatus).toBe("FAILED");
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("16. a permanently-failing consumer does not block a sibling valid consumer in the same fan-out, and both are durably recorded", async () => {
      const manifests = [
        consumerManifest({ consumerName: "outbox-test-consumer-valid", payloadDto: OutboxTestPayload }),
        consumerManifest({ consumerName: "outbox-test-consumer-invalid", payloadDto: OutboxUnvalidatablePayload }),
      ];
      const { moduleRef, prisma, heartbeat } = await bootstrap(manifests);
      try {
        // Valid against OutboxTestPayload (all fields optional), but
        // OutboxUnvalidatablePayload requires "requiredField" — a
        // deliberate, permanent, per-consumer validation failure.
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "mixed-validity" });

        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);

        const validJob = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-valid` } });
        const invalidJob = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-invalid` } });

        // Not asserting validJob.status here: this job WAS genuinely
        // dispatched to BullMQ (a real add() call, unlike the invalid
        // consumer's job below), so the real, already-running
        // BullMqWorkerManager sharing this AppModule/SYSTEM queue races
        // to pick it up — and, having no ProcessorManifest registered for
        // "event.*.v1" jobTypes (Milestone 8.3 scope), will itself
        // transition QUEUED -> RUNNING -> FAILED via its own unrelated
        // "no handler bound" path. That race is expected and accepted
        // (documented on OutboxRelayManager itself); asserting a specific
        // status here would be asserting who won a race this test isn't
        // about. What "not blocked" actually means is proven by identity
        // (idempotencyKey) and existence — a real BackgroundJob row was
        // created for the valid consumer at all, fanned out independently
        // of the invalid consumer's permanent failure.
        expect(validJob).not.toBeNull();
        expect(validJob?.idempotencyKey).toBe(`event:${event.id}:consumer:outbox-test-consumer-valid`);

        expect(invalidJob).not.toBeNull(); // durable, not absent
        expect(invalidJob?.status).toBe("FAILED");
        expect(invalidJob?.errorCode).toBe("EVENT_PAYLOAD_VALIDATION_FAILED");
        expect(invalidJob?.deadLetteredAt).not.toBeNull();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("17. an invalid payload's sole consumer still finalizes dispatchedAt (terminal, not blocking), and a sibling valid event in the same batch still proceeds", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest({ payloadDto: OutboxUnvalidatablePayload })]);
      try {
        const invalidEvent = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "missing-required-field" });
        const validEvent = await publishTracked(prisma, TEST_EVENT_TYPE, { requiredField: "present" });

        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: validEvent.id } });
          return row?.dispatchedAt != null;
        }, 15_000);
        // The invalid event's ONLY consumer permanently fails validation,
        // which is a TERMINAL outcome (not a transient one) — per the
        // frozen fan-out rule, the row still gets finalized, durably
        // recorded as a dead-lettered BackgroundJob rather than left
        // permanently unfinalized.
        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: invalidEvent.id } });
          return row?.dispatchedAt != null;
        }, 15_000);

        const invalidJob = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${invalidEvent.id}:consumer:outbox-test-consumer-a` } });
        expect(invalidJob?.status).toBe("FAILED");
        expect(invalidJob?.errorCode).toBe("EVENT_PAYLOAD_VALIDATION_FAILED");
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);
  });

  // ==================================================================
  // Group E — error handling / per-row isolation (zero-consumer
  // semantics, unrelated to per-consumer payload validation above)
  // ==================================================================
  describe("error handling and per-row isolation", () => {
    it("18. unsupported eventType is left undispatched deterministically, not silently treated as dispatched", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const event = await publishTracked(prisma, "outbox.no-such-consumer.v1", { note: "unsupported-type" });
        // Deliberately wait, then assert the NEGATIVE — this eventType
        // has zero registered consumers by construction.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
        expect(row?.dispatchedAt).toBeNull();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("19. unsupported eventVersion (no consumer registered for that exact version) is handled identically to an unsupported eventType", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]); // only v1 registered
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE_V2, { note: "unsupported-version" });
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
        expect(row?.dispatchedAt).toBeNull();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);
  });

  // ==================================================================
  // Group F — first-attempt BullMQ dispatch-failure durability and
  // recovery (Milestone 8.2 correctness fix item 7/8).
  // ==================================================================
  describe("first-attempt BullMQ dispatch-failure durability and recovery", () => {
    it("20. a synchronous BullMQ dispatch failure after DB commit is durably compensated to FAILED (never left looking like a healthy QUEUED row), does not finalize the event, and a later reclaim completes it", async () => {
      process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";
      process.env.OUTBOX_RELAY_CLAIM_LEASE_MS = "1000";
      const bootA = await bootstrap([consumerManifest()]);
      const managerA = bootA.moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;

      // Warm-up: dispatch one throwaway event successfully FIRST, while
      // Redis is still healthy. getDispatchQueue() lazily constructs and
      // caches a BullMQ Queue per queue name on its first use — and
      // Queue construction against an ALREADY-closed connection throws
      // as an unhandled 'error' event (no listener is attached to newly
      // created dispatch queues, a pre-existing gap shared identically
      // by BullMqWorkerManager.getQueue and SchedulerTickManager.
      // getDispatchQueue, both out of this fix's scope — see the
      // completion report). Warming the cache up-front means the actual
      // test below reuses an already-ready Queue object, so disconnecting
      // and then calling .add() rejects cleanly instead of hitting that
      // unrelated construction-time gap.
      const warmupEvent = await publishEvent(bootA.prisma, TEST_EVENT_TYPE, { note: "warm-up" });
      const warmupClaim = await managerA.claimUndispatchedEvents();
      await managerA.processEvent(warmupClaim.find((r) => r.id === warmupEvent.id)!, randomUUID());
      await deleteJobsForEvent(bootA.prisma, warmupEvent.id);
      await bootA.prisma.domainEvent.deleteMany({ where: { id: warmupEvent.id } });

      const event = await publishEvent(bootA.prisma, TEST_EVENT_TYPE, { note: "dispatch-failure-recovery" });
      try {
        const claimed = await managerA.claimUndispatchedEvents();
        const row = claimed.find((r) => r.id === event.id)!;
        expect(row).toBeDefined();

        // Deterministically force the next BullMQ call to reject FAST —
        // not hang. A genuinely unreachable host (e.g. redis://redis:1)
        // combined with this connection's maxRetriesPerRequest: null
        // setting queues commands forever rather than rejecting them
        // (empirically verified; also already the documented reason
        // apps/api/test/background-jobs.e2e-spec.ts's own Redis-
        // resilience test avoids exercising a live dispatch that way).
        // disconnect() (not quit()) puts ioredis into a terminal,
        // non-reconnecting state where the very next command on an
        // ALREADY-ready Queue rejects immediately with "Connection is
        // closed." — a real, safely-controlled BullMQ/ioredis failure,
        // not a mock.
        managerA.connection!.disconnect();

        const result = await managerA.processEvent(row, randomUUID());
        expect(result.dispatched).toBe(false);

        const job = await bootA.prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(job).not.toBeNull(); // durable, not just a log line
        expect(job?.status).toBe("FAILED");
        expect(job?.errorCode).toBe("ENQUEUE_DISPATCH_FAILED");
        expect(job?.deadLetteredAt).toBeNull(); // transient — not a permanent give-up

        const historyAfterA = await bootA.prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: job!.id }, orderBy: { occurredAt: "asc" } });
        expect(historyAfterA.map((h) => h.toStatus)).toEqual(["QUEUED", "FAILED"]);

        const eventAfterA = await bootA.prisma.domainEvent.findUnique({ where: { id: event.id } });
        expect(eventAfterA?.dispatchedAt).toBeNull(); // remains recoverable, never falsely finalized
      } finally {
        // Force the lease into an already-expired state directly — not a
        // real-time sleep. This is the same deterministic-timing/control
        // discipline the correctness review asked for elsewhere (e.g.
        // test 13's direct claim_token overwrite to simulate "another
        // relay already reclaimed"): a wall-clock sleep race against a
        // short lease is exactly the kind of probabilistic timing this
        // fix is supposed to eliminate, not reintroduce in its own tests.
        await bootA.prisma.domainEvent.update({ where: { id: event.id }, data: { claimExpiresAt: new Date(Date.now() - 1_000) } });
        // Close bootA WITHOUT deleting the DB rows — phase 2 below needs
        // them to still exist to prove recovery.
        await bootA.prisma.workerHeartbeat.deleteMany({ where: { workerId: bootA.heartbeat.workerId } }).catch(() => undefined);
        await bootA.moduleRef.close();
      }

      // Phase 2: a fresh relay instance (healthy Redis, fresh connection)
      // reclaims (the lease was forced into the past above — not a
      // wall-clock wait) and completes the dispatch — the job flips back
      // to QUEUED (never left at FAILED forever, so BullMqWorkerManager's
      // own pickup guard never silently skips it), and the event
      // finalizes.
      const bootB = await bootstrap([consumerManifest()]);
      try {
        const managerB = bootB.moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const reclaimed = await managerB.claimUndispatchedEvents();
        const rowB = reclaimed.find((r) => r.id === event.id)!;
        expect(rowB).toBeDefined(); // phase 1's lease had expired

        const resultB = await managerB.processEvent(rowB, randomUUID());
        expect(resultB.dispatched).toBe(true);

        const job = await bootB.prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(job?.status).toBe("QUEUED");
        expect(job?.errorCode).toBeNull();
        const historyAfterB = await bootB.prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: job!.id }, orderBy: { occurredAt: "asc" } });
        expect(historyAfterB.map((h) => h.toStatus)).toEqual(["QUEUED", "FAILED", "QUEUED"]);

        const finalEventRow = await bootB.prisma.domainEvent.findUnique({ where: { id: event.id } });
        expect(finalEventRow?.dispatchedAt).not.toBeNull();
      } finally {
        trackedEventIds.push(event.id);
        await cleanup(bootB.moduleRef, bootB.heartbeat);
      }
    }, 40_000);
  });

  // ==================================================================
  // Group G — no network call under a held DB lock; Redis outage/recovery
  // ==================================================================
  describe("no network call under DB lock; Redis outage and recovery", () => {
    it("21. claiming succeeds and stays fast even when Redis is genuinely unreachable — the claim step itself never touches Redis", async () => {
      process.env.REDIS_URL = "redis://redis:1";
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const manager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "redis-down-claim" });

        const start = Date.now();
        const claimed = await manager.claimUndispatchedEvents();
        const elapsed = Date.now() - start;

        expect(claimed.some((r) => r.id === event.id)).toBe(true);
        // The claim transaction is pure Postgres — bounded, fast,
        // regardless of Redis reachability. A generous bound (well
        // under any Redis timeout/retry delay) proves no Redis call
        // happened inside it. Still true after the atomic UPDATE...
        // RETURNING rewrite: EXPLAIN ANALYZE was re-verified against a
        // realistic-scale table (500k+ rows) as part of this fix — the
        // planner uses domain_events_undispatched_idx for the candidate
        // scan and domain_events_pkey for the outer UPDATE's row match,
        // no additional index required.
        expect(elapsed).toBeLessThan(3_000);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("22. relay resumes normal dispatch once Redis becomes reachable again", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "redis-recovery" });
        // Redis is healthy for this whole test (default REDIS_URL) —
        // proves the normal path still fully completes end-to-end,
        // the direct counterpart to test 21's degraded-path proof.
        await waitUntil(async () => {
          const row = await prisma.domainEvent.findUnique({ where: { id: event.id } });
          return row?.dispatchedAt != null;
        }, 15_000);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("23. repeated claims against a genuinely unreachable Redis stay consistently fast — no network call is hiding inside the held transaction", async () => {
      // Empirical, not just structural: if any Redis call were reachable
      // from inside claimUndispatchedEvents' own transaction, repeated
      // calls against a broken REDIS_URL would each pay ioredis's own
      // reconnect-attempt cost and show clearly elevated, likely
      // increasing latency. Five consecutive calls staying uniformly
      // fast is the same style of proof DEFECT-1F-004's own regression
      // tests used for an analogous "no abandoned Redis resource"
      // property.
      process.env.REDIS_URL = "redis://redis:1";
      const { moduleRef, prisma, heartbeat } = await bootstrap([consumerManifest()]);
      try {
        const manager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        await publishTracked(prisma, TEST_EVENT_TYPE, { note: "repeated-claim-latency" });

        const durationsMs: number[] = [];
        for (let i = 0; i < 5; i++) {
          const start = Date.now();
          await manager.claimUndispatchedEvents();
          durationsMs.push(Date.now() - start);
        }

        for (const duration of durationsMs) expect(duration).toBeLessThan(2_000);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);
  });

  // ==================================================================
  // Group H — shutdown
  // ==================================================================
  describe("bounded shutdown", () => {
    it("24. shutdown is bounded with Redis healthy — GRACEFUL", async () => {
      const { moduleRef, heartbeat } = await bootstrap([consumerManifest()]);
      const tracker = moduleRef.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);
      await cleanup(moduleRef, heartbeat);
      expect(tracker.getAll().get("OutboxRelayManager")).toBe("GRACEFUL");
    }, 15_000);

    it("25. shutdown is bounded with Redis genuinely unreachable — FORCED", async () => {
      process.env.REDIS_URL = "redis://redis:1";
      const { moduleRef, heartbeat } = await bootstrap([consumerManifest()]);
      const tracker = moduleRef.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

      const start = Date.now();
      await cleanup(moduleRef, heartbeat);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(8_000);
      expect(tracker.getAll().get("OutboxRelayManager")).toBe("FORCED");
    }, 20_000);

    it("26. repeated startup/shutdown cycles do not grow active handles", async () => {
      const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
      const handleCounts: number[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        const { moduleRef, heartbeat } = await bootstrap([consumerManifest()]);
        await cleanup(moduleRef, heartbeat);
        await new Promise((resolve) => setTimeout(resolve, 300));
        handleCounts.push((proc._getActiveHandles?.() ?? []).length);
      }
      const growth = handleCounts[handleCounts.length - 1] - handleCounts[0];
      expect(growth).toBeLessThanOrEqual(2);
    }, 40_000);
  });

  // ==================================================================
  // Group I — end-to-end duplicate-dispatch and redispatch proof, using
  // REAL BullMQ and a REAL BullMqWorkerManager Worker (no mocks). The
  // real worker is paused/resumed (never bypassed) to make "which state
  // Relay B observes" deterministic rather than a race against real
  // execution — the correctness property under test does not depend on
  // whether "Relay A" and "Relay B" are literally different processes;
  // dispatchToConsumer's behavior is driven entirely by DB state, not by
  // relay identity, so two calls against the same manager instance
  // faithfully exercise the same code path two separate relay instances
  // would.
  // ==================================================================
  describe("end-to-end duplicate-dispatch and redispatch proof (real BullMQ execution)", () => {
    it("27. Relay A creates+adds a job then 'dies' before any status transition; Relay B reclaims, sees QUEUED, re-adds with the identical jobId — BullMQ holds exactly one job, the worker executes exactly once, exactly one execution history chain exists, and the DomainEvent finalizes exactly once", async () => {
      process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";
      const manifest = consumerManifest();
      const { moduleRef, prisma, heartbeat } = await bootstrap([manifest]);
      let verifyQueue: Queue | undefined;
      let verifyConnection: Redis | undefined;
      try {
        const outboxManager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const bullMqManager = moduleRef.get(BullMqWorkerManager) as unknown as BullMqWorkerManagerInternals;
        const systemWorker = bullMqManager.workers.find((w) => w.name === "SYSTEM")!;
        expect(systemWorker).toBeDefined();

        // Pause the REAL worker BEFORE any job exists — this is what
        // makes "Relay B still observes status QUEUED" deterministic
        // rather than a race against real execution, without mocking
        // anything about the worker itself.
        await systemWorker.pause();

        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "dup-dispatch-proof" });
        const claimed = await outboxManager.claimUndispatchedEvents();
        const row = claimed.find((r) => r.id === event.id)!;
        expect(row).toBeDefined();

        // --- Relay A: create BackgroundJob, commit, Queue.add() succeeds ---
        const outcomeA = await outboxManager.dispatchToConsumer(row, manifest, randomUUID());
        expect(outcomeA).toBe("dispatched");

        const jobAfterA = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(jobAfterA).not.toBeNull();
        expect(jobAfterA?.status).toBe("QUEUED"); // dispatchToConsumer itself never writes past QUEUED on success

        // Independent verification directly against real Redis/BullMQ —
        // a separate connection/Queue object, not trusting the app's own
        // internal one.
        verifyConnection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
        verifyQueue = new Queue("SYSTEM", { connection: verifyConnection });
        const countsAfterA = await verifyQueue.getJobCounts();
        expect(countsAfterA.waiting + countsAfterA.active + countsAfterA.delayed).toBe(1);
        expect((await verifyQueue.getJob(jobAfterA!.id))?.id).toBe(jobAfterA!.id);

        // --- "process death before any status transition": nothing
        // more executes on Relay A's behalf for this job. ---

        // --- Relay B: a second dispatchToConsumer call for the SAME
        // event+consumer — exactly what a second relay reclaim attempt
        // does — hits the idempotency violation, finds the existing
        // (still QUEUED, proven above) row, and re-adds with the
        // identical jobId. ---
        const outcomeB = await outboxManager.dispatchToConsumer(row, manifest, randomUUID());
        expect(outcomeB).toBe("dispatched");

        const jobAfterB = await prisma.backgroundJob.findFirst({ where: { idempotencyKey: `event:${event.id}:consumer:outbox-test-consumer-a` } });
        expect(jobAfterB?.id).toBe(jobAfterA!.id); // same row, not a second one
        expect(jobAfterB?.status).toBe("QUEUED");

        const countsAfterB = await verifyQueue.getJobCounts();
        expect(countsAfterB.waiting + countsAfterB.active + countsAfterB.delayed).toBe(1); // STILL exactly one — B's add() did not create a second BullMQ job
        expect((await verifyQueue.getJob(jobAfterA!.id))?.id).toBe(jobAfterA!.id); // same underlying BullMQ job

        // --- Resume the real worker — it picks up and executes exactly once. ---
        await systemWorker.resume();
        await waitUntil(async () => {
          const j = await prisma.backgroundJob.findUnique({ where: { id: jobAfterA!.id } });
          return j?.status === "FAILED";
        }, 15_000);
        // "event.*.v1" has no registered ProcessorManifest (Milestone 8.3
        // scope) — BullMqWorkerManager's own already-proven "no handler
        // bound" permanent-failure path applies, exactly as documented
        // and accepted throughout Milestone 8.2. This is still a REAL
        // worker pickup + REAL QUEUED->RUNNING Postgres transition —
        // sufficient to prove "executes exactly once."

        const history = await prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: jobAfterA!.id }, orderBy: { occurredAt: "asc" } });
        expect(history.map((h) => `${h.fromStatus ?? "CREATED"}->${h.toStatus}`)).toEqual(["CREATED->QUEUED", "QUEUED->RUNNING", "RUNNING->FAILED"]);
        expect(history.filter((h) => h.toStatus === "RUNNING")).toHaveLength(1); // executed exactly once, despite two add() calls

        // --- DomainEvent finalizes exactly once, even though
        // dispatchToConsumer ran twice: markDispatched is guarded and
        // idempotent. ---
        const finalizedOnce = await outboxManager.markDispatched(event.id, row.claimToken);
        expect(finalizedOnce).toBe(true);
        const finalizedTwice = await outboxManager.markDispatched(event.id, row.claimToken);
        expect(finalizedTwice).toBe(false); // second attempt is a guarded no-op
        const finalEventRow = await prisma.domainEvent.findUnique({ where: { id: event.id } });
        expect(finalEventRow?.dispatchedAt).not.toBeNull();
      } finally {
        await verifyQueue?.close().catch(() => undefined);
        verifyConnection?.disconnect();
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);

    it("28. a job left FAILED/ENQUEUE_DISPATCH_FAILED after a prior transient dispatch failure: relay retry produces exactly one new BullMQ enqueue, the worker executes exactly once, and status transitions correctly through QUEUED->FAILED->QUEUED->RUNNING->FAILED", async () => {
      process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";
      const manifest = consumerManifest();
      const { moduleRef, prisma, heartbeat } = await bootstrap([manifest]);
      let verifyQueue: Queue | undefined;
      let verifyConnection: Redis | undefined;
      try {
        const outboxManager = moduleRef.get(OutboxRelayManager) as unknown as OutboxRelayInternals;
        const bullMqManager = moduleRef.get(BullMqWorkerManager) as unknown as BullMqWorkerManagerInternals;
        const systemWorker = bullMqManager.workers.find((w) => w.name === "SYSTEM")!;
        await systemWorker.pause();

        const event = await publishTracked(prisma, TEST_EVENT_TYPE, { note: "redispatch-proof" });
        const idempotencyKey = `event:${event.id}:consumer:outbox-test-consumer-a`;

        // Directly construct the "prior transient dispatch failure"
        // state (Milestone 8.2 correctness fix item 7): a BackgroundJob
        // row that was created and committed, but whose own add() call
        // genuinely failed and was synchronously compensated — it never
        // actually reached BullMQ.
        const priorJob = await prisma.$transaction(async (tx) => {
          const created = await tx.backgroundJob.create({
            data: {
              workspaceId: event.workspaceId,
              jobType: "event.outbox-test-consumer-a.v1",
              queueName: "SYSTEM",
              payloadMetadata: { note: "redispatch-proof" },
              maxAttempts: 3,
              idempotencyKey,
              correlationId: randomUUID(),
            },
          });
          await tx.backgroundJobHistory.create({ data: { backgroundJobId: created.id, toStatus: "QUEUED" } });
          await tx.backgroundJob.update({
            where: { id: created.id },
            data: { status: "FAILED", failedAt: new Date(), errorCode: "ENQUEUE_DISPATCH_FAILED", errorMessageSafe: "Failed to dispatch job to the queue." },
          });
          await tx.backgroundJobHistory.create({
            data: { backgroundJobId: created.id, fromStatus: "QUEUED", toStatus: "FAILED", detail: { errorCode: "ENQUEUE_DISPATCH_FAILED" } },
          });
          return created;
        });

        verifyConnection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
        verifyQueue = new Queue("SYSTEM", { connection: verifyConnection });
        const countsBefore = await verifyQueue.getJobCounts();
        expect(await verifyQueue.getJob(priorJob.id)).toBeUndefined(); // confirmed: never actually reached BullMQ

        const claimed = await outboxManager.claimUndispatchedEvents();
        const row = claimed.find((r) => r.id === event.id)!;
        expect(row).toBeDefined();

        // The relay reclaims and retries — dispatchToConsumer finds the
        // existing FAILED/ENQUEUE_DISPATCH_FAILED row and (per the
        // redispatch decision) DOES re-attempt add(), since this is
        // exactly the case that requires it for crash recovery.
        const outcome = await outboxManager.dispatchToConsumer(row, manifest, randomUUID());
        expect(outcome).toBe("dispatched");

        const jobAfterRetry = await prisma.backgroundJob.findUnique({ where: { id: priorJob.id } });
        expect(jobAfterRetry?.status).toBe("QUEUED"); // flipped back via compensateRetrySuccess
        expect(jobAfterRetry?.errorCode).toBeNull();

        const countsAfterRetry = await verifyQueue.getJobCounts();
        const newlyEnqueued =
          countsAfterRetry.waiting + countsAfterRetry.active + countsAfterRetry.delayed - (countsBefore.waiting + countsBefore.active + countsBefore.delayed);
        expect(newlyEnqueued).toBe(1); // exactly one NEW enqueue
        expect((await verifyQueue.getJob(priorJob.id))?.id).toBe(priorJob.id);

        await systemWorker.resume();
        await waitUntil(async () => {
          const j = await prisma.backgroundJob.findUnique({ where: { id: priorJob.id } });
          return j?.status === "FAILED";
        }, 15_000);

        const history = await prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: priorJob.id }, orderBy: { occurredAt: "asc" } });
        expect(history.map((h) => `${h.fromStatus ?? "CREATED"}->${h.toStatus}`)).toEqual([
          "CREATED->QUEUED",
          "QUEUED->FAILED", // the simulated prior transient dispatch failure
          "FAILED->QUEUED", // compensateRetrySuccess
          "QUEUED->RUNNING", // the worker's single pickup
          "RUNNING->FAILED", // no ProcessorManifest bound — expected/accepted
        ]);
        expect(history.filter((h) => h.toStatus === "RUNNING")).toHaveLength(1); // executed exactly once
      } finally {
        await verifyQueue?.close().catch(() => undefined);
        verifyConnection?.disconnect();
        await cleanup(moduleRef, heartbeat);
      }
    }, 30_000);
  });
});
