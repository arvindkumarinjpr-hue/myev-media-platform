import { PublishingProviderRegistry, PublishingProviderRegistryBuilder } from "@myev/shared";

export const PUBLISHING_PROVIDER_REGISTRY = Symbol("PUBLISHING_PROVIDER_REGISTRY");

/**
 * Module 9 Phase 9.2 — the production registry factory. Registers zero
 * real channel providers today: no WordPress/YouTube/Facebook/Instagram
 * connector exists yet (Part U — that's later phases). Returns a frozen,
 * empty registry, exactly like `ai-provider-client-factory.ts` skips
 * registering any AI provider whose API key env var is absent — every
 * `PublishingProviderRegistry.resolve(channelType)` call cleanly throws
 * a typed "not registered" error rather than the platform failing to
 * boot (Part H). A later phase adds one `if (config...) builder.
 * register(new WordPressProvider(...))` per real connector here, never
 * changing this factory's shape.
 *
 * Deliberately NOT moved to `@myev/shared` in Phase 9.3's Milestone A
 * extraction (unlike the Builder/Registry classes themselves) — this is
 * the per-process, config-driven wiring layer, mirroring
 * `ai-provider-client-factory.ts`'s own precedent of being duplicated
 * per process rather than shared. apps/worker gets its own analogous
 * file reading its own config.
 */
export function buildPublishingProviderRegistry(): PublishingProviderRegistry {
  const builder = new PublishingProviderRegistryBuilder();
  return builder.freeze();
}
