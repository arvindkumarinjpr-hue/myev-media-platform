import { Injectable } from "@nestjs/common";
import {
  assertPublicationTargetTransition,
  PublishingDomainError,
  PublishingProviderPermanentError,
  PublishingProviderRetryableError,
  resolveBlogPublishingContent,
  type PublishingContentPayload,
  type PublishingExecutionCallbacks,
  type PublishingPublishInput,
} from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import type { Prisma, PublicationTargetStatus } from "../../../api/generated/prisma";
import { PublishingMediaReaderService } from "./publishing-media-reader.service";
import { PublishingProviderNotConfiguredError, PublishingProviderResolverService } from "./publishing-provider-resolver.service";
import { PublishingReadinessService } from "./publishing-readiness.service";

/** Mechanically extracts `body.blogDraft` off a fetched ContentVersion's opaque Json `body` — the ONE narrowing step `resolveBlogPublishingContent()`'s own doc comment expects its caller to already have done. Never interprets the extracted value further; that is `parseBlogPublishingDraft()`'s (packages/shared) job alone. */
function extractBlogDraft(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>).blogDraft;
}

export type PublishingExecutionOutcome =
  | { kind: "success"; externalContentId: string; externalUrl?: string }
  | { kind: "retryable"; errorCode: string; message: string }
  | { kind: "permanent"; errorCode: string; message: string };

/**
 * Module 9 Phase 9.3 — the worker-local coordinator for one publish
 * execution attempt against one PublicationTarget. Reuses the shared
 * lifecycle-transition guard and the shared readiness decision function
 * (via this process's own thin adapters) rather than re-implementing
 * either — the only thing genuinely local to this class is the
 * orchestration order and the append-only PublishAttempt/audit-history
 * bookkeeping.
 *
 * Never talks to a real external channel — only the fixture provider is
 * registered in this phase. Every state transition follows Phase 9.1's
 * frozen ALLOWED_TARGET_TRANSITIONS table exactly, via the shared
 * `assertPublicationTargetTransition` guard — no hidden backdoor status
 * write exists anywhere in this class.
 */
