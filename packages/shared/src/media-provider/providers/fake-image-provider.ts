import { MediaProviderError, MediaProviderErrorCode } from "../media-provider-error";
import type { ImageAspectRatio, ImageGenerationProvider, ImageGenerationRequest, ImageGenerationResult, ImageModelCapability } from "../image-generation.contract";

export type FakeImageMode = "success" | "transient_error" | "permanent_error" | "moderation" | "timeout" | "rate_limit" | "flaky_then_success";

const ASPECT_DIMENSIONS: Record<ImageAspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1536, height: 864 },
  "9:16": { width: 864, height: 1536 },
  "1:1": { width: 1024, height: 1024 },
  "4:5": { width: 1024, height: 1280 },
};

// Minimal but real 1x1 PNG — passes the magic-byte sniffer (`image/png`).
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Module 7 Phase 7.4 — deterministic fake image provider for
 * unit/integration/E2E. Zero spend, zero network. Mode is per-instance
 * (mirrors `FakeProvider`). `flaky_then_success` is stateful across calls
 * on one instance so a durable-retry test genuinely proves "transient
 * failure -> retry -> success on the same job".
 */
export class FakeImageProvider implements ImageGenerationProvider {
  readonly id: string;
  private callCount = 0;

  constructor(
    private readonly mode: FakeImageMode = "success",
    private readonly failuresBeforeSuccess = 1,
    id = "fake-image",
  ) {
    this.id = id;
  }

  async generate(request: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult> {
    if (signal?.aborted) {
      throw new MediaProviderError(MediaProviderErrorCode.TIMEOUT, "Request was aborted before the fake image provider could respond.", this.id);
    }

    if (this.mode === "flaky_then_success") {
      this.callCount += 1;
      if (this.callCount <= this.failuresBeforeSuccess) {
        throw new MediaProviderError(MediaProviderErrorCode.TRANSIENT_NETWORK, `Fake image provider: simulated transient failure (${this.callCount}/${this.failuresBeforeSuccess}).`, this.id);
      }
    }

    switch (this.mode) {
      case "transient_error":
        throw new MediaProviderError(MediaProviderErrorCode.PROVIDER_UNAVAILABLE, "Fake image provider: simulated provider outage.", this.id);
      case "permanent_error":
        throw new MediaProviderError(MediaProviderErrorCode.INVALID_REQUEST, "Fake image provider: simulated invalid request.", this.id);
      case "moderation":
        throw new MediaProviderError(MediaProviderErrorCode.CONTENT_MODERATION, "Fake image provider: prompt rejected by content policy.", this.id);
      case "timeout":
        throw new MediaProviderError(MediaProviderErrorCode.TIMEOUT, "Fake image provider: simulated timeout.", this.id);
      case "rate_limit":
        throw new MediaProviderError(MediaProviderErrorCode.RATE_LIMIT, "Fake image provider: simulated rate limit.", this.id, { retryAfterSeconds: 1 });
    }

    const dims = request.dimensionsHint ?? ASPECT_DIMENSIONS[request.aspectRatio];
    return {
      imageBytes: ONE_PX_PNG,
      mimeType: "image/png",
      width: dims.width,
      height: dims.height,
      provider: this.id,
      model: "fake-image-model-1",
      usage: { imageCount: 1, size: `${dims.width}x${dims.height}` },
      providerRequestId: `fake-img-${request.correlationId}`,
      correlationId: request.correlationId,
    };
  }

  getCapabilities(): ImageModelCapability[] {
    return [{ model: "fake-image-model-1", aspectRatios: ["16:9", "9:16", "1:1", "4:5"], supportsTransparency: true }];
  }
}
