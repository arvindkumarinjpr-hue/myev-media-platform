import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "./publishing-provider-error";
import type {
  PublishingChannelCapabilities,
  PublishingChannelProvider,
  PublishingConnectionCheckInput,
  PublishingConnectionValidationResult,
  PublishingPublishInput,
  PublishingPublishResult,
} from "./publishing-provider.interface";
import type { PublishingChannelType } from "./publishing-types";

export type FixturePublishOutcome = "success" | "retryable" | "permanent";

/**
 * Module 9 Phase 9.2/9.3 — a deterministic PublishingChannelProvider for
 * tests only, mirroring `FakeProvider`/`VideoUatFixtureProvider`'s own
 * precedent (packages/shared/src/ai-provider/providers/) and
 * FakeResearchSourceProvider's (apps/api/src/modules/research/): zero
 * network dependency, fully predictable, per-instance behavior driven by
 * plain constructor overrides.
 *
 * NEVER registered by either process's production registry factory —
 * only ever wired in via NestJS's overrideProvider (apps/api) or a
 * worker-test-local registry build (apps/worker), the same pattern
 * RESEARCH_SOURCE_PROVIDER already established.
 */
export class FixturePublishingChannelProvider implements PublishingChannelProvider {
  readonly channelType: PublishingChannelType;
  private readonly capabilities: PublishingChannelCapabilities;
  private readonly resolveConnectionHealth: (input: PublishingConnectionCheckInput) => PublishingConnectionValidationResult;
  private readonly resolvePublishOutcome: (input: PublishingPublishInput) => FixturePublishOutcome;

  constructor(options: {
    channelType: PublishingChannelType;
    capabilities?: Partial<PublishingChannelCapabilities>;
    resolveConnectionHealth?: (input: PublishingConnectionCheckInput) => PublishingConnectionValidationResult;
    resolvePublishOutcome?: (input: PublishingPublishInput) => FixturePublishOutcome;
  }) {
    this.channelType = options.channelType;
    this.capabilities = {
      supportedContentTypes: ["BLOG", "VIDEO"],
      requiresRenderedMedia: true,
      requiresTitle: true,
      requiresDescription: true,
      supportsTags: true,
      supportsCaption: true,
      supportedPrivacyOptions: ["PUBLIC", "PRIVATE"],
      ...options.capabilities,
    };
    this.resolveConnectionHealth = options.resolveConnectionHealth ?? (() => ({ healthy: true }));
    this.resolvePublishOutcome = options.resolvePublishOutcome ?? (() => "success");
  }

  getCapabilities(): PublishingChannelCapabilities {
    return this.capabilities;
  }

  async validateConnection(input: PublishingConnectionCheckInput): Promise<PublishingConnectionValidationResult> {
    // No plaintext ever leaves this call: the fixture reads only
    // whatever field a test put in decryptedCredential (e.g. a
    // "simulateOutcome" marker), never persists or logs it.
    return this.resolveConnectionHealth(input);
  }

  async publish(input: PublishingPublishInput, decryptedCredential: Record<string, unknown>): Promise<PublishingPublishResult> {
    // The fixture never inspects credential material to decide its
    // outcome (see resolvePublishOutcome) — this keeps the parameter
    // referenced without eslint's no-unused-vars firing on it, no
    // different from any real connector that legitimately would use it.
    void decryptedCredential;
    const outcome = this.resolvePublishOutcome(input);
    if (outcome === "retryable") {
      throw new PublishingProviderRetryableError("FIXTURE_RETRYABLE_ERROR", "Fixture provider simulated a transient/retryable failure.");
    }
    if (outcome === "permanent") {
      throw new PublishingProviderPermanentError("FIXTURE_PERMANENT_ERROR", "Fixture provider simulated a permanent/non-retryable failure.");
    }
    return {
      externalContentId: `fixture-${this.channelType.toLowerCase()}-${input.operationToken}`,
      externalUrl: input.artifact ? `https://fixture.invalid/${this.channelType.toLowerCase()}/${input.artifact.mediaAssetPublicId}` : undefined,
    };
  }
}
