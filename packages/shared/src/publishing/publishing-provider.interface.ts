import type { PublishingChannelType, PublishingContentType } from "./publishing-types";

/**
 * Module 9 Phase 9.2/9.3 — the provider-neutral contract every real
 * channel connector (WordPress, YouTube, Facebook, Instagram — none
 * built yet) will implement. Deliberately minimal, mirroring AIProvider's
 * own shape (ai-provider/ai-provider.interface.ts): a handful of
 * methods, no vendor SDK types leaking into this file.
 *
 * No schedule() — Module 9 uses platform-controlled scheduling
 * (ScheduledJob/SchedulerTickManager), never provider-side scheduling.
 * No delete()/unpublish() — out of v1 scope. No webhook methods — v1
 * publishing never receives inbound provider callbacks.
 *
 * Extracted to `@myev/shared` in Phase 9.3 Milestone A so both apps/api
 * and apps/worker resolve against the identical contract/registry.
 */
export interface PublishingChannelProvider {
  readonly channelType: PublishingChannelType;

  getCapabilities(): PublishingChannelCapabilities;

  /**
   * Deterministic health check against already-decrypted credential
   * material. No Phase 9.2/9.3 provider performs a real network call
   * (only the fixture provider is registered this phase, and it
   * simulates outcomes) — a later phase's real connector may perform an
   * actual lightweight API call here (e.g. "whoami").
   */
  validateConnection(input: PublishingConnectionCheckInput): Promise<PublishingConnectionValidationResult>;

  /**
   * Not exercised by any Phase 9.2 code path; Phase 9.3 exercises it
   * only against the fixture provider (no real connector exists yet).
   * Declared now so the interface is complete and stable for the first
   * real connector to implement.
   */
  publish(input: PublishingPublishInput, decryptedCredential: Record<string, unknown>): Promise<PublishingPublishResult>;
}

export interface PublishingChannelCapabilities {
  supportedContentTypes: PublishingContentType[];
  /** True when this channel can never accept content without a rendered media artifact (every real VIDEO-capable channel). */
  requiresRenderedMedia: boolean;
  requiresTitle: boolean;
  requiresDescription: boolean;
  supportsTags: boolean;
  supportsCaption: boolean;
  /** Opaque, provider-defined privacy values (e.g. a future YouTube PRIVATE/UNLISTED/PUBLIC). Undefined = the channel has no privacy concept. */
  supportedPrivacyOptions?: string[];
  /** Only ever populated when backed by an existing frozen product/config authority — never a guessed real-world API limit. Undefined for every channel in Phase 9.2/9.3. */
  maxMediaSizeBytes?: number;
  /** Opaque, channel-specific structural constraints (aspect ratio, format) — populated only when a frozen authority defines them. Undefined in Phase 9.2/9.3. */
  formatConstraints?: Record<string, unknown>;
}

export interface PublishingConnectionCheckInput {
  channelAccountId: string;
  decryptedCredential: Record<string, unknown>;
  tokenExpiresAt: Date | null;
}

export type PublishingConnectionValidationReasonCode = "CREDENTIAL_EXPIRED" | "CREDENTIAL_REVOKED" | "CREDENTIAL_INVALID" | "PROVIDER_UNAVAILABLE";

export interface PublishingConnectionValidationResult {
  healthy: boolean;
  reasonCode?: PublishingConnectionValidationReasonCode;
  detail?: string;
}

/** Pre-written, already-approved metadata passed through verbatim — never generated or optimized here (Module 10 owns social/caption intelligence). */
export interface PublishingContentMetadataInput {
  title?: string;
  description?: string;
  tags?: string[];
  caption?: string;
  /** Opaque, provider-specific privacy value — e.g. a future YouTube "PRIVATE". */
  privacy?: string;
}

export interface PublishingArtifactRef {
  mediaAssetPublicId: string;
}

/**
 * Module 9 Phase 9.4 — the already-resolved body content a provider
 * actually publishes, in a channel-neutral, provider-ready shape. A
 * provider never receives opaque ContentVersion JSON or any other raw
 * storage representation — the readiness/execution layer resolves it
 * (e.g. `resolveBlogPublishingContent()` for BLOG, in
 * blog-publishing-content.ts) before ever constructing a
 * PublishingPublishInput. `format` is deliberately a closed union so a
 * provider can never be handed a representation it doesn't know how to
 * interpret.
 */
export interface PublishingContentPayload {
  format: "HTML";
  body: string;
}

export interface PublishingPublishInput {
  contentType: PublishingContentType;
  metadata: PublishingContentMetadataInput;
  /** The resolved body content to publish — present whenever the channel/content-type combination requires one (e.g. every BLOG publish). Absent for content types that carry no separate body (e.g. VIDEO, where the artifact itself is the payload). */
  content?: PublishingContentPayload;
  artifact?: PublishingArtifactRef;
  /** A stable, caller-supplied correlation/idempotency token for this one operation attempt — passed straight through so a future real connector can reconcile a provider-succeeded-but-DB-failed race before retrying (Phase 9.3 Part W). Opaque to every Phase 9.2/9.3 provider. */
  operationToken: string;
}

export interface PublishingPublishResult {
  externalContentId: string;
  externalUrl?: string;
}
