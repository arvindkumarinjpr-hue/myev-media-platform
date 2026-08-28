import { randomUUID } from "crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { SYSTEM_PING_V1_MANIFEST, UNREACHABLE_REDIS_URL } from "@myev/shared";
import {
  bootstrapE2eApp,
  createWorkspaceAsOwner,
  loginAsPlatformOwner,
  request,
  teardownE2eApp,
  type E2eApp,
} from "./helpers/e2e-app";
import { BackgroundJobsService } from "../src/modules/background-jobs/background-jobs.service";

/**
 * Module 1F Milestone 4 (e2e). Runs against the REAL dev Docker Compose
 * stack — real Postgres, real Redis, and the real, already-running
 * apps/worker container actually picks up and executes every job this
 * suite enqueues. No mocking of the queue, the worker, or the database:
 * proving the full API <-> Postgres <-> Redis <-> Worker <-> Postgres
 * loop is the entire point of this milestone.
 */

interface JobResponse {
  publicId: string;
  jobType: string;
  status: string;
  resultMetadata: { echo?: string; respondedAt?: string } | null;
  errorCode: string | null;
  cancellationRequestedAt: string | null;
  cancelledAt: string | null;
  attempts: number;
  processorVersion: string | null;
}

async function waitForStatus(
  ctx: E2eApp,
  wsPublicId: string,
  accessToken: string,
  jobPublicId: string,
  statuses: string[],
  timeoutMs = 10_000,
): Promise<JobResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/workspaces/${wsPublicId}/background-jobs/${jobPublicId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Workspace-Id", wsPublicId)
      .expect(200);
    const job = res.body.data as JobResponse;
    if (statuses.includes(job.status)) return job;
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobPublicId} did not reach status ${statuses.join("/")} within ${timeoutMs}ms — last seen: ${job.status}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("Background jobs (e2e)", () => {
  let ctx: E2eApp;
  let backgroundJobs: BackgroundJobsService;
  let ownerAccessToken: string;
  let workspace: { publicId: string; slug: string; name: string };
  let workspaceInternalId: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    backgroundJobs = ctx.app.get(BackgroundJobsService);
    const owner = await loginAsPlatformOwner(ctx);
    ownerAccessToken = owner.accessToken;
    workspace = await createWorkspaceAsOwner(ctx, ownerAccessToken);
    const ws = await ctx.prisma.workspace.findUniqueOrThrow({
      where: { publicId: workspace.publicId },
    });
    workspaceInternalId = ws.id;
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  describe("enqueue() — internal service method, no HTTP surface in Module 1F", () => {
    it("rejects an unregistered job type", async () => {
      await expect(
        backgroundJobs.enqueue({
          workspaceId: workspaceInternalId,
          jobType: "not.a.real.job.v1",
          payload: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a payload that fails class-validator validation", async () => {
      await expect(
        backgroundJobs.enqueue({
          workspaceId: workspaceInternalId,
          jobType: "system.ping.v1",
          payload: { echo: 12345 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("full lifecycle: enqueue -> real Worker execution -> COMPLETED", () => {
    it("runs system.ping.v1 to completion with a correct job_history trail", async () => {
      const created = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: "e2e-api" },
      });

      const job = await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
      );

      expect(job.status).toBe("COMPLETED");
      expect(job.resultMetadata?.echo).toBe("e2e-api");
      expect(job.processorVersion).toBeTruthy();
      expect(job.attempts).toBe(1);

      const history = await ctx.prisma.backgroundJobHistory.findMany({
        where: { backgroundJobId: created.id },
        orderBy: { occurredAt: "asc" },
      });
      expect(history.map((h) => h.toStatus)).toEqual([
        "QUEUED",
        "RUNNING",
        "COMPLETED",
      ]);
    });

    it("appears in the workspace's job list, filterable by status", async () => {
      const listRes = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${workspace.publicId}/background-jobs`)
        .query({ status: "COMPLETED", jobType: "system.ping.v1" })
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(200);
      const jobs = listRes.body.data as JobResponse[];
      expect(jobs.length).toBeGreaterThan(0);
      expect(
        jobs.every(
          (j) => j.status === "COMPLETED" && j.jobType === "system.ping.v1",
        ),
      ).toBe(true);
    });

    it("idempotency key: a replayed enqueue with the same key returns the original row, not a duplicate", async () => {
      const key = `e2e-idem-${Date.now()}`;
      const first = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: "once" },
        idempotencyKey: key,
      });
      const second = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: "once" },
        idempotencyKey: key,
      });
      expect(second.id).toBe(first.id);
      expect(second.publicId).toBe(first.publicId);
    });
  });

  describe("cancellation", () => {
    it("requests cancellation on a still-running job and the Worker completes it as CANCELLED", async () => {
      const created = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: "will-be-cancelled", delayMs: 2_500 },
      });

      const cancelRes = await request(ctx.app.getHttpServer())
        .post(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/cancel`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      expect(
        (cancelRes.body.data as JobResponse).cancellationRequestedAt,
      ).toBeTruthy();

      const job = await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
      );
      expect(job.status).toBe("FAILED");
      expect(job.errorCode).toBe("JOB_CANCELLED_BY_USER");
      expect(job.cancelledAt).toBeTruthy();

      const auditRow = await ctx.prisma.auditLog.findFirst({
        where: {
          action: "JOB_CANCELLATION_REQUESTED",
          entityId: created.publicId,
          workspaceId: workspaceInternalId,
        },
      });
      expect(auditRow).not.toBeNull();
    });

    it("rejects cancelling a job that has already finished", async () => {
      const created = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: {},
      });
      await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
      );

      const res = await request(ctx.app.getHttpServer())
        .post(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/cancel`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(409);
      expect(res.body.code).toBe("JOB_ALREADY_TERMINAL");
    });

    it("404s for an unknown job id", async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/00000000-0000-0000-0000-000000000000`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(404);
      expect(res.body.code).toBe("JOB_NOT_FOUND");
    });
  });

  describe("retry", () => {
    it("resets a cancelled job to QUEUED and the Worker completes it on the retried attempt", async () => {
      const created = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: "retry-me", delayMs: 2_500 },
      });
      await request(ctx.app.getHttpServer())
        .post(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/cancel`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      const cancelled = await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["FAILED"],
      );
      expect(cancelled.errorCode).toBe("JOB_CANCELLED_BY_USER");

      const retryRes = await request(ctx.app.getHttpServer())
        .post(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/retry`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      expect((retryRes.body.data as JobResponse).status).toBe("QUEUED");

      const completed = await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
      );
      expect(completed.status).toBe("COMPLETED");
      expect(completed.attempts).toBe(2);

      const auditRow = await ctx.prisma.auditLog.findFirst({
        where: {
          action: "JOB_RETRY_REQUESTED",
          entityId: created.publicId,
          workspaceId: workspaceInternalId,
        },
      });
      expect(auditRow).not.toBeNull();
    });

    it("rejects retrying a job that is not in a terminal FAILED/TIMED_OUT state", async () => {
      const created = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: {},
      });
      await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["COMPLETED"],
      );

      const res = await request(ctx.app.getHttpServer())
        .post(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/retry`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(409);
      expect(res.body.code).toBe("JOB_NOT_RETRYABLE_IN_CURRENT_STATE");
    });

    it("retry request during failure processing: rejects a retry attempted while the job is still RUNNING (not yet a concluded failure)", async () => {
      const created = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: "still-running", delayMs: 2_500 },
      });
      await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["RUNNING"],
      );

      const res = await request(ctx.app.getHttpServer())
        .post(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/retry`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(409);
      expect(res.body.code).toBe("JOB_NOT_RETRYABLE_IN_CURRENT_STATE");

      // Drain — let the job actually finish so it doesn't leak into later
      // tests/teardown mid-flight.
      await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
      );
    });

    it("exactly-one-scheduler invariant: two concurrent retry requests on the same terminal job — exactly one succeeds, the other is rejected deterministically, not silently duplicated", async () => {
      // Constructed directly (bypassing a real failed execution) purely
      // to make the race itself the only variable under test.
      const row = await ctx.prisma.backgroundJob.create({
        data: {
          workspaceId: workspaceInternalId,
          jobType: "system.ping.v1",
          queueName: "SYSTEM",
          correlationId: randomUUID(),
          status: "FAILED",
          failedAt: new Date(),
          errorCode: "PROCESSOR_ERROR",
          attempts: 1,
          maxAttempts: 3,
        },
      });

      const fireRetry = () =>
        request(ctx.app.getHttpServer())
          .post(
            `/api/v1/workspaces/${workspace.publicId}/background-jobs/${row.publicId}/retry`,
          )
          .set("Authorization", `Bearer ${ownerAccessToken}`)
          .set("X-Workspace-Id", workspace.publicId);

      const [first, second] = await Promise.all([fireRetry(), fireRetry()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      // The loser's rejection reason depends on exactly how close the race
      // was: if it loses badly enough that even its OWN initial read
      // already reflects the winner's committed write, it's rejected by
      // the ordinary status guard (JOB_NOT_RETRYABLE_IN_CURRENT_STATE); if
      // it's closer than that, both pass the initial read and it's the
      // guarded UPDATE's WHERE clause that rejects it
      // (JOB_RETRY_ALREADY_SCHEDULED). Both are the SAME invariant holding
      // — a deterministic rejection, never a duplicate dispatch — just
      // via whichever of the two guards actually caught it; the test
      // asserts the invariant, not one specific code path's exact timing.
      const rejected = first.status === 409 ? first : second;
      expect([
        "JOB_RETRY_ALREADY_SCHEDULED",
        "JOB_NOT_RETRYABLE_IN_CURRENT_STATE",
      ]).toContain(rejected.body.code);

      // Not asserting status==="QUEUED" specifically: the real, always-on
      // Worker in this stack picks a re-queued system.ping.v1 job up
      // near-instantly, so by the time this read runs the row may already
      // be RUNNING or even COMPLETED — any of which proves the retry was
      // genuinely scheduled and is progressing, which is what matters here.
      const afterRace = await ctx.prisma.backgroundJob.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(["QUEUED", "RUNNING", "COMPLETED"]).toContain(afterRace.status);

      // Only ONE retry transition was ever recorded, not two.
      const history = await ctx.prisma.backgroundJobHistory.findMany({
        where: { backgroundJobId: row.id, toStatus: "QUEUED" },
      });
      expect(history).toHaveLength(1);

      await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        row.publicId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
      );
    });
  });

  describe("Redis connection resilience", () => {
    it("a Redis connection error does not crash the API process (mirrors the identical fix in apps/worker's BullMqWorkerManager)", async () => {
      // Same rationale and technique as apps/worker's equivalent test:
      // an unhandled 'error' event on a bare ioredis client crashes the
      // whole process. BackgroundJobsService's redisConnection is created
      // LAZILY (only once getQueue() is first called), so simply booting
      // this second instance does not exercise it — the point here is
      // only to prove the listener is attached at construction, not to
      // also prove a live dispatch survives (that would risk hanging on
      // ioredis's own maxRetriesPerRequest:null "queue offline commands
      // forever" behavior against a host that will never come back,
      // which is a test-reliability concern, not a product one).
      const originalRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      let brokenCtx: E2eApp | undefined;
      try {
        brokenCtx = await bootstrapE2eApp();
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        process.env.REDIS_URL = originalRedisUrl;
        if (brokenCtx) {
          await brokenCtx.redis.quit().catch(() => undefined);
          await brokenCtx.app.close();
        }
      }
    }, 10_000);
  });

  describe("idempotency (Milestone 6)", () => {
    let idempotencyQueue: Queue;
    let idempotencyQueueConnection: Redis;

    beforeAll(() => {
      // Queue.close() does NOT close a connection passed in via `connection`
      // — BullMQ assumes an externally-supplied connection may be shared
      // with other Queue/Worker instances the caller owns, so closing it
      // is the caller's own responsibility. Not doing so here left a live
      // TCP socket open forever (found via --detectOpenHandles: a lone
      // TCPWRAP traced straight to this .duplicate() call), which is what
      // hung this exact suite — Jest was correctly reporting ALL tests as
      // finished, then waiting indefinitely for an event loop that never
      // emptied. Captured explicitly so afterAll can close it too.
      idempotencyQueueConnection = ctx.redis.duplicate();
      idempotencyQueue = new Queue(SYSTEM_PING_V1_MANIFEST.queue, {
        connection: idempotencyQueueConnection,
      });
    });

    afterAll(async () => {
      await idempotencyQueue.close();
      await idempotencyQueueConnection.quit();
    });

    it("sequential duplicate request: returns the same job, exactly one row and one QUEUED history entry exist", async () => {
      const key = `e2e-idem-seq-${randomUUID()}`;
      const payload = { echo: "sequential" };

      const first = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload,
        idempotencyKey: key,
      });
      const second = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload,
        idempotencyKey: key,
      });

      expect(second.id).toBe(first.id);

      const count = await ctx.prisma.backgroundJob.count({
        where: { workspaceId: workspaceInternalId, idempotencyKey: key },
      });
      expect(count).toBe(1);

      const history = await ctx.prisma.backgroundJobHistory.findMany({
        where: { backgroundJobId: first.id, toStatus: "QUEUED" },
      });
      expect(history).toHaveLength(1);
    });

    it("concurrent duplicate request: exactly one authoritative job is created and exactly one dispatch happens, never two", async () => {
      const key = `e2e-idem-concurrent-${randomUUID()}`;
      const payload = { echo: "concurrent" };
      const enqueueOnce = () =>
        backgroundJobs.enqueue({
          workspaceId: workspaceInternalId,
          jobType: "system.ping.v1",
          payload,
          idempotencyKey: key,
        });

      const [a, b] = await Promise.all([enqueueOnce(), enqueueOnce()]);
      expect(a.id).toBe(b.id);

      const count = await ctx.prisma.backgroundJob.count({
        where: { workspaceId: workspaceInternalId, idempotencyKey: key },
      });
      expect(count).toBe(1);

      // Exactly one logical dispatch: only one QUEUED-origin history row —
      // if both racing calls had each dispatched, this would be 2.
      const history = await ctx.prisma.backgroundJobHistory.findMany({
        where: { backgroundJobId: a.id, toStatus: "QUEUED" },
      });
      expect(history).toHaveLength(1);

      const bullJob = await idempotencyQueue.getJob(a.id);
      expect(bullJob).toBeDefined();
    });

    it("same idempotency key with a different payload returns a deterministic conflict (API-level cache-hit path), with no payload leaked in the error", async () => {
      const key = `e2e-idem-mismatch-cache-${randomUUID()}`;
      const secretMarkerA = `secret-a-${randomUUID()}`;
      const secretMarkerB = `secret-b-${randomUUID()}`;
      const original = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: secretMarkerA },
        idempotencyKey: key,
      });

      expect.assertions(6);
      try {
        await backgroundJobs.enqueue({
          workspaceId: workspaceInternalId,
          jobType: "system.ping.v1",
          payload: { echo: secretMarkerB },
          idempotencyKey: key,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const body = (error as ConflictException).getResponse() as {
          code: string;
          message: string;
        };
        expect(body.code).toBe("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(secretMarkerA);
        expect(serialized).not.toContain(secretMarkerB);
      }

      // Still exactly one row — the mismatched attempt never created a
      // second one, and never touched the original.
      const count = await ctx.prisma.backgroundJob.count({
        where: { workspaceId: workspaceInternalId, idempotencyKey: key },
      });
      expect(count).toBe(1);
      const unchanged = await ctx.prisma.backgroundJob.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect((unchanged.payloadMetadata as { echo?: string }).echo).toBe(
        secretMarkerA,
      );
    });

    it("same idempotency key with a different payload is caught at the Postgres level too, when the API-level cache misses", async () => {
      const key = `e2e-idem-mismatch-db-${randomUUID()}`;
      const first = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: "original" },
        idempotencyKey: key,
      });

      // Force a cache miss without touching Redis availability at all —
      // deleting the entry produces the exact same code path a Redis
      // outage would (checkIdempotencyCache fails open to null either
      // way), so this proves the DB-level check independently of the
      // API-level cache ever having seen this key.
      await ctx.redis.del(`bg-job-idem:${workspaceInternalId}:${key}`);

      expect.assertions(3);
      try {
        await backgroundJobs.enqueue({
          workspaceId: workspaceInternalId,
          jobType: "system.ping.v1",
          payload: { echo: "different" },
          idempotencyKey: key,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
        });
      }

      const count = await ctx.prisma.backgroundJob.count({
        where: { id: first.id },
      });
      expect(count).toBe(1);
    });

    it("the same idempotency key in two different workspaces creates two genuinely independent jobs", async () => {
      const otherWorkspace = await createWorkspaceAsOwner(
        ctx,
        ownerAccessToken,
      );
      const otherWorkspaceRow = await ctx.prisma.workspace.findUniqueOrThrow({
        where: { publicId: otherWorkspace.publicId },
      });

      const key = `e2e-idem-cross-ws-${randomUUID()}`;
      const payload = { echo: "cross-workspace" };
      const a = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload,
        idempotencyKey: key,
      });
      const b = await backgroundJobs.enqueue({
        workspaceId: otherWorkspaceRow.id,
        jobType: "system.ping.v1",
        payload,
        idempotencyKey: key,
      });

      expect(a.id).not.toBe(b.id);
      expect(a.workspaceId).toBe(workspaceInternalId);
      expect(b.workspaceId).toBe(otherWorkspaceRow.id);
    });

    it("BullMQ data already cleaned up: a replay still succeeds and returns the original row without needing the old BullMQ entry to still exist", async () => {
      const key = `e2e-idem-bullmq-cleaned-${randomUUID()}`;
      const payload = { echo: "cleanup" };
      const first = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload,
        idempotencyKey: key,
      });

      // Wait for the real, already-running Worker to actually finish it
      // first — removing a job BullMQ still considers active is a
      // different (and here, irrelevant) scenario; the one this test
      // means to simulate is age-based cleanup AFTER completion, which by
      // definition only ever runs once a job is done.
      await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        first.publicId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
      );

      // Simulate BullMQ's own removeOnComplete/removeOnFail age-based
      // cleanup having already run before the replay lands.
      await idempotencyQueue.remove(first.id);
      expect(await idempotencyQueue.getJob(first.id)).toBeUndefined();

      const second = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload,
        idempotencyKey: key,
      });
      expect(second.id).toBe(first.id);
    });

    it("Redis unavailable: database-level deduplication still works, and the call never hangs", async () => {
      const originalRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      let brokenCtx: E2eApp | undefined;
      try {
        brokenCtx = await bootstrapE2eApp();
        const brokenBackgroundJobs = brokenCtx.app.get(BackgroundJobsService);

        // Pre-seeded directly — exactly what a prior successful enqueue
        // (while Redis was healthy) would have produced — so the call
        // below hits the Postgres unique constraint and takes the replay
        // path, which never calls queue.add() at all (proven independently
        // by the "BullMQ data already cleaned up" case above). That is
        // exactly what makes it safe to exercise against a connection
        // that will never connect: only the FAIL-FAST idempotency cache
        // (maxRetriesPerRequest: 1, no reconnect) is on the path, never
        // the BullMQ producer connection (maxRetriesPerRequest: null,
        // which would hang indefinitely offline).
        const key = `e2e-idem-redis-down-${randomUUID()}`;
        const payload = { echo: "no-redis" };
        const preSeeded = await brokenCtx.prisma.backgroundJob.create({
          data: {
            workspaceId: workspaceInternalId,
            jobType: "system.ping.v1",
            queueName: "SYSTEM",
            payloadMetadata: payload,
            correlationId: randomUUID(),
            idempotencyKey: key,
          },
        });

        const replayed = await brokenBackgroundJobs.enqueue({
          workspaceId: workspaceInternalId,
          jobType: "system.ping.v1",
          payload,
          idempotencyKey: key,
        });
        expect(replayed.id).toBe(preSeeded.id);

        const count = await brokenCtx.prisma.backgroundJob.count({
          where: { id: preSeeded.id },
        });
        expect(count).toBe(1);
      } finally {
        process.env.REDIS_URL = originalRedisUrl;
        if (brokenCtx) {
          await brokenCtx.redis.quit().catch(() => undefined);
          await brokenCtx.app.close();
        }
      }
    }, 15_000);

    it("retry of the original job does not create a second logical job under the same idempotency key", async () => {
      const key = `e2e-idem-retry-${randomUUID()}`;
      const payload = { echo: "retry-me", delayMs: 2_500 };
      const created = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload,
        idempotencyKey: key,
      });

      await request(ctx.app.getHttpServer())
        .post(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/cancel`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["FAILED"],
      );

      await request(ctx.app.getHttpServer())
        .post(
          `/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/retry`,
        )
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);

      // A subsequent enqueue() with the SAME key must still resolve to
      // the SAME row (now mid-retry), never create a new one.
      const replayed = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload,
        idempotencyKey: key,
      });
      expect(replayed.id).toBe(created.id);

      const count = await ctx.prisma.backgroundJob.count({
        where: { id: created.id },
      });
      expect(count).toBe(1);

      await waitForStatus(
        ctx,
        workspace.publicId,
        ownerAccessToken,
        created.publicId,
        ["COMPLETED", "FAILED", "TIMED_OUT"],
      );
    });

    /**
     * DEFECT-1F-003: `@@unique([workspaceId, idempotencyKey])` (a single,
     * non-partial constraint) does NOT deduplicate rows where
     * workspaceId IS NULL — standard SQL NULL semantics mean NULL is never
     * equal to NULL — silently disabling idempotency for exactly the
     * schema's own documented "genuine platform-level system job" state.
     * Fixed by replacing it with two explicit PARTIAL unique indexes
     * (background_jobs_workspace_idempotency_unique WHERE workspaceId IS
     * NOT NULL, background_jobs_platform_idempotency_unique ON
     * (idempotencyKey) WHERE workspaceId IS NULL) — see migration
     * 20260806180000_defect_1f003_platform_idempotency and
     * BackgroundJobsService.isExpectedIdempotencyViolation's doc comment
     * for the exact `error.meta.target` shape each index produces.
     */
    describe("DEFECT-1F-003: platform-level idempotency (workspaceId: null)", () => {
      it("1/6/7: sequential platform-level duplicate submission — one row, one dispatch", async () => {
        const key = `e2e-idem-platform-seq-${randomUUID()}`;
        const payload = { echo: "platform-sequential" };

        const first = await backgroundJobs.enqueue({
          workspaceId: null,
          jobType: "system.ping.v1",
          payload,
          idempotencyKey: key,
        });
        const second = await backgroundJobs.enqueue({
          workspaceId: null,
          jobType: "system.ping.v1",
          payload,
          idempotencyKey: key,
        });

        expect(second.id).toBe(first.id);
        expect(first.workspaceId).toBeNull();

        const count = await ctx.prisma.backgroundJob.count({
          where: { workspaceId: null, idempotencyKey: key },
        });
        expect(count).toBe(1);

        const history = await ctx.prisma.backgroundJobHistory.findMany({
          where: { backgroundJobId: first.id, toStatus: "QUEUED" },
        });
        expect(history).toHaveLength(1);
      });

      it("2/6/7: concurrent platform-level duplicate submission — exactly one authoritative job, exactly one dispatch", async () => {
        const key = `e2e-idem-platform-concurrent-${randomUUID()}`;
        const payload = { echo: "platform-concurrent" };
        const enqueueOnce = () =>
          backgroundJobs.enqueue({
            workspaceId: null,
            jobType: "system.ping.v1",
            payload,
            idempotencyKey: key,
          });

        const [a, b] = await Promise.all([enqueueOnce(), enqueueOnce()]);
        expect(a.id).toBe(b.id);

        const count = await ctx.prisma.backgroundJob.count({
          where: { workspaceId: null, idempotencyKey: key },
        });
        expect(count).toBe(1);

        const history = await ctx.prisma.backgroundJobHistory.findMany({
          where: { backgroundJobId: a.id, toStatus: "QUEUED" },
        });
        expect(history).toHaveLength(1);

        const bullJob = await idempotencyQueue.getJob(a.id);
        expect(bullJob).toBeDefined();
      });

      it("3: same platform-level key with a different payload returns a deterministic conflict, no payload leaked", async () => {
        const key = `e2e-idem-platform-mismatch-${randomUUID()}`;
        const original = await backgroundJobs.enqueue({
          workspaceId: null,
          jobType: "system.ping.v1",
          payload: { echo: "platform-original" },
          idempotencyKey: key,
        });

        // Force a cache miss, exactly like the workspace-scoped mismatch
        // test above — proves the Postgres-level (partial index) check
        // independently of the API-level Redis cache.
        await ctx.redis.del(`bg-job-idem:platform:${key}`);

        expect.assertions(4);
        try {
          await backgroundJobs.enqueue({
            workspaceId: null,
            jobType: "system.ping.v1",
            payload: { echo: "platform-different" },
            idempotencyKey: key,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(ConflictException);
          expect((error as ConflictException).getResponse()).toMatchObject({
            code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
          });
        }

        const count = await ctx.prisma.backgroundJob.count({
          where: { workspaceId: null, idempotencyKey: key },
        });
        expect(count).toBe(1);
        const unchanged = await ctx.prisma.backgroundJob.findUniqueOrThrow({
          where: { id: original.id },
        });
        expect((unchanged.payloadMetadata as { echo?: string }).echo).toBe(
          "platform-original",
        );
      });

      it("4: the same idempotency key at platform scope and inside a workspace are independent, both allowed", async () => {
        const key = `e2e-idem-platform-vs-workspace-${randomUUID()}`;
        const payload = { echo: "platform-vs-workspace" };

        const platformJob = await backgroundJobs.enqueue({
          workspaceId: null,
          jobType: "system.ping.v1",
          payload,
          idempotencyKey: key,
        });
        const workspaceJob = await backgroundJobs.enqueue({
          workspaceId: workspaceInternalId,
          jobType: "system.ping.v1",
          payload,
          idempotencyKey: key,
        });

        expect(platformJob.id).not.toBe(workspaceJob.id);
        expect(platformJob.workspaceId).toBeNull();
        expect(workspaceJob.workspaceId).toBe(workspaceInternalId);
      });

      it("5: the same key across two different (non-null) workspaces remains independent under the new partial index", async () => {
        const otherWorkspace = await createWorkspaceAsOwner(
          ctx,
          ownerAccessToken,
        );
        const otherWorkspaceRow = await ctx.prisma.workspace.findUniqueOrThrow({
          where: { publicId: otherWorkspace.publicId },
        });

        const key = `e2e-idem-defect1f003-cross-ws-${randomUUID()}`;
        const payload = { echo: "defect-1f-003-cross-workspace" };
        const a = await backgroundJobs.enqueue({
          workspaceId: workspaceInternalId,
          jobType: "system.ping.v1",
          payload,
          idempotencyKey: key,
        });
        const b = await backgroundJobs.enqueue({
          workspaceId: otherWorkspaceRow.id,
          jobType: "system.ping.v1",
          payload,
          idempotencyKey: key,
        });

        expect(a.id).not.toBe(b.id);
      });

      it("8: Redis unavailable — platform-level Postgres dedup still works, and the call never hangs", async () => {
        const originalRedisUrl = process.env.REDIS_URL;
        process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
        let brokenCtx: E2eApp | undefined;
        try {
          brokenCtx = await bootstrapE2eApp();
          const brokenBackgroundJobs = brokenCtx.app.get(BackgroundJobsService);

          const key = `e2e-idem-platform-redis-down-${randomUUID()}`;
          const payload = { echo: "platform-no-redis" };
          const preSeeded = await brokenCtx.prisma.backgroundJob.create({
            data: {
              workspaceId: null,
              jobType: "system.ping.v1",
              queueName: "SYSTEM",
              payloadMetadata: payload,
              correlationId: randomUUID(),
              idempotencyKey: key,
            },
          });

          const replayed = await brokenBackgroundJobs.enqueue({
            workspaceId: null,
            jobType: "system.ping.v1",
            payload,
            idempotencyKey: key,
          });
          expect(replayed.id).toBe(preSeeded.id);

          const count = await brokenCtx.prisma.backgroundJob.count({
            where: { id: preSeeded.id },
          });
          expect(count).toBe(1);
        } finally {
          process.env.REDIS_URL = originalRedisUrl;
          if (brokenCtx) {
            await brokenCtx.redis.quit().catch(() => undefined);
            await brokenCtx.app.close();
          }
        }
      }, 15_000);

      it("9: a direct SQL duplicate insert at platform scope is rejected by Postgres itself", async () => {
        const key = `e2e-idem-platform-raw-sql-${randomUUID()}`;
        await ctx.prisma.backgroundJob.create({
          data: {
            workspaceId: null,
            jobType: "system.ping.v1",
            queueName: "SYSTEM",
            payloadMetadata: {},
            correlationId: randomUUID(),
            idempotencyKey: key,
          },
        });

        // Prisma's $executeRaw wraps the raw Postgres error and does not
        // echo the violated constraint's NAME in the surfaced message
        // (only the column and value) — verified empirically. The
        // constraint's identity is instead confirmed independently by
        // test 10's own pg_indexes catalog check; this assertion confirms
        // Postgres genuinely rejects the insert (code 23505) on the
        // idempotency_key column specifically.
        expect.assertions(3);
        try {
          await ctx.prisma.$executeRaw`
            INSERT INTO background_jobs (id, public_id, workspace_id, job_type, queue_name, status, payload_metadata, attempts, max_attempts, idempotency_key, correlation_id, created_at, updated_at)
            VALUES (gen_random_uuid(), gen_random_uuid(), NULL, 'system.ping.v1', 'SYSTEM', 'QUEUED', '{}', 0, 3, ${key}, gen_random_uuid()::text, now(), now())
          `;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toContain("Code: `23505`");
          expect(message).toContain(`Key (idempotency_key)=(${key}) already exists`);
        }

        const count = await ctx.prisma.backgroundJob.count({
          where: { workspaceId: null, idempotencyKey: key },
        });
        expect(count).toBe(1);
      });

      it("10: Postgres catalog confirms both partial unique indexes exist with the exact expected predicates", async () => {
        const rows = await ctx.prisma.$queryRaw<
          { indexname: string; indexdef: string }[]
        >`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'background_jobs' AND indexname LIKE '%idempotency%'
        ORDER BY indexname
      `;

        expect(rows).toHaveLength(2);

        const platform = rows.find(
          (r) => r.indexname === "background_jobs_platform_idempotency_unique",
        );
        expect(platform).toBeDefined();
        expect(platform?.indexdef).toContain(
          "UNIQUE INDEX background_jobs_platform_idempotency_unique ON public.background_jobs USING btree (idempotency_key)",
        );
        expect(platform?.indexdef).toContain(
          "WHERE ((workspace_id IS NULL) AND (idempotency_key IS NOT NULL))",
        );

        const workspaceScoped = rows.find(
          (r) => r.indexname === "background_jobs_workspace_idempotency_unique",
        );
        expect(workspaceScoped).toBeDefined();
        expect(workspaceScoped?.indexdef).toContain(
          "UNIQUE INDEX background_jobs_workspace_idempotency_unique ON public.background_jobs USING btree (workspace_id, idempotency_key)",
        );
        expect(workspaceScoped?.indexdef).toContain(
          "WHERE ((workspace_id IS NOT NULL) AND (idempotency_key IS NOT NULL))",
        );

        // The old, non-partial composite constraint must genuinely be gone —
        // not just renamed — or the defect isn't actually fixed.
        const stale = await ctx.prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE indexname = 'background_jobs_workspace_id_idempotency_key_key'
      `;
        expect(stale).toHaveLength(0);
      });
    });
  });
});
