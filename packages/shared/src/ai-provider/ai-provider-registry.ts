import type { AIProvider } from "./ai-provider.interface";

export class AIProviderRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderRegistryValidationError";
  }
}

/**
 * Mirrors QueueRegistryBuilder's own discipline exactly
 * (packages/shared/src/queue/queue-registry.ts) — the same
 * accumulate-then-freeze pattern already proven in Module 1F, reused
 * rather than reinvented: register providers during a single process's
 * own bootstrap, `.freeze()` once, get back an immutable registry.
 * "Immutable" is per-process, same caveat as QueueRegistry — there is no
 * cross-process shared mutable state.
 */
export class AIProviderRegistryBuilder {
  private readonly providers = new Map<string, AIProvider>();
  private frozen = false;

  register(provider: AIProvider): void {
    if (this.frozen) throw new AIProviderRegistryValidationError("registry is already frozen — cannot register after bootstrap");
    if (!provider.id) throw new AIProviderRegistryValidationError("provider must have a non-empty id");
    if (this.providers.has(provider.id)) {
      throw new AIProviderRegistryValidationError(`duplicate provider registration: "${provider.id}"`);
    }
    this.providers.set(provider.id, provider);
  }

  freeze(): AIProviderRegistry {
    if (this.frozen) throw new AIProviderRegistryValidationError("registry is already frozen");
    this.frozen = true;
    return new AIProviderRegistry(new Map(this.providers));
  }
}

/** The frozen result of AIProviderRegistryBuilder.freeze() — no public mutator exists on this class at all. */
export class AIProviderRegistry {
  constructor(private readonly providers: ReadonlyMap<string, AIProvider>) {}

  /** Throws rather than returning undefined — every call site needs a real provider or a clean, immediate failure, never a silent null a few lines further down. */
  resolve(providerId: string): AIProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AIProviderRegistryValidationError(`unknown provider: "${providerId}"`);
    }
    return provider;
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  list(): AIProvider[] {
    return [...this.providers.values()];
  }
}
