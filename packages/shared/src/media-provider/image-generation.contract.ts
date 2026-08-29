/**
 * Module 7 Phase 7.4 — provider-neutral image-generation contract.
 *
 * The image analogue of `ai-provider/ai-request.ts` + `ai-response.ts`.
 * Plain interfaces, not class-validator DTOs — exactly like AIRequest/
 * AIResponse. No OpenAI / Stability / vendor SDK type appears here; an
 * adapter's own module is the only place a vendor SDK is imported.
 *
 * The pipeline never calls a provider directly — it enqueues a
 * `media.image.generate.v1` job; a MEDIA-queue worker processor resolves
 * the adapter from `ImageGenerationProviderRegistry` and calls
 * `generate()`.
 */

/** Provider-neutral aspect ratios — an adapter maps each to the nearest size its model supports. */
export type ImageAspectRatio = "16:9" | "9:16" | "1:1" | "4:5";

export interface ImageGenerationRequest {
  /** Fully-assembled prompt text. This layer does no prompt construction of its own. */
  readonly prompt: string;
  readonly aspectRatio: ImageAspectRatio;
  /** Honored only where the provider supports arbitrary output sizes; otherwise advisory. */
  readonly dimensionsHint?: { readonly width: number; readonly height: number };
  /** Brand / style text passed through verbatim — never interpreted by this layer. */
  readonly styleGuidance?: string;
  /** Request transparency where the provider/model supports it (e.g. logo/overlay assets). */
  readonly transparentBackground?: boolean;

  readonly workspaceId: string;
  readonly contentItemId?: string;
  /** Carried into the result and every log line; never interpreted. */
  readonly correlationId: string;
  /** Carried into the job fingerprint by the submission layer; never interpreted here. */
  readonly idempotencyKey?: string;
}

export interface ImageGenerationUsage {
  readonly imageCount: number;
  /** e.g. "1024x1024" — the provider's own reported output size string, when available. */
  readonly size?: string;
}

export interface ImageGenerationResult {
  /** The decoded image bytes (base64-decoded from the provider, or fetched under strict controls when the provider is URL-only). */
  readonly imageBytes: Buffer;
  /** Verified against magic bytes before the MediaAsset is made ACTIVE — this is the provider's claim, not the authority. */
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly provider: string;
  readonly model: string;
  readonly usage?: ImageGenerationUsage;
  /** Absent — never fabricated — when no per-image price is configured (mirrors AIResponse.costEstimate). */
  readonly costEstimate?: number;
  readonly providerRequestId?: string;
  readonly correlationId: string;
}

/** Registry-introspection only — never used by `generate()` to pick a model. */
export interface ImageModelCapability {
  readonly model: string;
  readonly aspectRatios: readonly ImageAspectRatio[];
  readonly supportsTransparency: boolean;
  readonly costPerImage?: number;
}

/**
 * The adapter contract every image provider implements. Deliberately
 * minimal — one execution method plus capability introspection — mirrors
 * `AIProvider`.
 */
export interface ImageGenerationProvider {
  /** Stable id this provider registers under — e.g. "openai", "stability". Never a display name, never versioned. */
  readonly id: string;

  /**
   * Generates one image. MUST throw `MediaProviderError` (never a raw SDK
   * error) on any failure. `signal`, when provided, aborts the in-flight
   * call — the only cancellation mechanism this layer defines.
   */
  generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult>;

  getCapabilities(): ImageModelCapability[];
}
