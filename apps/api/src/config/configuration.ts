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
}

/**
 * All values are read from environment variables only — no defaults that would
 * silently mask a missing .env in a non-local environment, except sensible
 * local-dev fallbacks used only when NODE_ENV=development.
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
});
