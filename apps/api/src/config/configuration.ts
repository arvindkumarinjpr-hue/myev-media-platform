export interface AppConfig {
  env: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  // DEFECT-1F-001: bounds how long BackgroundJobsService's graceful Redis
  // shutdown (Queue.close()/redisConnection.quit()) may wait before
  // falling back to a forced disconnect — see @myev/shared's
  // boundedShutdown. Mirrors apps/worker's identical config key.
  redisShutdownDeadlineMs: number;
  storage: {
    endpoint: string;
    port: number;
    useSsl: boolean;
    accessKey: string;
    secretKey: string;
    bucket: string;
    // Optional, distinct from `endpoint` above: a full base URL
    // (protocol + host + optional path prefix) that a real BROWSER can
    // actually reach, used ONLY to sign presigned download/upload URLs —
    // `endpoint` above stays the fast internal address the API server
    // itself connects through for every other S3 operation. Unset in
    // every environment where `endpoint` is already browser-reachable
    // (local dev, CI); staging/production behind a reverse proxy in
    // front of a non-public object store set this to the public path the
    // proxy forwards through to it.
    publicEndpoint?: string;
  };
  smtp: {
    host: string;
    port: number;
    fromAddress: string;
  };
  appUrl: string;
  auth: {
    jwtSecret: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    familyTtlSeconds: number;
    failedLoginThreshold: number;
    lockWindowSeconds: number;
    resetTokenTtlSeconds: number;
    activationTokenTtlSeconds: number;
    passwordHistoryLimit: number;
  };
  workspace: {
    invitationTtlSeconds: number;
    // Module 1C Engineering Plan §2.F′: platform-configurable, never
    // hardcoded in application logic — these are only the out-of-box
    // values of the env vars below, applied at workspace creation unless
    // the request supplies a valid override.
    platformDefaults: {
      timezone: string;
      locale: string;
      currency: string;
      dateFormat: string;
    };
    resendActivation: {
      perUserLimit: number;
      perUserWindowSeconds: number;
      perWorkspaceLimit: number;
      perWorkspaceWindowSeconds: number;
    };
  };
  media: {
    // Which real-world service Module 1D's storage bytes live in — see
    // MODULE 1D ENGINEERING PLAN §7 "Storage Provider Identity". Stamped
    // onto every media_assets row created while this config is active.
    storageProviderIdentity: string;
    // FRD §21.1 per-asset-type ceilings — the frozen requirement, unchanged.
    maxSizeBytes: {
      image: number;
      audio: number;
      video: number;
      document: number;
      // Module 7 Phase 7.4 — generated caption documents are tiny; a small
      // hard ceiling guards against a runaway subtitle build.
      subtitle: number;
    };
    // ACR (approved): Module 1D's synchronous verification ceiling. The
    // EFFECTIVE per-type max is min(maxSizeBytes[type], this) — only VIDEO
    // is ever actually constrained by it, since Image/Audio/Document's FRD
    // maxima all sit comfortably under the default.
    syncChecksumMaxBytes: number;
    mimeInspectionBytes: number;
    uploadUrlTtlSeconds: number;
    downloadUrlTtlSeconds: number;
    verificationStaleAfterSeconds: number;
    storageOperationTimeoutSeconds: number;
    checksumTimeoutSeconds: number;
    maxVerificationDurationSeconds: number;
    uploadIntent: { limit: number; windowSeconds: number };
    downloadUrl: { limit: number; windowSeconds: number };
    retryVerification: { limit: number; windowSeconds: number };
  };
  videoMedia: {
    voiceCatalogJson: string;
    imageAspectByPlatform: string;
  };
  videoRender: {
    /** Whether the frozen brand config requires a branded intro/outro frame. */
    introRequired: boolean;
    outroRequired: boolean;
    /** Max acceptable drift between the rendered file and the expected timeline (ms). */
    durationToleranceMs: number;
  };
  content: {
    // Module 1E Engineering Plan's Body Validation Contract. No frozen FRD
    // figure exists for these — reasonable, documented ceilings rather
    // than unbounded input, consistent with Module 1D's config-driven
    // (never hardcoded) approach to every other size/shape limit.
    maxBodySizeBytes: number;
    maxBodyDepth: number;
    maxStringValueLength: number;
    // Below this length, a string is never run through the base64-pattern
    // heuristic (Tier 3) — short alphanumeric values (ids, slugs, short
    // codes) legitimately match the base64 character class and would
    // otherwise false-positive. The data-URI prefix check (Tier 2) still
    // applies at any length.
    base64HeuristicMinLength: number;
    // 2000 UTF-8 chars — Module 1E Engineering Plan, "Review Comment
    // Limit" (final approval round). Mirrored by the hand-written
    // content_review_events_comment_check DB constraint as a backstop;
    // this is the value application code validates against first.
    reviewCommentMaxLength: number;
  };
  contentScoring: {
    // Module 6 Phase 6.1 — FR-BLOG-006 / Blog Automation Engine Quality
    // Gate #6 require a content score to "pass a threshold" before human
    // review is triggered, but NO frozen document defines the number.
    //
    // This is therefore an IMPLEMENTATION DEFAULT, not frozen product
    // policy: it is config-driven (never hardcoded in a service or
    // test), it lives here and nowhere else, and the shared scoring
    // domain contract in @myev/shared has no concept of a threshold at
    // all. A later Blog-pipeline phase (or an operator) sets the real
    // value; 70 is a conservative starting point on the 0–100 Overall
    // Content Score scale.
    passThreshold: number;
  };
  internalLinking: {
    // Module 8 Phase 8.2 — IMPLEMENTATION DEFAULTS, not frozen product
    // policy (same status as contentScoring.passThreshold above): no
    // frozen document gives these numbers, so they are config-driven,
    // live here and nowhere else, and are never hardcoded in a service
    // or test.
    //
    // How many workspace-scoped candidates a single generateForSource()
    // call may gather (across all discovery signals combined) before
    // scoring — the hard bound that keeps discovery from ever becoming
    // an unrestricted full-workspace scan.
    candidatePoolLimit: number;
    // A scored candidate below this (0-100) is discarded, never persisted.
    minRelevanceThreshold: number;
    // How many GENERATED rows a single generateForSource() call may
    // create — the top-N surviving candidates by score, after the
    // threshold above is applied.
    maxRecommendationsPerRun: number;
  };
  ai: {
    // Module 3 Phase 3.4 — real vendor credentials, read here only (never
    // in packages/shared, never hardcoded, never sent to the web bundle).
    // An empty apiKey means that provider is left unconfigured: the
    // registry factory simply does not register it, so a request naming
    // it fails cleanly through the existing AIProviderRegistry.resolve()
    // "unknown provider" error rather than crashing platform startup.
    openai: { apiKey: string; model: string };
    anthropic: { apiKey: string; model: string };
    gemini: { apiKey: string; model: string };
  };
}

