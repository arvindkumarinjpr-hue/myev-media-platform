import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { FixturePublishingChannelProvider, PublishingProviderRegistryBuilder, type PublishingPublishInput } from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import { AppModule } from "../src/app.module";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/publishing/publishing-provider-registry.module";
import { PublishingCredentialCryptoService } from "../src/publishing/publishing-credential-crypto.service";
import { PublishingDispatchProcessor } from "../src/queue/processors/publishing-dispatch.processor";
import { SchedulerTickManager } from "../src/scheduler/scheduler-tick.manager";
import type { ContentItemStatus, ContentType, ScheduledJob } from "../../api/generated/prisma";

/**
 * Module 9 Phase 9.3 Pre-Merge Correction — proves the actual Publishing
 * scheduler handoff: SchedulerTickManager -> a due publishing.dispatch.v1
 * ScheduledJob occurrence -> PublishingDispatchProcessor -> PublicationTarget
 * SCHEDULED -> QUEUED -> a durable publishing.execute.v1 BackgroundJob.
 * The generic tick/claim/idempotency mechanics themselves are already
 * proven by scheduler-tick.e2e-spec.ts (unmodified) — this suite proves
 * only the Publishing-specific wiring on top of it.
 *
 * Uses SchedulerTickManager's own real (private, direct-invocation)
 * claimDueSchedules()/dispatchOccurrence() — the exact same accepted
 * technique scheduler-tick.e2e-spec.ts's own runTick() helper already
 * uses — for deterministic, fast control over "when a tick fires,"
 * without waiting on the real repeatable-job interval.
 *
 * PublishingDispatchProcessor.handle() is invoked directly on the real,
 * DI-resolved instance (mirroring ai-execute.e2e-spec.ts's own
 * established "direct invocation proves the processor's own logic
 * deterministically" precedent) rather than relying on genuine BullMQ
 * delivery: this process may or may not have a live Worker actually
 * consuming the PUBLISHING queue depending on which other e2e-spec
 * files already ran in the same Jest worker process (WORKER_QUEUES is
 * process-global env, and other files in this same suite set it to
 * include PUBLISHING) — direct invocation of the real processor proves
 * the exact same handoff logic without depending on, or racing against,
 * whatever a concurrently-running live Worker in this same process
 * might independently be doing to the same rows.
 */