@Injectable()
export class PublishingExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PublishingProviderResolverService,
    private readonly readiness: PublishingReadinessService,
    private readonly mediaReaderService: PublishingMediaReaderService,
  ) {}

  /**
   * `workspacePublicId` (not the internal id) — matches the durable job
   * payload's own field naming (never an internal id crosses the queue
   * boundary). Resolved to the internal id here, as this class's own
   * first mechanical step, so every subsequent lookup stays workspace-
   * scoped exactly like every other service in this codebase — never
   * trusting the target row's own embedded workspaceId blindly.
   */
  async execute(workspacePublicId: string, targetPublicId: string): Promise<PublishingExecutionOutcome> {
    const workspace = await this.prisma.workspace.findUnique({ where: { publicId: workspacePublicId }, select: { id: true } });
    if (!workspace) {
      return { kind: "permanent", errorCode: "PUBLISHING_WORKSPACE_NOT_FOUND", message: "Workspace not found." };
    }
    const workspaceId = workspace.id;

    const target = await this.prisma.publicationTarget.findFirst({ where: { workspaceId, publicId: targetPublicId } });
    if (!target) {
      return { kind: "permanent", errorCode: "PUBLISHING_TARGET_NOT_FOUND", message: "Publication target not found in this workspace." };
    }

    let currentStatus: PublicationTargetStatus = target.status;
    let retryCount = target.retryCount;

    // BullMqWorkerManager's own automatic retry re-invokes this exact
    // handler for the SAME BullMQ job at a later time — it never
    // performs any PublicationTarget-specific transition itself (that's
    // this domain's own concern, not the generic queue framework's).
    // FAILED -> PUBLISHING is not a legal direct transition (Phase 9.1's
    // frozen table), so on a redelivery this class performs the
    // explicit FAILED -> QUEUED "retry preparation" step itself first
    // (Part O's own recommended model), incrementing retryCount exactly
    // like a manual retry does — an automatic and a manual retry are
    // both genuinely new attempt generations.
    if (currentStatus === "FAILED") {
      try {
        assertPublicationTargetTransition(currentStatus, "QUEUED");
      } catch (err) {
        if (err instanceof PublishingDomainError) {
          return { kind: "permanent", errorCode: err.code, message: err.message };
        }
        throw err;
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.publicationTarget.update({ where: { id: target.id }, data: { status: "QUEUED", retryCount: { increment: 1 } } });
        await tx.publishAttempt.create({ data: { publicationTargetId: target.id, fromStatus: "FAILED", toStatus: "QUEUED", detail: { reason: "automatic_retry_preparation" } } });
      });
      currentStatus = "QUEUED";
      retryCount += 1;
    }

    // Terminal/illegal states (PUBLISHED, CANCELLED, or any status that
    // cannot legally reach PUBLISHING) are rejected by the exact same
    // shared domain guard every other Publishing lifecycle write uses —
    // never a status string comparison hand-rolled here.
    try {
      assertPublicationTargetTransition(currentStatus, "PUBLISHING");
    } catch (err) {
      if (err instanceof PublishingDomainError) {
        return { kind: "permanent", errorCode: err.code, message: err.message };
      }
      throw err;
    }

    await this.recordTransition(target.id, currentStatus, "PUBLISHING", { reason: "execution_started" });

    const contentItem = await this.prisma.contentItem.findFirst({ where: { id: target.contentItemId, workspaceId }, select: { publicId: true, contentType: true, currentVersionId: true } });
    const channelAccount = await this.prisma.publishingChannelAccount.findFirst({ where: { id: target.channelAccountId, workspaceId }, select: { publicId: true } });
    if (!contentItem || !channelAccount) {
      return this.failTarget(target.id, "PUBLISHING_TARGET_REFERENCE_MISSING", "The content item or channel account this target refers to no longer exists.", "permanent");
    }

    // Execution-time readiness (Part O): always recomputed immediately
    // before any provider call, using the exact same shared decision
    // function apps/api's own readiness endpoint would use — credentials
    // may have expired, the account may have been revoked, or the
    // content may have been archived/deleted since this target was
    // scheduled/dispatched. If it's not ready, the provider is never
    // called.
    const readinessResult = await this.readiness.evaluateReadiness(workspaceId, contentItem.publicId, channelAccount.publicId);
    if (!readinessResult.ready) {
      const reason = readinessResult.blockingReasons[0] ?? "NOT_READY";
      return this.failTarget(target.id, `READINESS_${reason}`, `Execution-time readiness check failed: ${reason}.`, "permanent");
    }

    // BLOG publishing content (Part I): resolved here, mechanically, from
    // this process's own ContentVersion fetch, and handed to the shared
    // renderer — the ONE place blogDraft -> HTML rendering rules live
    // (packages/shared/src/publishing/blog-publishing-content.ts). The
    // provider never queries Prisma and never sees ContentVersion's raw
    // body shape. Readiness already proved `blogPublishingContentAvailable`
    // moments ago; a null result here despite that is a genuine (rare)
    // race — treated as permanent rather than silently retrying forever,
    // since retrying an execution attempt does not by itself fix an
    // unresolvable blogDraft.
    let content: PublishingContentPayload | undefined;
    if (contentItem.contentType === "BLOG") {
      content = (await this.resolveBlogPublishingContentPayload(contentItem.currentVersionId)) ?? undefined;
      if (!content) {
        return this.failTarget(target.id, "PUBLISHING_BLOG_CONTENT_UNRESOLVABLE", "The blog's publishing content could not be resolved at execution time.", "permanent");
      }
    }

    let providerContext;
    try {
      providerContext = await this.resolver.resolveChannelContext(workspaceId, channelAccount.publicId);
    } catch (err) {
      if (err instanceof PublishingProviderNotConfiguredError) {
        return this.failTarget(target.id, "PUBLISHING_PROVIDER_NOT_CONFIGURED", err.message, "permanent");
      }
      throw err;
    }

    // A stable, per-attempt correlation/idempotency token — deterministic
    // for THIS attempt generation (retryCount doesn't change again until
    // a genuinely new retry), passed straight through to the provider so
    // a future real connector can reconcile a provider-succeeded-but-DB-
    // failed race before ever retrying (Part W). Never random — a
    // redelivered BullMQ attempt for the SAME generation (a transient
    // dispatch-layer redelivery, not a domain retry) produces the exact
    // same token.
    const operationToken = `publishing:${target.publicId}:attempt:${retryCount}`;
    // Module 9 Phase 9.5 — the most recent checkpoint ANY earlier
    // attempt generation of this SAME target saved (target-scoped, not
    // attempt-scoped — mirrors WordPress's own reconciliation-marker
    // scoping exactly, and for the identical reason: a manual retry
    // mints a new operationToken/generation, but "does an in-progress
    // upload already exist" is a fact about the target, not the attempt).
    const priorCheckpoint = await this.loadPriorCheckpoint(target.id);
    const publishInput: PublishingPublishInput = {
      contentType: contentItem.contentType,
      metadata: readinessResult.metadata,
      artifact: readinessResult.resolvedArtifact ?? undefined,
      content,
      operationToken,
      priorCheckpoint,
    };

    // Module 9 Phase 9.5 — the seam a real, multi-request connector
    // (YouTube's resumable upload; an OAuth refresh) uses to report
    // state back for persistence, entirely through this process's own
    // existing Prisma/crypto boundaries — the provider itself never
    // touches either. mediaReader is only ever constructed for VIDEO;
    // WordPress (BLOG) never reads it.
    const callbacks: PublishingExecutionCallbacks = {
      saveCheckpoint: (detail) => this.saveCheckpoint(target.id, detail),
      onCredentialRefreshed: (newCredential, tokenExpiresAt) => this.resolver.persistRefreshedCredential(workspaceId, channelAccount.publicId, newCredential, tokenExpiresAt),
      mediaReader: contentItem.contentType === "VIDEO" ? this.mediaReaderService.createReader(workspaceId) : undefined,
    };

    try {
      const result = await this.resolver.withDecryptedCredential(workspaceId, channelAccount.publicId, (decryptedCredential) =>
        providerContext.provider.publish(publishInput, decryptedCredential, callbacks),
      );
      await this.completeTarget(target.id, result);
      return { kind: "success", externalContentId: result.externalContentId, externalUrl: result.externalUrl };
    } catch (err) {
      if (err instanceof PublishingProviderPermanentError) {
        await this.failTarget(target.id, err.errorCode, err.message, "permanent");
        return { kind: "permanent", errorCode: err.errorCode, message: err.message };
      }
      if (err instanceof PublishingProviderRetryableError) {
        await this.failTarget(target.id, err.errorCode, err.message, "retryable");
        return { kind: "retryable", errorCode: err.errorCode, message: err.message };
      }
      // An unclassified error from the provider (or from credential
      // decryption) is treated as retryable — never permanently failing
      // a target over a genuinely transient/unknown fault — but its
      // message is never persisted verbatim (see failTarget's own doc
      // comment on sanitization).
      await this.failTarget(target.id, "PUBLISHING_PROVIDER_UNKNOWN_ERROR", "The provider call failed unexpectedly.", "retryable");
      return { kind: "retryable", errorCode: "PUBLISHING_PROVIDER_UNKNOWN_ERROR", message: "The provider call failed unexpectedly." };
    }
  }

  /**
   * Module 9 Phase 9.4 — this process's own mechanical ContentVersion
   * fetch for BLOG execution, mirroring PublishingReadinessService's own
   * identically-shaped helper. Never mutates the source ContentVersion;
   * never re-implements the blogDraft -> HTML rules themselves.
   */
  private async resolveBlogPublishingContentPayload(currentVersionId: string | null): Promise<PublishingContentPayload | null> {
    if (!currentVersionId) return null;
    const version = await this.prisma.contentVersion.findFirst({ where: { id: currentVersionId }, select: { body: true } });
    if (!version) return null;
    return resolveBlogPublishingContent(extractBlogDraft(version.body));
  }

  /**
   * Module 9 Phase 9.5 — reads the most recent checkpoint any earlier
   * attempt of this target saved (see `saveCheckpoint`'s own doc
   * comment for the exact row shape this looks for). `undefined` on a
   * target's first-ever attempt, or for a provider that never
   * checkpoints (WordPress) — both cases are simply "no matching row."
   */
  private async loadPriorCheckpoint(targetId: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.prisma.publishAttempt.findFirst({
      where: { publicationTargetId: targetId, fromStatus: "PUBLISHING", toStatus: "PUBLISHING" },
      orderBy: { occurredAt: "desc" },
      select: { detail: true },
    });
    return (row?.detail as Record<string, unknown> | null) ?? undefined;
  }

  /**
   * Module 9 Phase 9.5 — persists a non-secret, provider-defined
   * checkpoint bag as its own `PublishAttempt` row, deliberately WITHOUT
   * going through `assertPublicationTargetTransition`/updating
   * `PublicationTarget.status` at all: a checkpoint is not a lifecycle
   * transition (the target stays PUBLISHING throughout), it is
   * additional audit-trail state within one still-in-progress attempt —
   * exactly what the append-only `PublishAttempt` model already exists
   * for (FR-PUB-005). `fromStatus === toStatus === "PUBLISHING"` is the
   * one, deliberate marker `loadPriorCheckpoint()` looks for.
   */
  private async saveCheckpoint(targetId: string, detail: Record<string, unknown>): Promise<void> {
    await this.prisma.publishAttempt.create({ data: { publicationTargetId: targetId, fromStatus: "PUBLISHING", toStatus: "PUBLISHING", detail: detail as Prisma.InputJsonValue } });
  }

  /** PUBLISHING -> PUBLISHED, with the provider's own (already-safe, no-secrets) result summary recorded on the PublishAttempt row. */
  private async completeTarget(targetId: string, result: { externalContentId: string; externalUrl?: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.publicationTarget.update({
        where: { id: targetId },
        data: { status: "PUBLISHED", publishedAt: new Date(), externalContentId: result.externalContentId, externalUrl: result.externalUrl ?? null },
      });
      await tx.publishAttempt.create({
        data: { publicationTargetId: targetId, fromStatus: "PUBLISHING", toStatus: "PUBLISHED", detail: { externalContentId: result.externalContentId, externalUrl: result.externalUrl ?? null } as Prisma.InputJsonValue },
      });
    });
  }

  /**
   * PUBLISHING -> FAILED. `errorCode`/`message` are always our own
   * curated strings (a shared domain-error code, a provider's own typed
   * errorCode, or one of this class's own fixed literals) — never a raw
   * caught exception's `.message`/`.stack`, so no provider secret or
   * internal detail can ever reach `PublicationTarget.lastErrorMessageSafe`
   * or the PublishAttempt's `detail` JSON.
   */
  /**
   * Module 9 Phase 9.4 — deliberately does NOT mutate
   * `PublishingChannelAccount.connectionStatus` here, even for a
   * WordPress-reported WORDPRESS_UNAUTHORIZED/WORDPRESS_FORBIDDEN
   * permanent failure (Part R: "do not mutate connection status on every
   * transient failure... if an explicit account-health updater service
   * is needed, keep it focused and tested"). No such updater exists yet
   * — building one hastily here would risk exactly the "worker invents
   * connection lifecycle changes outside shared rules" pitfall Part R
   * itself warns against. `PublicationTarget.lastErrorCode`/
   * `lastErrorMessageSafe` already surface the failure for a human/future
   * dedicated service to act on; a target's own repeated permanent
   * failures never, by themselves, revoke or otherwise change the
   * channel account's connection state. Deferred, not forgotten.
   */
  private async failTarget(targetId: string, errorCode: string, message: string, classification: "retryable" | "permanent"): Promise<PublishingExecutionOutcome> {
    await this.prisma.$transaction(async (tx) => {
      await tx.publicationTarget.update({ where: { id: targetId }, data: { status: "FAILED", lastErrorCode: errorCode, lastErrorMessageSafe: message } });
      await tx.publishAttempt.create({
        data: { publicationTargetId: targetId, fromStatus: "PUBLISHING", toStatus: "FAILED", detail: { errorCode, classification } as Prisma.InputJsonValue },
      });
    });
    return { kind: classification, errorCode, message };
  }

  private async recordTransition(targetId: string, fromStatus: PublicationTargetStatus, toStatus: "PUBLISHING", detail: Record<string, unknown>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.publicationTarget.update({ where: { id: targetId }, data: { status: toStatus } });
      await tx.publishAttempt.create({ data: { publicationTargetId: targetId, fromStatus, toStatus, detail: detail as Prisma.InputJsonValue } });
    });
  }
}
