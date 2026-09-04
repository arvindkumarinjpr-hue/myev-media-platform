import type { PublishingChannelCapabilities, PublishingConnectionValidationResult } from "./publishing-provider.interface";
import { PUBLISHING_READINESS_REASONS, type PublishingReadinessMetadata, type PublishingReadinessReasonCode, type PublishingReadinessResult } from "./publishing-readiness-types";
import type { PublishingConnectionStatus, PublishingContentType, PublishingVideoRenderJobStatus } from "./publishing-types";

/**
 * Module 9 Phase 9.3 Milestone A — the plain, already-fetched facts both
 * apps/api and apps/worker assemble from their own (separately performed,
 * genuinely mechanical) Prisma queries before calling
 * `derivePublishingReadiness`. Mirrors `ScoringInput`'s own precedent
 * exactly (packages/shared/src/content-scoring/scoring-input.ts): "the
 * engine never touches Prisma... that boundary is what keeps `@myev/shared`
 * free of any app-specific dependency."
 *
 * `connectionHealthResult` is populated by the adapter's own mechanical
 * decrypt-and-call-provider step — the adapter should call
 * `isPublishingCredentialExpired()` FIRST and skip that step entirely
 * (passing `null` here) when it already returns true, exactly preserving
 * Phase 9.2's own "never decrypt an already-known-expired credential"
 * behavior. `derivePublishingReadiness` independently re-derives the same
 * expiry classification from `channelTokenExpiresAt`, so an adapter that
 * doesn't skip the call is still classified correctly either way.
 */
export interface PublishingReadinessFacts {
  contentType: PublishingContentType;
  contentStatus: string;
  contentDeletedAt: Date | null;
  contentTitle: string;

  channelConnectionStatus: PublishingConnectionStatus;
  channelTokenExpiresAt: Date | null;
  connectionHealthResult: PublishingConnectionValidationResult | null;

  blogArticleExists: boolean;
  blogMetaDescription: string | null;
  /** Whether `resolveBlogPublishingContent()` (blog-publishing-content.ts) can successfully resolve this content item's `ContentVersion.body.blogDraft` into a publishable payload — distinct from `blogArticleExists`, see BLOG_PUBLISHING_CONTENT_MISSING's own doc comment. Only meaningful for BLOG. */
  blogPublishingContentAvailable: boolean;

  videoLatestRenderStatus: PublishingVideoRenderJobStatus | null;
  videoOutputMediaAssetPublicId: string | null;
  /** null when no asset row was found for `videoOutputMediaAssetPublicId` (or that field is itself null). */
  videoOutputMediaAssetStatus: string | null;

  /** Pre-written metadata read from ContentItem's own generic `metadata.publishing` JSON bag — never generated here. */
  metadataDescription?: string;
  metadataTags?: string[];
  metadataCaption?: string;
}

/** The single, shared authority for "is this stored token expiry already in the past" — called by an adapter BEFORE deciding whether to decrypt/call the provider, and re-checked inside `derivePublishingReadiness` itself so the classification can never depend on whether an adapter remembered to call this first. */
export function isPublishingCredentialExpired(tokenExpiresAt: Date | null, now: Date = new Date()): boolean {
  return tokenExpiresAt !== null && tokenExpiresAt.getTime() <= now.getTime();
}

/**
 * The ONE authority for Publishing readiness — approved/deleted
 * eligibility, channel/content compatibility, account connection state,
 * credential expiry/availability classification, Blog presence, Video
 * render/media readiness, required metadata, and every stable readiness
 * reason code. Both apps/api and apps/worker call this exact function;
 * neither re-implements any part of this decision tree.
 *
 * `capabilities: null` means the caller's own provider-registry
 * resolution already failed (channel type not configured) — short-
 * circuits to a single PROVIDER_NOT_CONFIGURED blocking reason, since no
 * further capability-dependent check is meaningful without a provider.
 *
 * Pure: no I/O, no Prisma, no NestJS. Never mutates its inputs.
 */
export function derivePublishingReadiness(facts: PublishingReadinessFacts, capabilities: PublishingChannelCapabilities | null): PublishingReadinessResult {
  const blockingReasons: PublishingReadinessReasonCode[] = [];
  const warnings: PublishingReadinessReasonCode[] = [];

  if (capabilities === null) {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.PROVIDER_NOT_CONFIGURED);
    return { ready: false, blockingReasons, warnings, resolvedArtifact: null, metadata: { title: facts.contentTitle || undefined } };
  }

  if (facts.contentDeletedAt !== null) {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.CONTENT_DELETED);
  } else if (facts.contentStatus !== "APPROVED") {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.CONTENT_NOT_APPROVED);
  }

  if (!capabilities.supportedContentTypes.includes(facts.contentType)) {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.CHANNEL_NOT_SUPPORTED);
  }

  evaluateConnectionHealth(facts, blockingReasons);

  let resolvedArtifact: { mediaAssetPublicId: string } | null = null;
  if (facts.contentType === "VIDEO" && capabilities.requiresRenderedMedia) {
    resolvedArtifact = evaluateVideoRenderReadiness(facts, blockingReasons);
  } else if (facts.contentType === "BLOG") {
    evaluateBlogReadiness(facts, blockingReasons);
  }

  const metadata = resolvePlatformMetadata(facts, capabilities, blockingReasons);

  return { ready: blockingReasons.length === 0, blockingReasons, warnings, resolvedArtifact, metadata };
}