describe("Worker (e2e) — Module 9 Phase 9.3 Publishing scheduler integration", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM,AI,PUBLISHING";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let scheduler: SchedulerTickManager;
  let dispatchProcessor: PublishingDispatchProcessor;
  let crypto: PublishingCredentialCryptoService;

  // WORKER_QUEUES includes PUBLISHING for this process, so a real,
  // independently-running BullMqWorkerManager also consumes
  // publishing.execute.v1 jobs in the background as soon as this test's
  // own direct dispatchProcessor.handle() calls create them — including,
  // eventually, jobs created by an EARLIER test in this same file. A
  // single shared call counter would therefore leak across test cases
  // (confirmed live: the third test observed a call attributable to the
  // first test's own target, processed asynchronously in between). Calls
  // are tracked per-target instead, parsed from the deterministic
  // `publishing:{targetPublicId}:attempt:{n}` operationToken
  // PublishingExecutionService itself constructs, so each test only ever
  // inspects the count for its OWN target.
  const publishCallsByTargetPublicId = new Map<string, number>();
  function publishCallCountFor(targetPublicId: string): number {
    return publishCallsByTargetPublicId.get(targetPublicId) ?? 0;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PUBLISHING_PROVIDER_REGISTRY)
      .useFactory({
        factory: () => {
          const builder = new PublishingProviderRegistryBuilder();
          builder.register(
            new FixturePublishingChannelProvider({
              channelType: "WORDPRESS",
              capabilities: { supportedContentTypes: ["BLOG"], requiresRenderedMedia: false },
              resolvePublishOutcome: (input: PublishingPublishInput) => {
                const match = /^publishing:([^:]+):attempt:/.exec(input.operationToken);
                if (match) {
                  publishCallsByTargetPublicId.set(match[1], publishCallCountFor(match[1]) + 1);
                }
                return "success";
              },
            }),
          );
          return builder.freeze();
        },
      })
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    scheduler = moduleRef.get(SchedulerTickManager);
    dispatchProcessor = moduleRef.get(PublishingDispatchProcessor);
    crypto = moduleRef.get(PublishingCredentialCryptoService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  function claimDueSchedules(): Promise<Array<{ schedule: ScheduledJob; dueOccurrence: Date }>> {
    return (scheduler as unknown as { claimDueSchedules: () => Promise<Array<{ schedule: ScheduledJob; dueOccurrence: Date }>> }).claimDueSchedules();
  }

  function dispatchOccurrence(occurrence: { schedule: ScheduledJob; dueOccurrence: Date }, correlationId: string): Promise<boolean> {
    return (scheduler as unknown as { dispatchOccurrence: (o: { schedule: ScheduledJob; dueOccurrence: Date }, c: string) => Promise<boolean> }).dispatchOccurrence(occurrence, correlationId);
  }

  interface Workspace {
    id: string;
    publicId: string;
  }

  async function createTestWorkspace(): Promise<Workspace & { userId: string }> {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `publishing-sched-test-${suffix}@example.invalid`, fullName: "Publishing Scheduler Test User", status: "ACTIVE" } });
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: `Publishing Sched Test WS ${suffix}`, slug: `publishing-sched-test-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { id: workspace.id, publicId: workspace.publicId, userId: user.id };
  }

  /** Mirrors publishing-execution.e2e-spec.ts's own helper — the deferred current_version_id trigger requires the create+version+link to be one transaction. */
  async function createContentItemWithVersion(ws: Workspace, userId: string, overrides: Partial<{ contentType: ContentType; title: string; status: ContentItemStatus }> = {}): Promise<{ id: string; publicId: string }> {
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.contentItem.create({
        data: { workspaceId: ws.id, contentType: overrides.contentType ?? "BLOG", title: overrides.title ?? `Fixture ${randomUUID()}`, status: overrides.status ?? "DRAFT", createdById: userId },
      });
      const version = await tx.contentVersion.create({ data: { contentItemId: created.id, versionNumber: 1, body: { content: "fixture" }, createdById: userId } });
      return tx.contentItem.update({ where: { id: created.id }, data: { currentVersionId: version.id } });
    });
    return { id: item.id, publicId: item.publicId };
  }

  async function createReadyBlogContentItem(ws: Workspace, userId: string): Promise<{ id: string; publicId: string }> {
    const suffix = randomUUID();
    const item = await createContentItemWithVersion(ws, userId, { contentType: "BLOG", title: `Ready blog ${suffix}`, status: "APPROVED" });
    await prisma.blogArticle.create({
      data: { workspaceId: ws.id, contentItemId: item.id, metaTitle: "Fixture title", metaDescription: "Fixture description", urlSlug: `fixture-${suffix}`, schemaMarkup: {}, createdById: userId },
    });
    return item;
  }

  async function createChannelAccount(ws: Workspace, userId: string): Promise<{ id: string; publicId: string }> {
    const encrypted = crypto.encrypt({ apiKey: `fixture-secret-${randomUUID()}` });
    const credential = await prisma.channelCredential.create({ data: { workspaceId: ws.id, ...encrypted } });
    const account = await prisma.publishingChannelAccount.create({
      data: { workspaceId: ws.id, channelType: "WORDPRESS", displayName: "Fixture WordPress", externalAccountId: `ext-${credential.id}`, credentialId: credential.id, connectedById: userId },
    });
    return { id: account.id, publicId: account.publicId };
  }

  /** Mirrors PublishingPersistenceService.createPublication()'s own scheduling branch (apps/api) — reproduced directly via Prisma here since apps/worker cannot import apps/api services. */
  async function createScheduledTarget(ws: Workspace, userId: string, contentItemId: string, channelAccountId: string, nextRunAt: Date) {
    const publication = await prisma.publication.create({ data: { workspaceId: ws.id, contentItemId, requestedById: userId, scheduledFor: nextRunAt } });
    const target = await prisma.publicationTarget.create({
      data: { workspaceId: ws.id, publicationId: publication.id, contentItemId, channelAccountId, status: "SCHEDULED", idempotencyKey: `publish:${publication.publicId}:${randomUUID()}` },
    });
    const scheduledJob = await prisma.scheduledJob.create({
      data: {
        workspaceId: ws.id,
        jobType: "publishing.dispatch.v1",
        payloadMetadata: { workspacePublicId: ws.publicId, publicationTargetPublicId: target.publicId },
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        nextRunAt,
      },
    });
    return { target, scheduledJob };
  }

  function processorContext(attempt = 1) {
    return { jobId: randomUUID(), correlationId: randomUUID(), attempt, isCancelled: async () => false };
  }

  describe("due schedule", () => {
    it("proves the full handoff: tick claims once, dispatch job is created, the real processor transitions SCHEDULED -> QUEUED and creates exactly one publishing.execute.v1 job", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const channel = await createChannelAccount(ws, ws.userId);
      const { target, scheduledJob } = await createScheduledTarget(ws, ws.userId, item.id, channel.id, new Date(Date.now() - 60_000));

      // 1. Real SchedulerTickManager claim — SELECT ... FOR UPDATE SKIP
      // LOCKED, recomputes nextRunAt fresh, bumps lastRunAt.
      const claimed = await claimDueSchedules();
      const ourOccurrence = claimed.find((c) => c.schedule.id === scheduledJob.id);
      expect(ourOccurrence).toBeDefined();

      const refreshedSchedule = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: scheduledJob.id } });
      expect(refreshedSchedule.lastRunAt).not.toBeNull();
      expect(refreshedSchedule.nextRunAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);

      // 2. Real dispatchOccurrence — creates + enqueues the
      // publishing.dispatch.v1 BackgroundJob via real BullMQ .add().
      const dispatched = await dispatchOccurrence(ourOccurrence!, randomUUID());
      expect(dispatched).toBe(true);

      const dispatchJobs = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.dispatch.v1" } });
      expect(dispatchJobs).toHaveLength(1);
      expect(dispatchJobs[0].payloadMetadata).toEqual({ workspacePublicId: ws.publicId, publicationTargetPublicId: target.publicId });

      // No provider call has happened purely from the scheduler's own
      // claim+dispatch — it never resolves a provider at all.
      expect(publishCallCountFor(target.publicId)).toBe(0);

      // 3. The real, DI-resolved PublishingDispatchProcessor — the
      // actual handoff: PublicationTarget SCHEDULED -> QUEUED + a new
      // publishing.execute.v1 BackgroundJob. Direct invocation (see this
      // file's own doc comment for why) — genuinely the same processor
      // instance/code a live BullMQ delivery would call.
      const result = await dispatchProcessor.handle(
        { workspacePublicId: ws.publicId, publicationTargetPublicId: target.publicId },
        processorContext(1),
      );
      expect(result.publicationTargetPublicId).toBe(target.publicId);

      const afterTarget = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(afterTarget.status).toBe("QUEUED");

      const executeJobs = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(executeJobs).toHaveLength(1);
      expect(executeJobs[0].payloadMetadata).toEqual({ workspacePublicId: ws.publicId, publicationTargetPublicId: target.publicId });
      // Safe identifiers only — never a credential, content body, or media.
      expect(Object.keys(executeJobs[0].payloadMetadata as object).sort()).toEqual(["publicationTargetPublicId", "workspacePublicId"]);

      // The dispatch stage itself (claim + tick-level dispatch + the
      // real processor handoff) never called the provider — only a
      // later, separate execution stage ever would.
      expect(publishCallCountFor(target.publicId)).toBe(0);

      const contentItemAfter = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id }, select: { status: true } });
      expect(contentItemAfter.status).toBe("APPROVED");
    });
  });

  describe("duplicate tick / replay safety", () => {
    it("a second claim+dispatch of the identical due occurrence creates no second dispatch job; a redelivered processor call creates no second execute job", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const channel = await createChannelAccount(ws, ws.userId);
      const { target, scheduledJob } = await createScheduledTarget(ws, ws.userId, item.id, channel.id, new Date(Date.now() - 60_000));

      const claimed = await claimDueSchedules();
      const occurrence = claimed.find((c) => c.schedule.id === scheduledJob.id)!;
      const correlationId = randomUUID();

      const first = await dispatchOccurrence(occurrence, correlationId);
      const second = await dispatchOccurrence(occurrence, correlationId);
      expect(first).toBe(true);
      expect(second).toBe(false); // replay, not a new dispatch — scheduler occurrence idempotency

      const dispatchJobs = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.dispatch.v1" } });
      expect(dispatchJobs).toHaveLength(1);

      // First real handoff.
      await dispatchProcessor.handle({ workspacePublicId: ws.publicId, publicationTargetPublicId: target.publicId }, processorContext(1));
      const afterFirst = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(afterFirst.status).toBe("QUEUED");
      const executeJobsAfterFirst = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(executeJobsAfterFirst).toHaveLength(1);

      // A redelivered dispatch job (BullMQ at-least-once semantics) —
      // the target is no longer SCHEDULED, so the domain guard makes
      // this a safe no-op, never a second execution job, never a thrown
      // error, never a weakened DB/BackgroundJob idempotency constraint.
      await dispatchProcessor.handle({ workspacePublicId: ws.publicId, publicationTargetPublicId: target.publicId }, processorContext(2));
      const afterSecond = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(afterSecond.status).toBe("QUEUED");
      const executeJobsAfterSecond = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(executeJobsAfterSecond).toHaveLength(1);
    });
  });

  describe("cancelled schedule", () => {
    // A generic disabled ScheduledJob is already proven, generically,
    // never to be claimed (claimDueSchedules()'s own `WHERE enabled =
    // true` — exercised by scheduler-tick.e2e-spec.ts's own auto-disable
    // tests). This case adds only the Publishing-specific fact:
    // cancellation (PublishingDispatchService.cancelTarget(), apps/api)
    // sets the associated ScheduledJob.enabled = false — reproduced
    // directly via Prisma here (apps/worker cannot import the apps/api
    // service) since the point is to prove the CONSEQUENCE of that
    // state, not re-derive cancelTarget() itself (already covered by
    // apps/api's own publishing-dispatch.e2e-spec.ts).
    it("a cancelled target's disabled schedule is never claimed — no execute job, target stays CANCELLED, provider never called", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const channel = await createChannelAccount(ws, ws.userId);
      const { target, scheduledJob } = await createScheduledTarget(ws, ws.userId, item.id, channel.id, new Date(Date.now() - 60_000));

      await prisma.publicationTarget.update({ where: { id: target.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      await prisma.scheduledJob.update({ where: { id: scheduledJob.id }, data: { enabled: false } });

      const claimed = await claimDueSchedules();
      expect(claimed.some((c) => c.schedule.id === scheduledJob.id)).toBe(false);

      const dispatchJobs = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.dispatch.v1" } });
      expect(dispatchJobs).toHaveLength(0);
      const executeJobs = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(executeJobs).toHaveLength(0);

      const stillCancelled = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(stillCancelled.status).toBe("CANCELLED");
      expect(publishCallCountFor(target.publicId)).toBe(0);
    });
  });
});
