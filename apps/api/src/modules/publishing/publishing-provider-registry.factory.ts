import { Logger } from "@nestjs/common";
import { PublishingProviderRegistry, PublishingProviderRegistryBuilder, WordPressChannelProvider, YouTubeChannelProvider } from "@myev/shared";

export const PUBLISHING_PROVIDER_REGISTRY = Symbol("PUBLISHING_PROVIDER_REGISTRY");

const logger = new Logger("PublishingProviderRegistryFactory");

/**
 * Module 9 Phase 9.2/9.4/9.5 — the production registry factory.
 *
 * Module 9 Phase 9.4 added the first real channel provider: WordPress.
 * Unlike an AI provider (gated behind a platform-level API key env var,
 * `ai-provider-client-factory.ts`'s own precedent), WordPress credentials
 * are per-workspace-account (`ChannelCredential`, decrypted per-call) —
 * there is no platform-wide secret to gate on, so `WordPressChannelProvider`
 * is registered unconditionally. A workspace with no connected WordPress
 * account still cleanly fails readiness/`CHANNEL_ACCOUNT_NOT_CONNECTED`,
 * never a registry lookup failure — registering the provider only makes
 * the CAPABILITY available, it does not imply any account is connected.
 *
 * Module 9 Phase 9.5 adds the second real channel provider: YouTube.
 * UNLIKE WordPress, this genuinely IS gated behind a platform secret —
 * refreshing a workspace's OAuth access token requires the platform's
 * OWN Google OAuth client id/secret (registered once in Google's API
 * console), not anything per-workspace. This mirrors `ai-provider-
 * client-factory.ts`'s own "an unconfigured provider is simply skipped,
 * never registered with an invalid client" convention exactly, rather
 * than WordPress's unconditional pattern.
 *
 * No other real connector exists yet (Facebook/Instagram — later
 * phases). A later phase adds one more `builder.register(new
 * XProvider(...))` line here, never changing this factory's shape.
 *
 * Deliberately NOT moved to `@myev/shared` (unlike the Builder/Registry/
 * provider classes themselves) — this is the per-process wiring layer,
 * mirroring `ai-provider-client-factory.ts`'s own precedent of being
 * duplicated per process rather than shared. apps/worker gets its own
 * analogous file, registering the identical provider classes with
 * identical capabilities (Part T: no capability/auth-parsing drift).
 */
export function buildPublishingProviderRegistry(youtube: { oauthClientId: string; oauthClientSecret: string }): PublishingProviderRegistry {
  const builder = new PublishingProviderRegistryBuilder();
  builder.register(new WordPressChannelProvider());

  if (youtube.oauthClientId && youtube.oauthClientSecret) {
    builder.register(new YouTubeChannelProvider({ oauthClientId: youtube.oauthClientId, oauthClientSecret: youtube.oauthClientSecret }));
    logger.log("YouTube provider configured.");
  } else {
    logger.warn("YouTube provider not configured — YOUTUBE_OAUTH_CLIENT_ID/YOUTUBE_OAUTH_CLIENT_SECRET are not set.");
  }

  return builder.freeze();
}
