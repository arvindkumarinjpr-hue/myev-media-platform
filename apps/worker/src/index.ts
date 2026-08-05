import Redis from "ioredis";
import pino from "pino";
import { getWorkerConfig } from "./config";

/**
 * Module 1A scope only: proves the worker process can start, connect to
 * Redis, and stay alive under Docker Compose / restart policies.
 *
 * No BullMQ queues and no job processors are registered here — per the
 * approved Module 1 Engineering Plan (point 8), business job processing is
 * explicitly deferred to the Queue & Background Job Engine implementation
 * phase. Do not add job handlers to this file as part of Module 1A/1B/1C.
 */

async function bootstrap(): Promise<void> {
  const config = getWorkerConfig();
  const logger = pino({ level: config.logLevel, name: "myev-worker" });

  const redis = new Redis(config.redisUrl, { lazyConnect: true });

  redis.on("error", (error) => {
    logger.warn({ err: error }, "Redis connection error");
  });

  await redis.connect();
  const pong = await redis.ping();
  logger.info({ pong }, "worker foundation ready — no job processors registered (Module 1A scope)");

  // Heartbeat keeps the process (and container) alive so restart-policy and
  // health verification in the acceptance checklist have something to observe.
  setInterval(() => {
    logger.debug("worker heartbeat");
  }, 30_000);
}

bootstrap().catch((error: unknown) => {
  // logger is scoped inside bootstrap; this is the last-resort fallback path
  console.error("worker failed to start:", error);
  process.exitCode = 1;
});
