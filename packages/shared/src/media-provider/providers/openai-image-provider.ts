import type OpenAI from "openai";
import { MediaProviderError, MediaProviderErrorCode } from "../media-provider-error";
import type {
  ImageAspectRatio,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageModelCapability,
} from "../image-generation.contract";

/**
 * Module 7 Phase 7.4 — OpenAI image adapter (D1 primary: `gpt-image-1`).
 *
 * The `OpenAI` client is INJECTED, never constructed here — this module
 * never reads an API key or any config directly (that happens once, at
 * composition time, in the worker's media-provider client factory),
 * mirroring `OpenAIProvider`'s own injected-client discipline. That is
 * what makes this adapter unit-testable with a plain mock object.
 *
 * Response flow: `gpt-image-1` always returns base64 (`b64_json`) and
 * does not accept a `response_format` param — so this adapter reads
 * `b64_json` directly and never fetches a remote URL. `dall-e-3` (a
 * possible model override) is asked for `b64_json` explicitly. A URL-only
 * response is treated as `MALFORMED_RESPONSE` — Phase 7.4 does not
 * implement the server-side URL-fetch path (it would be the documented
 * SSRF-guarded fallback: static host allowlist, redirects disabled,
 * timeout, size cap, magic-byte verify).
 */

/** gpt-image-1 supported sizes. */
const ASPECT_TO_SIZE: Record<ImageAspectRatio, "1024x1024" | "1536x1024" | "1024x1536"> = {
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "1:1": "1024x1024",
  "4:5": "1024x1536",
};

const SIZE_TO_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1024x1024": { width: 1024, height: 1024 },
  "1536x1024": { width: 1536, height: 1024 },
  "1024x1536": { width: 1024, height: 1536 },
};

export interface OpenAiImageProviderConfig {
  /** e.g. "gpt-image-1". Kept in config so a model bump is a deploy change, not a code change. */
  readonly model: string;
  /** Optional per-image price for cost estimation — omitted means costEstimate stays absent (never fabricated). */
  readonly costPerImage?: number;
}

export class OpenAiImageProvider implements ImageGenerationProvider {
  readonly id = "openai";

  constructor(
    private readonly client: OpenAI,
    private readonly config: OpenAiImageProviderConfig,
  ) {}

  async generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const size = ASPECT_TO_SIZE[request.aspectRatio];
    const isDallE = this.config.model.startsWith("dall-e");

    // Compose the final prompt string here (style guidance appended) —
    // the caller already resolved the concept/scene text; this only folds
    // in brand/style direction the contract carries as a separate field.
    const prompt = request.styleGuidance ? `${request.prompt}\n\nStyle direction: ${request.styleGuidance}` : request.prompt;

    let response: OpenAI.Images.ImagesResponse;
    try {
      response = await this.client.images.generate(
        {
          model: this.config.model,
          prompt,
          size,
          n: 1,
          ...(request.transparentBackground ? { background: "transparent" as const } : {}),
          // gpt-image-1 rejects response_format; dall-e-* needs it to return base64.
          ...(isDallE ? { response_format: "b64_json" as const } : {}),
        },
        { signal },
      );
    } catch (err) {
      throw this.normalize(err, signal);
    }

    const first = response.data?.[0];
    const b64 = first?.b64_json;
    if (!b64) {
      throw new MediaProviderError(
        MediaProviderErrorCode.MALFORMED_RESPONSE,
        first?.url
          ? "Image provider returned a URL instead of image bytes; URL ingestion is not enabled in this phase."
          : "Image provider returned no image data.",
        this.id,
      );
    }

    const imageBytes = Buffer.from(b64, "base64");
    if (imageBytes.length === 0) {
      throw new MediaProviderError(MediaProviderErrorCode.MALFORMED_RESPONSE, "Image provider returned empty image bytes.", this.id);
    }

    const dims = SIZE_TO_DIMENSIONS[size] ?? SIZE_TO_DIMENSIONS["1024x1024"];
    return {
      imageBytes,
      // gpt-image-1 returns PNG; dall-e-3 b64 is PNG too. The MediaAsset
      // finalize path re-verifies this against magic bytes regardless.
      mimeType: "image/png",
      width: dims.width,
      height: dims.height,
      provider: this.id,
      model: this.config.model,
      usage: { imageCount: 1, size },
      ...(this.config.costPerImage !== undefined ? { costEstimate: this.config.costPerImage } : {}),
      correlationId: request.correlationId,
    };
  }

  getCapabilities(): ImageModelCapability[] {
    return [
      {
        model: this.config.model,
        aspectRatios: ["16:9", "9:16", "1:1", "4:5"],
        supportsTransparency: true,
        ...(this.config.costPerImage !== undefined ? { costPerImage: this.config.costPerImage } : {}),
      },
    ];
  }

  /** Maps an OpenAI SDK error into the media-provider taxonomy — never re-throws a raw SDK error. */
  private normalize(err: unknown, signal?: AbortSignal): MediaProviderError {
    if (signal?.aborted) {
      return new MediaProviderError(MediaProviderErrorCode.TIMEOUT, "Image generation exceeded its time budget.", this.id);
    }
    const status: number | undefined = typeof err === "object" && err !== null && "status" in err ? (err as { status?: number }).status : undefined;
    const providerRequestId: string | undefined =
      typeof err === "object" && err !== null && "request_id" in err ? (err as { request_id?: string }).request_id : undefined;
    const meta = { httpStatus: status, providerRequestId };

    if (status === 401 || status === 403) {
      return new MediaProviderError(MediaProviderErrorCode.AUTH_CONFIG, "Image provider rejected the credentials.", this.id, meta);
    }
    if (status === 400 || status === 422) {
      return new MediaProviderError(MediaProviderErrorCode.INVALID_REQUEST, "Image provider rejected the request as invalid.", this.id, meta);
    }
    if (status === 429) {
      return new MediaProviderError(MediaProviderErrorCode.RATE_LIMIT, "Image provider rate limit reached.", this.id, meta);
    }
    if (status !== undefined && status >= 500) {
      return new MediaProviderError(MediaProviderErrorCode.PROVIDER_UNAVAILABLE, "Image provider is temporarily unavailable.", this.id, meta);
    }
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("content") && (message.includes("policy") || message.includes("moderat") || message.includes("safety"))) {
      return new MediaProviderError(MediaProviderErrorCode.CONTENT_MODERATION, "Image prompt was rejected by content policy.", this.id, meta);
    }
    if (message.includes("timeout") || message.includes("aborted") || message.includes("econnreset")) {
      return new MediaProviderError(MediaProviderErrorCode.TRANSIENT_NETWORK, "Network failure reaching the image provider.", this.id, meta);
    }
    return new MediaProviderError(MediaProviderErrorCode.UNKNOWN, "Image generation failed.", this.id, meta);
  }
}
