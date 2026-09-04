import { derivePublishingReadiness, isPublishingCredentialExpired, type PublishingReadinessFacts } from "./publishing-readiness-core";
import type { PublishingChannelCapabilities } from "./publishing-provider.interface";

function baseFacts(overrides: Partial<PublishingReadinessFacts> = {}): PublishingReadinessFacts {
  return {
    contentType: "BLOG",
    contentStatus: "APPROVED",
    contentDeletedAt: null,
    contentTitle: "A ready title",
    channelConnectionStatus: "CONNECTED",
    channelTokenExpiresAt: null,
    connectionHealthResult: { healthy: true },
    blogArticleExists: true,
    blogMetaDescription: "A ready description",
    videoLatestRenderStatus: null,
    videoOutputMediaAssetPublicId: null,
    videoOutputMediaAssetStatus: null,
    ...overrides,
  };
}

function blogCapabilities(overrides: Partial<PublishingChannelCapabilities> = {}): PublishingChannelCapabilities {
  return {
    supportedContentTypes: ["BLOG"],
    requiresRenderedMedia: false,
    requiresTitle: true,
    requiresDescription: true,
    supportsTags: true,
    supportsCaption: true,
    ...overrides,
  };
}

function videoCapabilities(overrides: Partial<PublishingChannelCapabilities> = {}): PublishingChannelCapabilities {
  return {
    supportedContentTypes: ["VIDEO"],
    requiresRenderedMedia: true,
    requiresTitle: true,
    requiresDescription: false,
    supportsTags: true,
    supportsCaption: true,
    ...overrides,
  };
}

describe("isPublishingCredentialExpired", () => {
  it("is false for a null expiry", () => {
    expect(isPublishingCredentialExpired(null)).toBe(false);
  });
  it("is false for a future expiry", () => {
    expect(isPublishingCredentialExpired(new Date(Date.now() + 60_000))).toBe(false);
  });
  it("is true for a past expiry", () => {
    expect(isPublishingCredentialExpired(new Date(Date.now() - 60_000))).toBe(true);
  });
});

describe("derivePublishingReadiness — provider not configured", () => {
  it("returns PROVIDER_NOT_CONFIGURED and skips every other check when capabilities is null", () => {
    const result = derivePublishingReadiness(baseFacts({ contentStatus: "DRAFT" }), null);
    expect(result.ready).toBe(false);
    expect(result.blockingReasons).toEqual(["PROVIDER_NOT_CONFIGURED"]);
  });
});

describe("derivePublishingReadiness — Blog", () => {
  it("is ready for an approved Blog with an article, connected account, and required metadata", () => {
    const result = derivePublishingReadiness(baseFacts(), blogCapabilities());
    expect(result.ready).toBe(true);
    expect(result.blockingReasons).toEqual([]);
    expect(result.metadata.title).toBe("A ready title");
    expect(result.metadata.description).toBe("A ready description");
  });

  it.each(["DRAFT", "IN_PROGRESS", "REVIEW", "ARCHIVED"])("rejects a %s Blog — CONTENT_NOT_APPROVED", (status) => {
    const result = derivePublishingReadiness(baseFacts({ contentStatus: status }), blogCapabilities());
    expect(result.ready).toBe(false);
    expect(result.blockingReasons).toContain("CONTENT_NOT_APPROVED");
  });

  it("rejects a deleted Blog — CONTENT_DELETED, not CONTENT_NOT_APPROVED", () => {
    const result = derivePublishingReadiness(baseFacts({ contentDeletedAt: new Date() }), blogCapabilities());
    expect(result.blockingReasons).toEqual(["CONTENT_DELETED"]);
  });

  it("rejects a Blog with no BlogArticle row — BLOG_ARTICLE_MISSING", () => {
    const result = derivePublishingReadiness(baseFacts({ blogArticleExists: false }), blogCapabilities());
    expect(result.blockingReasons).toContain("BLOG_ARTICLE_MISSING");
  });

  it("rejects an unsupported channel — CHANNEL_NOT_SUPPORTED", () => {
    const result = derivePublishingReadiness(baseFacts({ contentType: "VIDEO" }), blogCapabilities());
    expect(result.blockingReasons).toContain("CHANNEL_NOT_SUPPORTED");
  });

  it("rejects a disconnected account — CHANNEL_ACCOUNT_NOT_CONNECTED", () => {
    const result = derivePublishingReadiness(baseFacts({ channelConnectionStatus: "EXPIRED" }), blogCapabilities());
    expect(result.blockingReasons).toContain("CHANNEL_ACCOUNT_NOT_CONNECTED");
  });

  it("rejects an expired credential without needing a connectionHealthResult — CREDENTIAL_EXPIRED", () => {
    const result = derivePublishingReadiness(baseFacts({ channelTokenExpiresAt: new Date(Date.now() - 1000), connectionHealthResult: null }), blogCapabilities());
    expect(result.blockingReasons).toContain("CREDENTIAL_EXPIRED");
  });

  it("treats a missing connectionHealthResult (adapter didn't check) as unhealthy — CREDENTIAL_UNAVAILABLE, fail-closed", () => {
    const result = derivePublishingReadiness(baseFacts({ connectionHealthResult: null }), blogCapabilities());
    expect(result.blockingReasons).toContain("CREDENTIAL_UNAVAILABLE");
  });

  it.each([
    ["CREDENTIAL_REVOKED", "CREDENTIAL_INVALID"],
    ["CREDENTIAL_INVALID", "CREDENTIAL_INVALID"],
    ["PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE"],
  ] as const)("maps a provider-reported %s to readiness reason %s", (providerReason, expectedReason) => {
    const result = derivePublishingReadiness(baseFacts({ connectionHealthResult: { healthy: false, reasonCode: providerReason } }), blogCapabilities());
    expect(result.blockingReasons).toContain(expectedReason);
  });

  it("rejects missing required metadata — REQUIRED_METADATA_MISSING", () => {
    const result = derivePublishingReadiness(baseFacts({ blogMetaDescription: "" }), blogCapabilities());
    expect(result.blockingReasons).toContain("REQUIRED_METADATA_MISSING");
  });

  it("never pushes REQUIRED_METADATA_MISSING twice even when both title and description are missing", () => {
    const result = derivePublishingReadiness(baseFacts({ contentTitle: "", blogMetaDescription: "" }), blogCapabilities());
    expect(result.blockingReasons.filter((r) => r === "REQUIRED_METADATA_MISSING")).toHaveLength(1);
  });

  it("accumulates multiple independent blocking reasons in one pass", () => {
    const result = derivePublishingReadiness(baseFacts({ contentStatus: "DRAFT", blogArticleExists: false, channelConnectionStatus: "REVOKED" }), blogCapabilities());
    expect(result.blockingReasons).toEqual(expect.arrayContaining(["CONTENT_NOT_APPROVED", "BLOG_ARTICLE_MISSING", "CHANNEL_ACCOUNT_NOT_CONNECTED"]));
    expect(result.ready).toBe(false);
  });
});

