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
  content: {
    maxBodySizeBytes: parseInt(process.env.CONTENT_MAX_BODY_SIZE_BYTES ?? "2000000", 10), // 2MB
    maxBodyDepth: parseInt(process.env.CONTENT_MAX_BODY_DEPTH ?? "10", 10),
    maxStringValueLength: parseInt(process.env.CONTENT_MAX_STRING_VALUE_LENGTH ?? "200000", 10),
    base64HeuristicMinLength: parseInt(process.env.CONTENT_BASE64_HEURISTIC_MIN_LENGTH ?? "512", 10),
    reviewCommentMaxLength: parseInt(process.env.CONTENT_REVIEW_COMMENT_MAX_LENGTH ?? "2000", 10),
  },
});
