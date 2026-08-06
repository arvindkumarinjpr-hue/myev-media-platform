import { BadRequestException } from "@nestjs/common";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";
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
      throw new Error(`job ${jobPublicId} did not reach status ${statuses.join("/")} within ${timeoutMs}ms — last seen: ${job.status}`);
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
    const ws = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: workspace.publicId } });
    workspaceInternalId = ws.id;
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  describe("enqueue() — internal service method, no HTTP surface in Module 1F", () => {
    it("rejects an unregistered job type", async () => {
      await expect(backgroundJobs.enqueue({ workspaceId: workspaceInternalId, jobType: "not.a.real.job.v1", payload: {} })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("rejects a payload that fails class-validator validation", async () => {
      await expect(backgroundJobs.enqueue({ workspaceId: workspaceInternalId, jobType: "system.ping.v1", payload: { echo: 12345 } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("full lifecycle: enqueue -> real Worker execution -> COMPLETED", () => {
    it("runs system.ping.v1 to completion with a correct job_history trail", async () => {
      const created = await backgroundJobs.enqueue({
        workspaceId: workspaceInternalId,
        jobType: "system.ping.v1",
        payload: { echo: "e2e-api" },
      });

      const job = await waitForStatus(ctx, workspace.publicId, ownerAccessToken, created.publicId, ["COMPLETED", "FAILED", "TIMED_OUT"]);

      expect(job.status).toBe("COMPLETED");
      expect(job.resultMetadata?.echo).toBe("e2e-api");
      expect(job.processorVersion).toBeTruthy();
      expect(job.attempts).toBe(1);

      const history = await ctx.prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: created.id }, orderBy: { occurredAt: "asc" } });
      expect(history.map((h) => h.toStatus)).toEqual(["QUEUED", "RUNNING", "COMPLETED"]);
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
      expect(jobs.every((j) => j.status === "COMPLETED" && j.jobType === "system.ping.v1")).toBe(true);
    });

    it("idempotency key: a replayed enqueue with the same key returns the original row, not a duplicate", async () => {
      const key = `e2e-idem-${Date.now()}`;
      const first = await backgroundJobs.enqueue({ workspaceId: workspaceInternalId, jobType: "system.ping.v1", payload: { echo: "once" }, idempotencyKey: key });
      const second = await backgroundJobs.enqueue({ workspaceId: workspaceInternalId, jobType: "system.ping.v1", payload: { echo: "once" }, idempotencyKey: key });
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
        .post(`/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/cancel`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      expect((cancelRes.body.data as JobResponse).cancellationRequestedAt).toBeTruthy();

      const job = await waitForStatus(ctx, workspace.publicId, ownerAccessToken, created.publicId, ["COMPLETED", "FAILED", "TIMED_OUT"]);
      expect(job.status).toBe("FAILED");
      expect(job.errorCode).toBe("JOB_CANCELLED_BY_USER");
      expect(job.cancelledAt).toBeTruthy();

      const auditRow = await ctx.prisma.auditLog.findFirst({
        where: { action: "JOB_CANCELLATION_REQUESTED", entityId: created.publicId, workspaceId: workspaceInternalId },
      });
      expect(auditRow).not.toBeNull();
    });

    it("rejects cancelling a job that has already finished", async () => {
      const created = await backgroundJobs.enqueue({ workspaceId: workspaceInternalId, jobType: "system.ping.v1", payload: {} });
      await waitForStatus(ctx, workspace.publicId, ownerAccessToken, created.publicId, ["COMPLETED", "FAILED", "TIMED_OUT"]);

      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/cancel`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(409);
      expect(res.body.code).toBe("JOB_ALREADY_TERMINAL");
    });

    it("404s for an unknown job id", async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${workspace.publicId}/background-jobs/00000000-0000-0000-0000-000000000000`)
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
        .post(`/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/cancel`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      const cancelled = await waitForStatus(ctx, workspace.publicId, ownerAccessToken, created.publicId, ["FAILED"]);
      expect(cancelled.errorCode).toBe("JOB_CANCELLED_BY_USER");

      const retryRes = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/retry`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(201);
      expect((retryRes.body.data as JobResponse).status).toBe("QUEUED");

      const completed = await waitForStatus(ctx, workspace.publicId, ownerAccessToken, created.publicId, ["COMPLETED", "FAILED", "TIMED_OUT"]);
      expect(completed.status).toBe("COMPLETED");
      expect(completed.attempts).toBe(2);

      const auditRow = await ctx.prisma.auditLog.findFirst({ where: { action: "JOB_RETRY_REQUESTED", entityId: created.publicId, workspaceId: workspaceInternalId } });
      expect(auditRow).not.toBeNull();
    });

    it("rejects retrying a job that is not in a terminal FAILED/TIMED_OUT state", async () => {
      const created = await backgroundJobs.enqueue({ workspaceId: workspaceInternalId, jobType: "system.ping.v1", payload: {} });
      await waitForStatus(ctx, workspace.publicId, ownerAccessToken, created.publicId, ["COMPLETED"]);

      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${workspace.publicId}/background-jobs/${created.publicId}/retry`)
        .set("Authorization", `Bearer ${ownerAccessToken}`)
        .set("X-Workspace-Id", workspace.publicId)
        .expect(409);
      expect(res.body.code).toBe("JOB_NOT_RETRYABLE_IN_CURRENT_STATE");
    });
  });
});