describe("derivePublishingReadiness — Video", () => {
  function readyVideoFacts(overrides: Partial<PublishingReadinessFacts> = {}): PublishingReadinessFacts {
    return baseFacts({
      contentType: "VIDEO",
      videoLatestRenderStatus: "COMPLETED",
      videoOutputMediaAssetPublicId: "asset-1",
      videoOutputMediaAssetStatus: "ACTIVE",
      ...overrides,
    });
  }

  it("is ready for an approved Video with a COMPLETED render and ACTIVE output asset", () => {
    const result = derivePublishingReadiness(readyVideoFacts(), videoCapabilities());
    expect(result.ready).toBe(true);
    expect(result.resolvedArtifact).toEqual({ mediaAssetPublicId: "asset-1" });
  });

  it("rejects no render job at all — RENDER_NOT_READY", () => {
    const result = derivePublishingReadiness(readyVideoFacts({ videoLatestRenderStatus: null }), videoCapabilities());
    expect(result.blockingReasons).toContain("RENDER_NOT_READY");
    expect(result.resolvedArtifact).toBeNull();
  });

  it.each(["QUEUED", "RUNNING", "FAILED", "TIMED_OUT"] as const)("rejects a %s render job — RENDER_NOT_READY", (status) => {
    const result = derivePublishingReadiness(readyVideoFacts({ videoLatestRenderStatus: status }), videoCapabilities());
    expect(result.blockingReasons).toContain("RENDER_NOT_READY");
  });

  it("rejects a COMPLETED render with no output asset pointer — MEDIA_ASSET_MISSING", () => {
    const result = derivePublishingReadiness(readyVideoFacts({ videoOutputMediaAssetPublicId: null, videoOutputMediaAssetStatus: null }), videoCapabilities());
    expect(result.blockingReasons).toContain("MEDIA_ASSET_MISSING");
  });

  it("rejects an output asset pointer whose row was not found — MEDIA_ASSET_MISSING", () => {
    const result = derivePublishingReadiness(readyVideoFacts({ videoOutputMediaAssetStatus: null }), videoCapabilities());
    expect(result.blockingReasons).toContain("MEDIA_ASSET_MISSING");
  });

  it("rejects a non-ACTIVE output asset — MEDIA_ASSET_INELIGIBLE", () => {
    const result = derivePublishingReadiness(readyVideoFacts({ videoOutputMediaAssetStatus: "QUARANTINED" }), videoCapabilities());
    expect(result.blockingReasons).toContain("MEDIA_ASSET_INELIGIBLE");
  });

  it("skips render/media checks entirely when the channel does not requireRenderedMedia", () => {
    const result = derivePublishingReadiness(readyVideoFacts({ videoLatestRenderStatus: null }), videoCapabilities({ requiresRenderedMedia: false }));
    expect(result.blockingReasons).not.toContain("RENDER_NOT_READY");
  });

  it("rejects an unsupported channel — CHANNEL_NOT_SUPPORTED", () => {
    const result = derivePublishingReadiness(readyVideoFacts(), blogCapabilities());
    expect(result.blockingReasons).toContain("CHANNEL_NOT_SUPPORTED");
  });
});

describe("derivePublishingReadiness — purity", () => {
  it("never mutates the facts object it is given", () => {
    const facts = baseFacts();
    const frozen = Object.freeze({ ...facts });
    expect(() => derivePublishingReadiness(frozen, blogCapabilities())).not.toThrow();
  });
});
