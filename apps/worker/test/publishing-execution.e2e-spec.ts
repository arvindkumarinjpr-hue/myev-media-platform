import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { FixturePublishingChannelProvider, PublishingProviderRegistryBuilder, derivePublicationSummary, type FixturePublishOutcome, type PublishingPublishInput } from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import { AppModule } from "../src/app.module";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/publishing/publishing-provider-registry.module";
import { PublishingCredentialCryptoService } from "../src/publishing/publishing-credential-crypto.service";
import { PublishingDispatchService } from "../src/publishing/publishing-dispatch.service";
import { PublishingExecutionService } from "../src/publishing/publishing-execution.service";
import type { ContentItemStatus, ContentType, PublicationTarget } from "../../api/generated/prisma";

/**
 * Module 9 Phase 9.3 — proves the durable publish execution pipeline
 * against real Postgres, mirroring ai-execute.e2e-spec.ts's own
 * established precedent: services are resolved from the REAL bootstrapped
 * DI container and invoked directly (not round-tripped through a real
 * BullMQ job) — what this suite needs to prove is
 * PublishingExecutionService/PublishingDispatchService's own lifecycle/
 * readiness/idempotency/security logic, which direct invocation proves
 * deterministically and fast; BullMQ's own retry-scheduling mechanics are
 * already proven generically by retry-dead-letter.e2e-spec.ts.
 *
 * PUBLISHING_PROVIDER_REGISTRY is overridden with two fixture providers
 * (WORDPRESS/BLOG, YOUTUBE/VIDEO) whose publish() outcome is controlled
 * per-target via `outcomeByTargetPublicId`, keyed by parsing the
 * deterministic `publishing:{targetPublicId}:attempt:{n}` operationToken
 * PublishingExecutionService itself constructs.
 */
