import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { AppConfig } from "../../config/configuration";

export interface LockCheckResult {
  locked: boolean;
  attempts: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface InMemoryEntry {
  count: number;
  expiresAt: number;
}

/**
 * Module 1B.1 Engineering Plan, Refinement 1: adaptive Redis-outage
 * handling. Authentication must never silently disable its security
 * controls — this service degrades from a Redis-backed distributed
 * counter to an in-process (per-instance, non-distributed) fallback, never
 * to "no protection at all," and fires a high-severity alert the moment it
 * degrades, recovering automatically once Redis answers again.
 *
 * Redis healthy   -> normal distributed rate limiting / lock counters.
 * Redis down      -> allow the underlying operation (e.g. login) to
 *                    proceed, but immediately switch to the in-memory
 *                    fallback counter for the SAME threshold/window logic,
 *                    log a HIGH-severity alert once per degradation
 *                    episode (not per request), and probe Redis on an
 *                    interval to detect recovery automatically.
 */
@Injectable()
export class AdaptiveProtectionService implements OnModuleDestroy {
  private readonly logger = new Logger(AdaptiveProtectionService.name);
  private readonly redis: Redis;

  private redisAvailable = true;
  private recoveryProbeHandle: ReturnType<typeof setInterval> | null = null;
  private readonly inMemoryStore = new Map<string, InMemoryEntry>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const url = this.config.get("redisUrl", { infer: true });
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // do not let ioredis retry internally — we own the fallback
    });
    this.redis.on("error", () => {
      // Swallow here; individual operations below handle the failure path.
      // Without a listener, ioredis emits unhandled 'error' events that
      // would crash the process.
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.recoveryProbeHandle) clearInterval(this.recoveryProbeHandle);
    this.redis.disconnect();
  }

  /** Increment the failed-attempt counter for `key`; returns whether it is now locked. */
  async recordFailedAttempt(key: string, threshold: number, lockWindowSeconds: number): Promise<LockCheckResult> {
    const redisKey = `login:failed:${key}`;
    if (this.redisAvailable) {
      try {
        const count = await this.redis.incr(redisKey);
        if (count === 1) {
          await this.redis.expire(redisKey, lockWindowSeconds);
        }
        return { locked: count >= threshold, attempts: count };
      } catch (error) {
        this.degradeToFallback(error as Error);
      }
    }
    return this.recordFailedAttemptInMemory(redisKey, threshold, lockWindowSeconds);
  }

  async isLocked(key: string, threshold: number): Promise<boolean> {
    const redisKey = `login:failed:${key}`;
    if (this.redisAvailable) {
      try {
        const count = await this.redis.get(redisKey);
        return count !== null && parseInt(count, 10) >= threshold;
      } catch (error) {
        this.degradeToFallback(error as Error);
      }
    }
    const entry = this.inMemoryStore.get(redisKey);
    return entry !== undefined && entry.expiresAt > Date.now() && entry.count >= threshold;
  }

  async clearAttempts(key: string): Promise<void> {
    const redisKey = `login:failed:${key}`;
    if (this.redisAvailable) {
      try {
        await this.redis.del(redisKey);
        return;
      } catch (error) {
        this.degradeToFallback(error as Error);
      }
    }
    this.inMemoryStore.delete(redisKey);
  }

  async checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = `ratelimit:${key}`;
    if (this.redisAvailable) {
      try {
        const count = await this.redis.incr(redisKey);
        if (count === 1) {
          await this.redis.expire(redisKey, windowSeconds);
        }
        if (count > limit) {
          const ttl = await this.redis.ttl(redisKey);
          return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
        }
        return { allowed: true };
      } catch (error) {
        this.degradeToFallback(error as Error);
      }
    }
    return this.checkRateLimitInMemory(redisKey, limit, windowSeconds);
  }

  isRedisAvailable(): boolean {
    return this.redisAvailable;
  }

  private recordFailedAttemptInMemory(key: string, threshold: number, lockWindowSeconds: number): LockCheckResult {
    const now = Date.now();
    const existing = this.inMemoryStore.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      return { locked: existing.count >= threshold, attempts: existing.count };
    }
    this.inMemoryStore.set(key, { count: 1, expiresAt: now + lockWindowSeconds * 1000 });
    return { locked: threshold <= 1, attempts: 1 };
  }

  private checkRateLimitInMemory(key: string, limit: number, windowSeconds: number): RateLimitResult {
    const now = Date.now();
    const existing = this.inMemoryStore.get(key);
    if (existing && existing.expiresAt > now) {
      existing.count += 1;
      if (existing.count > limit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((existing.expiresAt - now) / 1000) };
      }
      return { allowed: true };
    }
    this.inMemoryStore.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return { allowed: true };
  }

  /**
   * Fired at most once per degradation episode. Deliberately does not
   * disable the security control it backs — callers fall through to the
   * in-memory equivalent immediately after this returns.
   */
  private degradeToFallback(error: Error): void {
    if (!this.redisAvailable) return; // already degraded, avoid duplicate alerts
    this.redisAvailable = false;
    this.logger.error({
      alertSeverity: "HIGH",
      event: "REDIS_PROTECTION_DEGRADED",
      message:
        "Redis unavailable — authentication rate-limiting and lockout have failed over to in-process protection. " +
        "This is reduced (non-distributed, per-instance) but not disabled. Investigate immediately.",
      err: error.message,
    });
    this.startRecoveryProbe();
  }

  private startRecoveryProbe(): void {
    if (this.recoveryProbeHandle) return;
    this.recoveryProbeHandle = setInterval(async () => {
      try {
        await this.redis.ping();
        this.redisAvailable = true;
        this.inMemoryStore.clear();
        if (this.recoveryProbeHandle) clearInterval(this.recoveryProbeHandle);
        this.recoveryProbeHandle = null;
        this.logger.warn({
          alertSeverity: "INFO",
          event: "REDIS_PROTECTION_RECOVERED",
          message: "Redis reachable again — distributed rate-limiting and lockout resumed.",
        });
      } catch {
        // still down; keep probing
      }
    }, 5000);
  }
}
