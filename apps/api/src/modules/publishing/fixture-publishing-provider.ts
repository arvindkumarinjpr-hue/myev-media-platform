import type {
  PublishingChannelCapabilities,
  PublishingChannelProvider,
  PublishingConnectionCheckInput,
  PublishingConnectionValidationResult,
  PublishingPublishInput,
  PublishingPublishResult,
} from "./publishing-provider.interface";
import type { PublishingChannelType } from "../../../generated/prisma";

/**
 * Module 9 Phase 9.2 — a deterministic PublishingChannelProvider for
 * tests only, mirroring FakeResearchSourceProvider's own precedent
 * exactly (apps/api/src/modules/research/fake-research-source-provider.
 * ts): zero network dependency, fully predictable, per-instance
 * behavior driven by plain constructor overrides rather than a mode
 * enum (connection health varies per channel-account-id within one
 * suite, unlike Research's single-mode case).
 *
 * NEVER registered by publishing-provider-registry.factory.ts's
 * production build — only ever wired in via NestJS's overrideProvider
 * on PUBLISHING_PROVIDER_REGISTRY in test setup (same established
 * pattern as RESEARCH_SOURCE_PROVIDER in research.e2e-spec.ts).
 */
export class FixturePublishingChannelProvider implements PublishingChannelProvider {
  readonly channelType: PublishingChannelType;
  private readonly capabilities: PublishingChannelCapabilities;
  private readonly resolveConnectionHealth: (input: PublishingConnectionCheckInput) => PublishingConnectionValidationResult;

  constructor(options: {
    channelType: PublishingChannelType;
    capabilities?: Partial<PublishingChannelCapabilities>;
    resolveConnectionHealth?: (input: PublishingConnectionCheckInput) => PublishingConnectionValidationResult;
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

  async publish(input: PublishingPublishInput, _decryptedCredential: Record<string, unknown>): Promise<PublishingPublishResult> {
    return {
      externalContentId: `fixture-${this.channelType.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`,
      externalUrl: input.artifact ? `https://fixture.invalid/${this.channelType.toLowerCase()}/${input.artifact.mediaAssetPublicId}` : undefined,
    };
  }
}
