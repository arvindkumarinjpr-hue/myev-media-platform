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
  validateConnection(input: PublishingConnectionCheckInput, callbacks?: PublishingExecutionCallbacks): Promise<PublishingConnectionValidationResult>;

  /**
   * Not exercised by any Phase 9.2 code path; Phase 9.3 exercises it
   * only against the fixture provider (no real connector exists yet).
   * Declared now so the interface is complete and stable for the first
   * real connector to implement.
   *
   * `callbacks` (Module 9 Phase 9.5, additive — optional, and every
   * pre-9.5 provider needs zero code change since TS allows implementing
   * an interface method with fewer parameters than it declares) exists
   * for connectors whose external protocol is NOT a single atomic call —
   * e.g. YouTube's resumable upload, where a provider-succeeded-but-
   * MYEV-crashed race is a real risk mid-upload, unlike WordPress's
   * single-request create. See `PublishingExecutionCallbacks`'s own doc
   * comment.
   */
  publish(input: PublishingPublishInput, decryptedCredential: Record<string, unknown>, callbacks?: PublishingExecutionCallbacks): Promise<PublishingPublishResult>;
}

/**
 * Module 9 Phase 9.5 — the narrow, optional seam a provider whose
 * external protocol spans more than one HTTP call (a resumable upload;
 * an OAuth access-token refresh) uses to report state back to the
 * caller (apps/api's or apps/worker's own PublishingProviderResolverService/
 * PublishingExecutionService) for persistence — WITHOUT the provider
 * itself ever touching Prisma or the credential-encryption boundary.
 * WordPress needs neither method and simply never calls them.
 *
 * Both methods are themselves optional on this interface — a provider
 * that never uses one simply never calls it; the caller's own
 * implementation is what actually decides how (and whether) to persist
 * anything.
 */
export interface PublishingExecutionCallbacks {
  /**
   * Persists a plain, NON-SECRET checkpoint bag for the CURRENT target
   * (every attempt generation of the same PublicationTarget shares the
   * same checkpoint history — mirrors WordPress's own target-scoped, not
   * attempt-scoped, reconciliation marker) so a later attempt — an
   * automatic BullMQ redelivery OR a manual retry with a new
   * operationToken generation — can resume via
   * `PublishingPublishInput.priorCheckpoint` instead of blindly redoing
   * already-completed provider-side work (e.g. re-uploading a video
   * whose upload actually already finished on the provider's side).
   * MUST NEVER be called with credentials, tokens, or any other secret —
   * the caller persists this in a plain, unencrypted, human-readable
   * column (PublishAttempt.detail). Safe to call zero or more times
   * during one `publish()` call.
   */
  saveCheckpoint(detail: Record<string, unknown>): Promise<void>;

  /**
   * Reports that the provider obtained NEW credential material during
   * this call (e.g. a refreshed OAuth access token) that must replace
   * what is currently stored for this channel account. The CALLER is
   * solely responsible for re-encrypting (via the existing
   * PublishingCredentialCryptoService — the SAME boundary that decrypted
   * the credential in the first place) and persisting it; the provider
   * itself never sees ciphertext and never touches Prisma. `credential`
   * replaces the full decrypted payload (not a partial merge — the
   * provider must include every field the stored credential needs, not
   * just the changed one). `tokenExpiresAt` updates
   * `ChannelCredential.tokenExpiresAt` (a plain, non-secret column) when
   * the provider knows the new expiry; omit/null to leave it unchanged.
   */
  onCredentialRefreshed?(credential: Record<string, unknown>, tokenExpiresAt?: Date | null): Promise<void>;

  /**
   * Workspace-scoped, already-validated read access to a resolved
   * artifact's bytes (Module 9 Phase 9.5) — supplied per-call by the
   * caller, never held by the provider, since the provider must never
   * touch Prisma or storage credentials directly (mirrors why
   * `PublishingArtifactRef` only ever carries a `mediaAssetPublicId`,
   * never a storage key). Present whenever the channel actually needs
   * media bytes (e.g. YouTube's resumable upload); a text-only channel
   * like WordPress never reads this.
   */
  mediaReader?: PublishingMediaReader;
}

/**
 * Module 9 Phase 9.5 — the minimal, framework-free seam a real
 * (byte-transferring) connector uses to read a resolved artifact's
 * bytes, WITHOUT the connector itself ever depending on `@myev/worker-core`
 * (a NestJS package — `@myev/shared` must stay framework-free) or
 * knowing anything about S3/MinIO/object keys. Each process supplies its
 * own concrete, workspace-scoped implementation (apps/worker wraps its
 * own `MediaStorageService`); `mediaAssetPublicId` is resolved to a real,
 * workspace-scoped, ACTIVE `MediaAsset` row — and only then to a storage
 * object key — entirely inside that implementation, never by the
 * provider. Reading a bounded range at a time (never a single
 * `readRange` call for the whole object) is what keeps a connector's own
 * memory usage bounded regardless of the underlying file's size.
 */
export interface PublishingMediaReader {
  headObject(mediaAssetPublicId: string): Promise<{ sizeBytes: number; contentType?: string }>;
  /** Reads exactly the inclusive byte range `[start, end]` — never the whole object in one call. */
  readRange(mediaAssetPublicId: string, start: number, end: number): Promise<Buffer>;
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
  /** Module 9 Phase 9.5 — the most recently `saveCheckpoint()`-persisted, non-secret detail bag for THIS target (any earlier attempt generation), if any. See `PublishingExecutionCallbacks.saveCheckpoint`'s own doc comment. Undefined on a target's first-ever attempt, or for a provider that never checkpoints (e.g. WordPress). */
  priorCheckpoint?: Record<string, unknown>;
}

export interface PublishingPublishResult {
  externalContentId: string;
  externalUrl?: string;
}