function evaluateConnectionHealth(facts: PublishingReadinessFacts, blockingReasons: PublishingReadinessReasonCode[]): void {
  if (facts.channelConnectionStatus !== "CONNECTED") {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.CHANNEL_ACCOUNT_NOT_CONNECTED);
    return;
  }
  if (isPublishingCredentialExpired(facts.channelTokenExpiresAt)) {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.CREDENTIAL_EXPIRED);
    return;
  }
  if (!facts.connectionHealthResult || !facts.connectionHealthResult.healthy) {
    blockingReasons.push(mapConnectionReason(facts.connectionHealthResult?.reasonCode));
  }
}

function mapConnectionReason(reasonCode?: string): PublishingReadinessReasonCode {
  switch (reasonCode) {
    case "CREDENTIAL_EXPIRED":
      return PUBLISHING_READINESS_REASONS.CREDENTIAL_EXPIRED;
    case "CREDENTIAL_REVOKED":
    case "CREDENTIAL_INVALID":
      return PUBLISHING_READINESS_REASONS.CREDENTIAL_INVALID;
    case "PROVIDER_UNAVAILABLE":
    default:
      return PUBLISHING_READINESS_REASONS.CREDENTIAL_UNAVAILABLE;
  }
}

/** Video: reuses Phase 9.1's coarser render-readiness primitive (latest COMPLETED render + an ACTIVE output MediaAsset) rather than Module 7's private scriptVersionHash/sceneAssetFingerprint drift check — that logic lives inside VideoRenderService's own private method and requires its full internal pipeline state, which is out of scope here (a documented, accepted gap, not fixed by this function). */
function evaluateVideoRenderReadiness(facts: PublishingReadinessFacts, blockingReasons: PublishingReadinessReasonCode[]): { mediaAssetPublicId: string } | null {
  if (!facts.videoLatestRenderStatus || facts.videoLatestRenderStatus !== "COMPLETED") {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.RENDER_NOT_READY);
    return null;
  }
  if (!facts.videoOutputMediaAssetPublicId || facts.videoOutputMediaAssetStatus === null) {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.MEDIA_ASSET_MISSING);
    return null;
  }
  if (facts.videoOutputMediaAssetStatus !== "ACTIVE") {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.MEDIA_ASSET_INELIGIBLE);
    return null;
  }
  return { mediaAssetPublicId: facts.videoOutputMediaAssetPublicId };
}

/**
 * Blog: BlogArticle row exists. No "current body/version exists" check —
 * Module 1E's own deferred DB trigger already guarantees a non-deleted
 * ContentItem's currentVersionId is never null at commit (confirmed live
 * in Phase 9.2), so that state is unreachable and there is nothing to
 * check. Module 8 ACCEPTED links are never consulted — irrelevant to
 * publish readiness by design.
 *
 * Phase 9.4 adds `blogPublishingContentAvailable` — a version existing
 * is not the same as its `body.blogDraft` being present/well-formed
 * (the structured payload a real connector needs to build a publishable
 * body from); see BLOG_PUBLISHING_CONTENT_MISSING's own doc comment.
 */
function evaluateBlogReadiness(facts: PublishingReadinessFacts, blockingReasons: PublishingReadinessReasonCode[]): void {
  if (!facts.blogArticleExists) {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.BLOG_ARTICLE_MISSING);
  }
  if (!facts.blogPublishingContentAvailable) {
    blockingReasons.push(PUBLISHING_READINESS_REASONS.BLOG_PUBLISHING_CONTENT_MISSING);
  }
}

/**
 * Pre-written metadata pass-through only — never generated or optimized
 * here (Module 10 owns social/caption intelligence). Title always comes
 * from ContentItem.title. Description comes from BlogArticle.metaDescription
 * for BLOG, or the generic metadata.publishing bag otherwise.
 */
function resolvePlatformMetadata(facts: PublishingReadinessFacts, capabilities: PublishingChannelCapabilities, blockingReasons: PublishingReadinessReasonCode[]): PublishingReadinessMetadata {
  const description = facts.contentType === "BLOG" ? (facts.blogMetaDescription ?? undefined) : facts.metadataDescription;

  const metadata: PublishingReadinessMetadata = {
    title: facts.contentTitle || undefined,
    description,
    tags: facts.metadataTags,
    caption: facts.metadataCaption,
  };

  const alreadyMissing = blockingReasons.includes(PUBLISHING_READINESS_REASONS.REQUIRED_METADATA_MISSING);
  if (!alreadyMissing) {
    const missingTitle = capabilities.requiresTitle && !metadata.title;
    const missingDescription = capabilities.requiresDescription && !metadata.description;
    if (missingTitle || missingDescription) {
      blockingReasons.push(PUBLISHING_READINESS_REASONS.REQUIRED_METADATA_MISSING);
    }
  }

  return metadata;
}
