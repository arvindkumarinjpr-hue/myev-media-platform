import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { AppConfig } from "../../config/configuration";

const TTL_SECONDS = 60;

/**
 * Module 1C Engineering Plan §2.E. Two caches — per-user effective
 * permissions and a workspace's member list — sharing one invalidation
 * discipline: a 60s TTL as a hard backstop, explicit invalidation on every
 * mutation that can change either, and Redis-outage tolerance.
 *
 * Unlike AdaptiveProtectionService (which backs an authentication security
 * control and must keep enforcing something when Redis is down), this is a
 * pure performance optimization: on any Redis error, every method here
 * fails open to "cache miss" — never serves a stale grant, never blocks a
 * request, never needs an in-memory fallback store. The caller always falls
 * through to a live Postgres read, just slower.
 */
@Injectable()
export class WorkspaceCacheService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(config: ConfigService<AppConfig, true>) {
    const url = config.get("redisUrl", { infer: true });
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    this.redis.on("error", () => {
      // Swallow — every call site below already treats a Redis error as a
      // plain cache miss / no-op, there is nothing else to react to here.
    });
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private permissionsKey(workspaceId: string, userId: string): string {
    return `workspace:${workspaceId}:permissions:${userId}`;
  }

  private membersKey(workspaceId: string): string {
    return `workspace:${workspaceId}:members`;
  }

  async getPermissions(workspaceId: string, userId: string): Promise<string[] | null> {
    try {
      const raw = await this.redis.get(this.permissionsKey(workspaceId, userId));
      return raw ? (JSON.parse(raw) as string[]) : null;
    } catch {
      return null;
    }
  }

  async setPermissions(workspaceId: string, userId: string, permissions: string[]): Promise<void> {
    try {
      await this.redis.set(this.permissionsKey(workspaceId, userId), JSON.stringify(permissions), "EX", TTL_SECONDS);
    } catch {
      // Best-effort — a cache write failure must never fail the request.
    }
  }

  async getMembers<T>(workspaceId: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(this.membersKey(workspaceId));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async setMembers<T>(workspaceId: string, data: T): Promise<void> {
    try {
      await this.redis.set(this.membersKey(workspaceId), JSON.stringify(data), "EX", TTL_SECONDS);
    } catch {
      // Best-effort.
    }
  }

  /**
   * The single invalidation call site for every mutation Module 1C's plan
   * requires it for: member added, removed, suspended, role changed,
   * ownership transferred, and PENDING_ACTIVATION -> ACTIVE. One call,
   * both caches, always together — never invalidated independently.
   */
  async invalidateForMembershipChange(workspaceId: string, userId: string): Promise<void> {
    try {
      await Promise.all([this.redis.del(this.permissionsKey(workspaceId, userId)), this.redis.del(this.membersKey(workspaceId))]);
    } catch {
      // Best-effort — worst case the 60s TTL backstop still bounds staleness.
    }
  }
}
