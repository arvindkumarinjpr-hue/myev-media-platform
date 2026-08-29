import { MediaProviderRegistryValidationError } from "./image-generation-provider-registry";
import type { TtsProvider } from "./tts.contract";

/**
 * Module 7 Phase 7.4 — TTS-provider registry. Identical accumulate-then-
 * freeze discipline as `ImageGenerationProviderRegistryBuilder`; shares
 * the same `MediaProviderRegistryValidationError`.
 */
export class TtsProviderRegistryBuilder {
  private readonly providers = new Map<string, TtsProvider>();
  private frozen = false;

  register(provider: TtsProvider): void {
    if (this.frozen) throw new MediaProviderRegistryValidationError("registry is already frozen — cannot register after bootstrap");
    if (!provider.id) throw new MediaProviderRegistryValidationError("provider must have a non-empty id");
    if (this.providers.has(provider.id)) {
      throw new MediaProviderRegistryValidationError(`duplicate TTS provider registration: "${provider.id}"`);
    }
    this.providers.set(provider.id, provider);
  }

  freeze(): TtsProviderRegistry {
    if (this.frozen) throw new MediaProviderRegistryValidationError("registry is already frozen");
    this.frozen = true;
    return new TtsProviderRegistry(new Map(this.providers));
  }
}

export class TtsProviderRegistry {
  constructor(private readonly providers: ReadonlyMap<string, TtsProvider>) {}

  resolve(providerId: string): TtsProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new MediaProviderRegistryValidationError(`unknown TTS provider: "${providerId}"`);
    return provider;
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  list(): TtsProvider[] {
    return [...this.providers.values()];
  }
}
