import { PublishingProviderRegistry, PublishingProviderRegistryBuilder, WordPressChannelProvider } from "@myev/shared";

export const PUBLISHING_PROVIDER_REGISTRY = Symbol("PUBLISHING_PROVIDER_REGISTRY");

/**
 * Module 9 Phase 9.2/9.4 — the production registry factory.
 *
 * Module 9 Phase 9.4 adds the first real channel provider: WordPress.
 * Unlike an AI provider (gated behind a platform-level API key env var,
 * `ai-provider-client-factory.ts`'s own precedent), WordPress credentials
 * are per-workspace-account (`ChannelCredential`, decrypted per-call) —
 * there is no platform-wide secret to gate on, so `WordPressChannelProvider`
 * is registered unconditionally. A workspace with no connected WordPress
 * account still cleanly fails readiness/`CHANNEL_ACCOUNT_NOT_CONNECTED`,
 * never a registry lookup failure — registering the provider only makes
 * the CAPABILITY available, it does not imply any account is connected.
 *
 * No other real connector exists yet (YouTube/Facebook/Instagram — later
 * phases). A later phase adds one more `builder.register(new
 * XProvider(...))` line here, never changing this factory's shape.
 *
 * Deliberately NOT moved to `@myev/shared` (unlike the Builder/Registry/
 * WordPressChannelProvider classes themselves) — this is the per-process
 * wiring layer, mirroring `ai-provider-client-factory.ts`'s own precedent
 * of being duplicated per process rather than shared. apps/worker gets
 * its own analogous file, registering the identical provider class with
 * identical capabilities (Part T: no capability/auth-parsing drift).
 */
export function buildPublishingProviderRegistry(): PublishingProviderRegistry {
  const builder = new PublishingProviderRegistryBuilder();
  builder.register(new WordPressChannelProvider());
  return builder.freeze();
}
