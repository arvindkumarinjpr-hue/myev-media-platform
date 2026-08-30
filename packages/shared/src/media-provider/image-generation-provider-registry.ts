import type { ImageGenerationProvider } from "./image-generation.contract";

/**
 * Module 7 Phase 7.4 — image-provider registry. Same accumulate-then-
 * freeze discipline as `AIProviderRegistryBuilder` (proven in Module 3),
 * reused not reinvented: register during a single process's bootstrap,
 * `.freeze()` once, get back an immutable registry. Per-process
 * immutability — no cross-process shared mutable state.
 *
 * The registry supports >1 registered adapter (so a future
 * Stability/Imagen fallback needs no structural change) but Phase 7.4
 * does NOT implement provider failover — the caller resolves exactly one
 * configured primary.
 */
export class MediaProviderRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaProviderRegistryValidationError";
  }
}

export class ImageGenerationProviderRegistryBuilder {
  private readonly providers = new Map<string, ImageGenerationProvider>();
  private frozen = false;

  register(provider: ImageGenerationProvider): void {
    if (this.frozen) throw new MediaProviderRegistryValidationError("registry is already frozen — cannot register after bootstrap");
    if (!provider.id) throw new MediaProviderRegistryValidationError("provider must have a non-empty id");
    if (this.providers.has(provider.id)) {
      throw new MediaProviderRegistryValidationError(`duplicate image provider registration: "${provider.id}"`);
    }
    this.providers.set(provider.id, provider);
  }

  freeze(): ImageGenerationProviderRegistry {
    if (this.frozen) throw new MediaProviderRegistryValidationError("registry is already frozen");
    this.frozen = true;
    return new ImageGenerationProviderRegistry(new Map(this.providers));
  }
}

export class ImageGenerationProviderRegistry {
  constructor(private readonly providers: ReadonlyMap<string, ImageGenerationProvider>) {}

  /** Throws rather than returning undefined — every call site needs a real provider or a clean, immediate failure. */
  resolve(providerId: string): ImageGenerationProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new MediaProviderRegistryValidationError(`unknown image provider: "${providerId}"`);
    return provider;
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  list(): ImageGenerationProvider[] {
    return [...this.providers.values()];
  }
}
