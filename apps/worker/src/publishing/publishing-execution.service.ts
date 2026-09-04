import { Injectable } from "@nestjs/common";
import {
  assertPublicationTargetTransition,
  isYouTubeUploadCheckpoint,
  PublishingDomainError,
  PublishingProviderPermanentError,
  PublishingProviderRetryableError,
  resolveBlogPublishingContent,
  type EncryptedCredential,
  type PublishingContentPayload,
  type PublishingExecutionCallbacks,
  type PublishingPublishInput,
} from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import type { Prisma, PublicationTargetStatus } from "../../../api/generated/prisma";
import { PublishingCredentialConfigurationError, PublishingCredentialCryptoService, PublishingCredentialDecryptionError } from "./publishing-credential-crypto.service";
import { PublishingMediaReaderService } from "./publishing-media-reader.service";
import { PublishingProviderNotConfiguredError, PublishingProviderResolverService } from "./publishing-provider-resolver.service";
import { PublishingReadinessService } from "./publishing-readiness.service";

/**
 * Module 9 Phase 9.5 pre-merge security correction — the ONE checkpoint
 * envelope shape ever written to `PublishAttempt.detail`'s `PUBLISHING ->
 * PUBLISHING` rows. `uploadSessionUri` is sensitive capability data (a
 * bearer can query/resume the upload without separately presenting the
 * OAuth credential), so the logical checkpoint bag a provider hands to
 * `saveCheckpoint()` is AES-256-GCM-encrypted (reusing the exact same
 * shared primitive/keying `ChannelCredential` itself uses — see
 * `PublishingCredentialCryptoService`) before it is ever persisted.
 * `checkpointType` is a forward-compatible discriminator, not a version
 * field (the crypto envelope's own `keyVersion` already covers key
 * rotation) — a future non-YouTube checkpoint kind would get its own
 * literal here rather than reusing this one.
 */
const YOUTUBE_RESUMABLE_UPLOAD_CHECKPOINT_TYPE = "YOUTUBE_RESUMABLE_UPLOAD";

interface EncryptedCheckpointEnvelope {
  checkpointType: typeof YOUTUBE_RESUMABLE_UPLOAD_CHECKPOINT_TYPE;
  encrypted: EncryptedCredential;
}

function isEncryptedCredentialShape(value: unknown): value is EncryptedCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).ciphertext === "string" &&
    typeof (value as Record<string, unknown>).nonce === "string" &&
    typeof (value as Record<string, unknown>).authTag === "string" &&
    typeof (value as Record<string, unknown>).keyVersion === "number"
  );
}

function isEncryptedCheckpointEnvelope(value: unknown): value is EncryptedCheckpointEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).checkpointType === YOUTUBE_RESUMABLE_UPLOAD_CHECKPOINT_TYPE &&
    isEncryptedCredentialShape((value as Record<string, unknown>).encrypted)
  );
}

/**
 * The three-way outcome of looking up a target's most recent checkpoint.
 * "none" (no row at all — a target's first-ever attempt, or a provider
 * that never checkpoints) is the ONLY case safe to treat as "start a
 * fresh upload." "unusable" (a row exists but could not be safely
 * recovered — tampered ciphertext, wrong/rotated key, malformed payload)
 * must NEVER be silently collapsed into "none": doing so would let this
 * attempt start a brand-new YouTube upload session while an earlier one
 * may still be in flight or already completed, creating a duplicate
 * external video. The caller (`execute()`) hard-fails on "unusable"
 * before ever invoking the provider.
 */
