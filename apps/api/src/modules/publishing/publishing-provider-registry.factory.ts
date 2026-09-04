import { Logger } from "@nestjs/common";
import { FacebookChannelProvider, InstagramChannelProvider, PublishingProviderRegistry, PublishingProviderRegistryBuilder, WordPressChannelProvider, YouTubeChannelProvider } from "@myev/shared";

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
 * Module 9 Phase 9.6 adds the two mechanical Meta connectors. Instagram
 * follows WordPress's unconditional pattern (research finding: no
 * platform-level app secret is needed at runtime for its resumable
 * upload path). Facebook follows YouTube's conditional pattern, but
 * gated on Meta's App id alone (no app secret needed either — no OAuth
 * exchange happens in this phase; the App id is required only because
 * Facebook's resumable-upload session endpoint is scoped to `/APP_ID/uploads`).
 *
 * Deliberately NOT moved to `@myev/shared` (unlike the Builder/Registry/
 * provider classes themselves) — this is the per-process wiring layer,
 * mirroring `ai-provider-client-factory.ts`'s own precedent of being
 * duplicated per process rather than shared. apps/worker gets its own
 * analogous file, registering the identical provider classes with
 * identical capabilities (Part T: no capability/auth-parsing drift).
 */
export function buildPublishingProviderRegistry(youtube: { oauthClientId: string; oauthClientSecret: string }, meta: { appId: string }): PublishingProviderRegistry {
  const builder = new PublishingProviderRegistryBuilder();
  builder.register(new WordPressChannelProvider());

  if (youtube.oauthClientId && youtube.oauthClientSecret) {
    builder.register(new YouTubeChannelProvider({ oauthClientId: youtube.oauthClientId, oauthClientSecret: youtube.oauthClientSecret }));
    logger.log("YouTube provider configured.");
  } else {
    logger.warn("YouTube provider not configured — YOUTUBE_OAUTH_CLIENT_ID/YOUTUBE_OAUTH_CLIENT_SECRET are not set.");
  }

  builder.register(new InstagramChannelProvider());

  if (meta.appId) {
    builder.register(new FacebookChannelProvider({ appId: meta.appId }));
    logger.log("Facebook provider configured.");
  } else {
    logger.warn("Facebook provider not configured — META_APP_ID is not set.");
  }

  return builder.freeze();
}
