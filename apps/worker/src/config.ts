export interface WorkerConfig {
  redisUrl: string;
  logLevel: string;
}

export class MissingRedisUrlError extends Error {
  constructor() {
    super("REDIS_URL is not set — worker cannot verify connectivity");
    this.name = "MissingRedisUrlError";
  }
}

export function getWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (!env.REDIS_URL) {
    throw new MissingRedisUrlError();
  }
  return {
    redisUrl: env.REDIS_URL,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