type CheckpointLoadResult = { outcome: "none" } | { outcome: "valid"; detail: Record<string, unknown> } | { outcome: "unusable" };

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
    private readonly crypto: PublishingCredentialCryptoService,
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
    const checkpointResult = await this.loadPriorCheckpoint(target.id);
    if (checkpointResult.outcome === "unusable") {
      // A checkpoint row exists for this target but could not be safely
      // recovered. Blocking here — before any provider call — is the
      // whole point: falling through with `priorCheckpoint: undefined`
      // would look identical to "no checkpoint at all" to the provider,
      // which would then start a brand-new upload session, risking a
      // duplicate external video. This requires human intervention (a
      // key-configuration problem or genuine tampering), not a blind
      // automatic retry, so it is classified permanent.
      return this.failTarget(
        target.id,
        "PUBLISHING_CHECKPOINT_UNRECOVERABLE",
        "A prior upload checkpoint exists for this target but could not be safely decrypted or validated; refusing to start a new upload to avoid creating a duplicate.",
        "permanent",
      );
    }
    const priorCheckpoint = checkpointResult.outcome === "valid" ? checkpointResult.detail : undefined;
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
   * Module 9 Phase 9.5 (pre-merge security correction) — reads the most
   * recent checkpoint any earlier attempt of this target saved (see
   * `saveCheckpoint`'s own doc comment for the exact row shape this
   * looks for), decrypting it through the same worker-local crypto
   * boundary `ChannelCredential` refresh already uses.
   *
   * Returns `{ outcome: "none" }` on a target's first-ever attempt, or
   * for a provider that never checkpoints (WordPress) — no row at all.
   * Returns `{ outcome: "unusable" }` for EVERY other failure mode —
   * not our own envelope shape, an unsupported/rotated key version,
   * tampered ciphertext, or a decrypted payload that doesn't structurally
   * match a real checkpoint — deliberately without leaking which one
   * (never a raw crypto-library error, never distinguishing "wrong key"
   * from "tampered" in what's returned/persisted). The caller MUST treat
   * "unusable" as a hard, blocking failure — see `execute()`.
   */
  private async loadPriorCheckpoint(targetId: string): Promise<CheckpointLoadResult> {
    const row = await this.prisma.publishAttempt.findFirst({
      where: { publicationTargetId: targetId, fromStatus: "PUBLISHING", toStatus: "PUBLISHING" },
      orderBy: { occurredAt: "desc" },
      select: { detail: true },
    });
    if (row?.detail === undefined || row?.detail === null) return { outcome: "none" };

    if (!isEncryptedCheckpointEnvelope(row.detail)) return { outcome: "unusable" };

    let decrypted: Record<string, unknown>;
    try {
      decrypted = this.crypto.decrypt(row.detail.encrypted);
    } catch (err) {
      if (err instanceof PublishingCredentialDecryptionError || err instanceof PublishingCredentialConfigurationError) {
        return { outcome: "unusable" };
      }
      throw err;
    }

    if (!isYouTubeUploadCheckpoint(decrypted)) return { outcome: "unusable" };
    return { outcome: "valid", detail: decrypted };
  }

  /**
   * Module 9 Phase 9.5 (pre-merge security correction) — encrypts the
   * provider-supplied checkpoint bag (AES-256-GCM, via the SAME shared
   * primitive/worker-local key boundary `ChannelCredential` refresh
   * already uses — `@myev/shared` itself never reads env/config) and
   * persists only the resulting `{checkpointType, encrypted}` envelope.
   * `uploadSessionUri` never touches the database in plaintext.
   *
   * Otherwise unchanged from Phase 9.5: still its own `PublishAttempt`
   * row, deliberately WITHOUT going through
   * `assertPublicationTargetTransition`/updating `PublicationTarget.status`
   * at all — a checkpoint is not a lifecycle transition (the target stays
   * PUBLISHING throughout), it is additional audit-trail state within one
   * still-in-progress attempt. `fromStatus === toStatus === "PUBLISHING"`
   * is the one, deliberate marker `loadPriorCheckpoint()` looks for.
   */
  private async saveCheckpoint(targetId: string, detail: Record<string, unknown>): Promise<void> {
    const envelope: EncryptedCheckpointEnvelope = { checkpointType: YOUTUBE_RESUMABLE_UPLOAD_CHECKPOINT_TYPE, encrypted: this.crypto.encrypt(detail) };
    await this.prisma.publishAttempt.create({ data: { publicationTargetId: targetId, fromStatus: "PUBLISHING", toStatus: "PUBLISHING", detail: envelope as unknown as Prisma.InputJsonValue } });
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
