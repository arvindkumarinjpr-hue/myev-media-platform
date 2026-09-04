import type { PublishingChannelType } from "../../../generated/prisma";
import type { PublishingChannelProvider } from "./publishing-provider.interface";

export class PublishingProviderRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishingProviderRegistryValidationError";
  }
}

/**
 * Mirrors AIProviderRegistryBuilder's own discipline exactly
 * (packages/shared/src/ai-provider/ai-provider-registry.ts), which
 * itself mirrors QueueRegistryBuilder — the same accumulate-then-freeze
 * pattern reused rather than reinvented: register providers during a
 * single process's own bootstrap, `.freeze()` once, get back an
 * immutable registry. "Immutable" is per-process, same caveat as those
 * two precedents — there is no cross-process shared mutable state, and
 * no runtime provider mutation after startup (Part F).
 */
export class PublishingProviderRegistryBuilder {
  private readonly providers = new Map<PublishingChannelType, PublishingChannelProvider>();
  private frozen = false;

  register(provider: PublishingChannelProvider): void {
    if (this.frozen) throw new PublishingProviderRegistryValidationError("registry is already frozen — cannot register after bootstrap");
    if (this.providers.has(provider.channelType)) {
      throw new PublishingProviderRegistryValidationError(`duplicate channel registration: "${provider.channelType}"`);
    }
    this.providers.set(provider.channelType, provider);
  }

  freeze(): PublishingProviderRegistry {
    if (this.frozen) throw new PublishingProviderRegistryValidationError("registry is already frozen");
    this.frozen = true;
    return new PublishingProviderRegistry(new Map(this.providers));
  }
}

/** The frozen result of PublishingProviderRegistryBuilder.freeze() — no public mutator exists on this class at all. */
export class PublishingProviderRegistry {
  constructor(private readonly providers: ReadonlyMap<PublishingChannelType, PublishingChannelProvider>) {}

  /** Throws rather than returning undefined — every call site needs a real provider or a clean, immediate, typed failure (see PublishingProviderResolverService), never a silent null a few lines further down. */
  resolve(channelType: PublishingChannelType): PublishingChannelProvider {
    const provider = this.providers.get(channelType);
    if (!provider) {
      throw new PublishingProviderRegistryValidationError(`no publishing provider is registered for channel: "${channelType}"`);
    }
    return provider;
  }

  has(channelType: PublishingChannelType): boolean {
    return this.providers.has(channelType);
  }

  list(): PublishingChannelProvider[] {
    return [...this.providers.values()];
  }
}
