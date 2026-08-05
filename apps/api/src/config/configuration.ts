export interface AppConfig {
  env: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
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
});