/**
 * All values are read from environment variables only — no defaults that would
 * silently mask a missing .env in a non-local environment, except sensible
 * local-dev fallbacks used only when NODE_ENV=development.
 *
 * Numeric auth defaults below match the approved Module 1B.1 Engineering
 * Plan §18 (Argon2id params live in password-hash.service.ts directly,
 * not here, since they're not meant to vary by environment).
 */
export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "4000", 10),
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  redisShutdownDeadlineMs: parseInt(process.env.REDIS_SHUTDOWN_DEADLINE_MS ?? "5000", 10),
  storage: {
    endpoint: process.env.STORAGE_ENDPOINT ?? "minio",
    port: parseInt(process.env.STORAGE_PORT ?? "9000", 10),
    useSsl: process.env.STORAGE_USE_SSL === "true",
    accessKey: process.env.STORAGE_ACCESS_KEY ?? "",
    secretKey: process.env.STORAGE_SECRET_KEY ?? "",
    bucket: process.env.STORAGE_BUCKET ?? "myev-media-dev",
    publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT || undefined,
  },
  smtp: {
    host: process.env.SMTP_HOST ?? "mailpit",
    port: parseInt(process.env.SMTP_PORT ?? "1025", 10),
    fromAddress: process.env.SMTP_FROM_ADDRESS ?? "no-reply@myevmedia.com",
  },
  appUrl: process.env.APP_URL ?? "http://localhost:3100",
  auth: {
    jwtSecret: process.env.JWT_ACCESS_SECRET ?? "",
    accessTokenTtlSeconds: parseInt(process.env.ACCESS_TOKEN_TTL_SECONDS ?? "900", 10), // 15 min
    refreshTokenTtlSeconds: parseInt(process.env.REFRESH_TOKEN_TTL_SECONDS ?? "2592000", 10), // 30 days
    familyTtlSeconds: parseInt(process.env.REFRESH_FAMILY_TTL_SECONDS ?? "2592000", 10), // 30 days
    failedLoginThreshold: parseInt(process.env.FAILED_LOGIN_THRESHOLD ?? "5", 10),
    lockWindowSeconds: parseInt(process.env.LOCK_WINDOW_SECONDS ?? "900", 10), // 15 min
    resetTokenTtlSeconds: parseInt(process.env.RESET_TOKEN_TTL_SECONDS ?? "3600", 10), // 1 hour
    activationTokenTtlSeconds: parseInt(process.env.ACTIVATION_TOKEN_TTL_SECONDS ?? "604800", 10), // 7 days
    passwordHistoryLimit: parseInt(process.env.PASSWORD_HISTORY_LIMIT ?? "5", 10),
  },
  workspace: {
    invitationTtlSeconds: parseInt(process.env.WORKSPACE_INVITATION_TTL_SECONDS ?? "604800", 10), // 7 days
    platformDefaults: {
      timezone: process.env.PLATFORM_DEFAULT_TIMEZONE ?? "UTC",
      locale: process.env.PLATFORM_DEFAULT_LOCALE ?? "en-US",
      currency: process.env.PLATFORM_DEFAULT_CURRENCY ?? "USD",
      dateFormat: process.env.PLATFORM_DEFAULT_DATE_FORMAT ?? "YYYY-MM-DD",
    },
    resendActivation: {
      perUserLimit: parseInt(process.env.RESEND_ACTIVATION_PER_USER_LIMIT ?? "5", 10),
      perUserWindowSeconds: parseInt(process.env.RESEND_ACTIVATION_PER_USER_WINDOW_SECONDS ?? "3600", 10),
      perWorkspaceLimit: parseInt(process.env.RESEND_ACTIVATION_PER_WORKSPACE_LIMIT ?? "10", 10),
      perWorkspaceWindowSeconds: parseInt(process.env.RESEND_ACTIVATION_PER_WORKSPACE_WINDOW_SECONDS ?? "3600", 10),
    },
  },
  media: {
    storageProviderIdentity: process.env.STORAGE_PROVIDER_IDENTITY ?? "MINIO",
    maxSizeBytes: {
      image: parseInt(process.env.MEDIA_MAX_SIZE_IMAGE_BYTES ?? "26214400", 10), // 25MB
      audio: parseInt(process.env.MEDIA_MAX_SIZE_AUDIO_BYTES ?? "104857600", 10), // 100MB
      video: parseInt(process.env.MEDIA_MAX_SIZE_VIDEO_BYTES ?? "2147483648", 10), // 2GB (frozen FRD ceiling)
      document: parseInt(process.env.MEDIA_MAX_SIZE_DOCUMENT_BYTES ?? "20971520", 10), // 20MB
      subtitle: parseInt(process.env.MEDIA_MAX_SIZE_SUBTITLE_BYTES ?? "1048576", 10), // 1MB
    },
    // ACR approved 2026-08-06: 500MB default synchronous verification
    // ceiling. Full 2GB VIDEO support is deferred to Queue Engine.
    syncChecksumMaxBytes: parseInt(process.env.MEDIA_SYNC_CHECKSUM_MAX_BYTES ?? "524288000", 10),
    mimeInspectionBytes: parseInt(process.env.MEDIA_MIME_INSPECTION_BYTES ?? "4096", 10),
    uploadUrlTtlSeconds: parseInt(process.env.MEDIA_UPLOAD_URL_TTL_SECONDS ?? "900", 10), // 15 min
    downloadUrlTtlSeconds: parseInt(process.env.MEDIA_DOWNLOAD_URL_TTL_SECONDS ?? "300", 10), // 5 min
    verificationStaleAfterSeconds: parseInt(process.env.MEDIA_VERIFICATION_STALE_AFTER_SECONDS ?? "600", 10), // 10 min
    storageOperationTimeoutSeconds: parseInt(process.env.MEDIA_STORAGE_OPERATION_TIMEOUT_SECONDS ?? "10", 10),
    checksumTimeoutSeconds: parseInt(process.env.MEDIA_CHECKSUM_TIMEOUT_SECONDS ?? "120", 10),
    maxVerificationDurationSeconds: parseInt(process.env.MEDIA_MAX_VERIFICATION_DURATION_SECONDS ?? "180", 10),
    uploadIntent: {
      limit: parseInt(process.env.MEDIA_UPLOAD_INTENT_RATE_LIMIT ?? "30", 10),
      windowSeconds: parseInt(process.env.MEDIA_UPLOAD_INTENT_RATE_WINDOW_SECONDS ?? "3600", 10),
    },
    downloadUrl: {
      limit: parseInt(process.env.MEDIA_DOWNLOAD_URL_RATE_LIMIT ?? "120", 10),
      windowSeconds: parseInt(process.env.MEDIA_DOWNLOAD_URL_RATE_WINDOW_SECONDS ?? "3600", 10),
    },
    retryVerification: {
      limit: parseInt(process.env.MEDIA_RETRY_VERIFICATION_RATE_LIMIT ?? "10", 10),
      windowSeconds: parseInt(process.env.MEDIA_RETRY_VERIFICATION_RATE_WINDOW_SECONDS ?? "3600", 10),
    },
  },
  // Module 7 Phase 7.4 — Video media generation. The API only enqueues
  // media.* jobs; the worker holds provider credentials. `voiceCatalogJson`
  // is a config-driven Azure voice catalog (D8) — parsed + validated in
  // media-generation/voice-catalog.ts; empty falls back to the built-in
  // en-IN/hi-IN default.
  videoMedia: {
    voiceCatalogJson: process.env.VIDEO_VOICE_CATALOG_JSON ?? "",
    imageAspectByPlatform: process.env.VIDEO_THUMBNAIL_ASPECT_JSON ?? "",
  },
  // Module 7 Phase 7.5 — Video rendering + QA. The API builds the frozen
  // VideoRenderInputV1 snapshot and evaluates Gates #4/#5 from persisted
  // truth; the render worker holds the render engine.
  videoRender: {
    introRequired: (process.env.VIDEO_RENDER_INTRO_REQUIRED ?? "false") === "true",
    outroRequired: (process.env.VIDEO_RENDER_OUTRO_REQUIRED ?? "false") === "true",
    durationToleranceMs: parseInt(process.env.VIDEO_RENDER_DURATION_TOLERANCE_MS ?? "750", 10),
  },
  content: {
    maxBodySizeBytes: parseInt(process.env.CONTENT_MAX_BODY_SIZE_BYTES ?? "2000000", 10), // 2MB
    maxBodyDepth: parseInt(process.env.CONTENT_MAX_BODY_DEPTH ?? "10", 10),
    maxStringValueLength: parseInt(process.env.CONTENT_MAX_STRING_VALUE_LENGTH ?? "200000", 10),
    base64HeuristicMinLength: parseInt(process.env.CONTENT_BASE64_HEURISTIC_MIN_LENGTH ?? "512", 10),
    reviewCommentMaxLength: parseInt(process.env.CONTENT_REVIEW_COMMENT_MAX_LENGTH ?? "2000", 10),
  },
  contentScoring: {
    // Implementation default — see the AppConfig comment. Not a frozen figure.
    passThreshold: parseInt(process.env.CONTENT_SCORING_PASS_THRESHOLD ?? "70", 10),
  },
  internalLinking: {
    // Implementation defaults — see the AppConfig comment. Not frozen figures.
    candidatePoolLimit: parseInt(process.env.INTERNAL_LINKING_CANDIDATE_POOL_LIMIT ?? "50", 10),
    minRelevanceThreshold: parseInt(process.env.INTERNAL_LINKING_MIN_RELEVANCE_THRESHOLD ?? "40", 10),
    maxRecommendationsPerRun: parseInt(process.env.INTERNAL_LINKING_MAX_RECOMMENDATIONS_PER_RUN ?? "5", 10),
  },
  ai: {
    openai: { apiKey: process.env.OPENAI_API_KEY ?? "", model: process.env.OPENAI_MODEL ?? "gpt-4o" },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-20241022" },
    gemini: { apiKey: process.env.GEMINI_API_KEY ?? "", model: process.env.GEMINI_MODEL ?? "gemini-1.5-pro" },
  },
});