describe("Worker (e2e) — Module 9 Phase 9.3 durable publish execution", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM,AI,PUBLISHING";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let execution: PublishingExecutionService;
  let dispatch: PublishingDispatchService;
  let crypto: PublishingCredentialCryptoService;

  const outcomeByTargetPublicId = new Map<string, FixturePublishOutcome>();
  const publishCallsByTargetPublicId = new Map<string, number>();

  function resolvePublishOutcome(input: PublishingPublishInput): FixturePublishOutcome {
    for (const [targetPublicId, outcome] of outcomeByTargetPublicId) {
      if (input.operationToken.startsWith(`publishing:${targetPublicId}:`)) {
        publishCallsByTargetPublicId.set(targetPublicId, (publishCallsByTargetPublicId.get(targetPublicId) ?? 0) + 1);
        return outcome;
      }
    }
    return "success";
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PUBLISHING_PROVIDER_REGISTRY)
      .useFactory({
        factory: () => {
          const builder = new PublishingProviderRegistryBuilder();
          builder.register(new FixturePublishingChannelProvider({ channelType: "WORDPRESS", capabilities: { supportedContentTypes: ["BLOG"], requiresRenderedMedia: false }, resolvePublishOutcome }));
          builder.register(new FixturePublishingChannelProvider({ channelType: "YOUTUBE", capabilities: { supportedContentTypes: ["VIDEO"], requiresRenderedMedia: true }, resolvePublishOutcome }));
          return builder.freeze();
        },
      })
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    execution = moduleRef.get(PublishingExecutionService);
    dispatch = moduleRef.get(PublishingDispatchService);
    crypto = moduleRef.get(PublishingCredentialCryptoService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  interface Workspace {
    id: string;
    publicId: string;
  }

  async function createTestWorkspace(): Promise<Workspace & { userId: string }> {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `publishing-exec-test-${suffix}@example.invalid`, fullName: "Publishing Exec Test User", status: "ACTIVE" } });
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: `Publishing Exec Test WS ${suffix}`, slug: `publishing-exec-test-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { id: workspace.id, publicId: workspace.publicId, userId: user.id };
  }

  /** A deferred DB trigger requires every non-deleted ContentItem to have a currentVersionId at commit — apps/api's own HTTP layer creates the ContentVersion + link atomically; this worker test has no HTTP layer, so it does the same two-step create directly (discovered live in Phase 9.2, see publishing-readiness.service.ts's own doc comment). */
  async function createContentItemWithVersion(ws: Workspace, userId: string, overrides: Partial<{ contentType: ContentType; title: string; status: ContentItemStatus }> = {}): Promise<{ id: string; publicId: string }> {
    // The deferred trigger fires at COMMIT — a bare create() auto-commits
    // as its own single-statement transaction, firing the trigger before
    // the version link ever happens. All three writes must be one
    // transaction, exactly like apps/api's own HTTP layer does it.
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
    return { id: item.id, publicId: item.publicId };
  }

  async function createChannelAccount(ws: Workspace, userId: string, channelType: "WORDPRESS" | "YOUTUBE" = "WORDPRESS"): Promise<{ id: string; publicId: string }> {
    const encrypted = crypto.encrypt({ apiKey: `fixture-secret-${randomUUID()}` });
    const credential = await prisma.channelCredential.create({ data: { workspaceId: ws.id, ...encrypted } });
    const account = await prisma.publishingChannelAccount.create({
      data: { workspaceId: ws.id, channelType, displayName: `Fixture ${channelType}`, externalAccountId: `ext-${credential.id}`, credentialId: credential.id, connectedById: userId },
    });
    return { id: account.id, publicId: account.publicId };
  }

  /** Direct-Prisma fixture insert of a QUEUED PublicationTarget — mirrors apps/api's own e2e convention of resolving fixtures directly via Prisma rather than a full HTTP round trip. */
  async function createQueuedTarget(ws: Workspace, userId: string, contentItemId: string, channelAccountId: string): Promise<PublicationTarget> {
    const publication = await prisma.publication.create({ data: { workspaceId: ws.id, contentItemId, requestedById: userId } });
    return prisma.publicationTarget.create({
      data: { workspaceId: ws.id, publicationId: publication.id, contentItemId, channelAccountId, status: "QUEUED", idempotencyKey: `publish:${publication.publicId}:${randomUUID()}` },
    });
  }

  describe("execution — success", () => {
    it("QUEUED -> PUBLISHING -> PUBLISHED, one PublishAttempt with the safe result, external id/url persisted", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const channel = await createChannelAccount(ws, ws.userId, "WORDPRESS");
      const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);

      const outcome = await execution.execute(ws.publicId, target.publicId);
      expect(outcome.kind).toBe("success");

      const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(updated.status).toBe("PUBLISHED");
      expect(updated.publishedAt).not.toBeNull();
      expect(updated.externalContentId).toBeTruthy();

      const attempts = await prisma.publishAttempt.findMany({ where: { publicationTargetId: target.id }, orderBy: { occurredAt: "asc" } });
      expect(attempts.map((a) => `${a.fromStatus}->${a.toStatus}`)).toEqual(["QUEUED->PUBLISHING", "PUBLISHING->PUBLISHED"]);
    });
  });

  describe("execution — readiness failure", () => {
    it("a DRAFT content item fails readiness — the provider is never called", async () => {
      const ws = await createTestWorkspace();
      const item = await createContentItemWithVersion(ws, ws.userId, { contentType: "BLOG", title: "Draft blog", status: "DRAFT" });
      const channel = await createChannelAccount(ws, ws.userId, "WORDPRESS");
      const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);

      const outcome = await execution.execute(ws.publicId, target.publicId);
      expect(outcome.kind).toBe("permanent");
      expect(publishCallsByTargetPublicId.get(target.publicId) ?? 0).toBe(0);

      const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(updated.status).toBe("FAILED");
    });
  });

  describe("execution — permanent provider failure", () => {
    it("target FAILED, no automatic further attempt from this call alone", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const channel = await createChannelAccount(ws, ws.userId, "WORDPRESS");
      const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);
      outcomeByTargetPublicId.set(target.publicId, "permanent");

      const outcome = await execution.execute(ws.publicId, target.publicId);
      expect(outcome.kind).toBe("permanent");

      const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(updated.status).toBe("FAILED");
      expect(updated.lastErrorCode).toBe("FIXTURE_PERMANENT_ERROR");

      outcomeByTargetPublicId.delete(target.publicId);
    });
  });

  describe("execution — retryable provider failure and automatic-retry re-invocation", () => {
    it("first attempt fails retryably (FAILED); a second execute() call (simulating BullMQ redelivery) performs FAILED->QUEUED itself, retries, and succeeds", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const channel = await createChannelAccount(ws, ws.userId, "WORDPRESS");
      const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);
      outcomeByTargetPublicId.set(target.publicId, "retryable");

      const first = await execution.execute(ws.publicId, target.publicId);
      expect(first.kind).toBe("retryable");
      const afterFirst = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(afterFirst.status).toBe("FAILED");
      expect(afterFirst.retryCount).toBe(0);

      outcomeByTargetPublicId.set(target.publicId, "success");
      const second = await execution.execute(ws.publicId, target.publicId);
      expect(second.kind).toBe("success");
      const afterSecond = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(afterSecond.status).toBe("PUBLISHED");
      expect(afterSecond.retryCount).toBe(1);

      const attempts = await prisma.publishAttempt.findMany({ where: { publicationTargetId: target.id }, orderBy: { occurredAt: "asc" } });
      expect(attempts.map((a) => `${a.fromStatus}->${a.toStatus}`)).toEqual(["QUEUED->PUBLISHING", "PUBLISHING->FAILED", "FAILED->QUEUED", "QUEUED->PUBLISHING", "PUBLISHING->PUBLISHED"]);

      outcomeByTargetPublicId.delete(target.publicId);
    });
  });

  describe("execution — security", () => {
    it("a target from a different workspace cannot be executed", async () => {
      const ws = await createTestWorkspace();
      const other = await createTestWorkspace();
      const item = await createReadyBlogContentItem(other, other.userId);
      const channel = await createChannelAccount(other, other.userId, "WORDPRESS");
      const target = await createQueuedTarget(other, other.userId, item.id, channel.id);

      const outcome = await execution.execute(ws.publicId, target.publicId);
      if (outcome.kind !== "permanent") throw new Error(`expected permanent, got ${outcome.kind}`);
      expect(outcome.errorCode).toBe("PUBLISHING_TARGET_NOT_FOUND");

      const unchanged = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(unchanged.status).toBe("QUEUED");
    });

    it("no plaintext credential appears in any PublishAttempt.detail", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const secretMarker = `super-secret-${randomUUID()}`;
      const encrypted = crypto.encrypt({ apiKey: secretMarker });
      const credential = await prisma.channelCredential.create({ data: { workspaceId: ws.id, ...encrypted } });
      const account = await prisma.publishingChannelAccount.create({
        data: { workspaceId: ws.id, channelType: "WORDPRESS", displayName: "Secret account", externalAccountId: `ext-${credential.id}`, credentialId: credential.id, connectedById: ws.userId },
      });
      const target = await createQueuedTarget(ws, ws.userId, item.id, account.id);

      await execution.execute(ws.publicId, target.publicId);

      const attempts = await prisma.publishAttempt.findMany({ where: { publicationTargetId: target.id } });
      expect(JSON.stringify(attempts)).not.toContain(secretMarker);
    });
  });

  describe("scheduled dispatch", () => {
    it("dispatches a SCHEDULED target to QUEUED and creates its publishing.execute.v1 BackgroundJob exactly once", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const channel = await createChannelAccount(ws, ws.userId, "WORDPRESS");
      const publication = await prisma.publication.create({ data: { workspaceId: ws.id, contentItemId: item.id, requestedById: ws.userId, scheduledFor: new Date() } });
      const target = await prisma.publicationTarget.create({
        data: { workspaceId: ws.id, publicationId: publication.id, contentItemId: item.id, channelAccountId: channel.id, status: "SCHEDULED", idempotencyKey: `publish:${publication.publicId}:${randomUUID()}` },
      });

      const first = await dispatch.dispatchScheduledTarget(ws.publicId, target.publicId);
      expect(first.dispatched).toBe(true);

      const afterFirst = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
      expect(afterFirst.status).toBe("QUEUED");

      const jobs = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(jobs).toHaveLength(1);

      // A redelivered/duplicate dispatch job for the same occurrence is a safe no-op.
      const second = await dispatch.dispatchScheduledTarget(ws.publicId, target.publicId);
      expect(second.dispatched).toBe(false);
      const stillOneJob = await prisma.backgroundJob.findMany({ where: { workspaceId: ws.id, jobType: "publishing.execute.v1" } });
      expect(stillOneJob).toHaveLength(1);
    });
  });

  describe("partial distribution", () => {
    it("one Publication with three independent targets — retrying the failed one never touches its siblings, summary is truthful", async () => {
      const ws = await createTestWorkspace();
      const item = await createReadyBlogContentItem(ws, ws.userId);
      const channelA = await createChannelAccount(ws, ws.userId, "WORDPRESS");
      const channelB = await createChannelAccount(ws, ws.userId, "WORDPRESS");
      const publication = await prisma.publication.create({ data: { workspaceId: ws.id, contentItemId: item.id, requestedById: ws.userId } });

      const targetA = await prisma.publicationTarget.create({
        data: { workspaceId: ws.id, publicationId: publication.id, contentItemId: item.id, channelAccountId: channelA.id, status: "QUEUED", idempotencyKey: `publish:${publication.publicId}:a:${randomUUID()}` },
      });
      const targetB = await prisma.publicationTarget.create({
        data: { workspaceId: ws.id, publicationId: publication.id, contentItemId: item.id, channelAccountId: channelB.id, status: "QUEUED", idempotencyKey: `publish:${publication.publicId}:b:${randomUUID()}` },
      });

      await execution.execute(ws.publicId, targetA.publicId); // -> PUBLISHED
      outcomeByTargetPublicId.set(targetB.publicId, "permanent");
      await execution.execute(ws.publicId, targetB.publicId); // -> FAILED
      outcomeByTargetPublicId.delete(targetB.publicId);

      const [afterA, afterB] = await Promise.all([
        prisma.publicationTarget.findUniqueOrThrow({ where: { id: targetA.id } }),
        prisma.publicationTarget.findUniqueOrThrow({ where: { id: targetB.id } }),
      ]);
      expect(afterA.status).toBe("PUBLISHED");
      expect(afterB.status).toBe("FAILED");

      const summary = derivePublicationSummary([afterA.status, afterB.status]);
      expect(summary.hasPartialFailure).toBe(true);
      expect(summary.isFullyPublished).toBe(false);
      expect(summary.publishedCount).toBe(1);
      expect(summary.failedCount).toBe(1);

      const contentItemAfter = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id }, select: { status: true } });
      expect(contentItemAfter.status).toBe("APPROVED");
    });
  });
});
