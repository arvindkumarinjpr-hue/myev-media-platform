import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { DependencyStatus, ReadinessResponse } from "@myev/shared";
import { PrismaService } from "../prisma/prisma.service";
import type { AppConfig } from "../config/configuration";
import { STORAGE_PROVIDER, type StorageProvider } from "../modules/storage/storage-provider.interface";

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
  ) {}

  async checkReadiness(): Promise<ReadinessResponse> {
    const [database, redis, storage] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkStorage(),
    ]);

    const allUp = database === "up" && redis === "up" && storage === "up";

    return {
      status: allUp ? "ok" : "degraded",
      dependencies: { database, redis, storage },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    return (await this.prisma.isHealthy()) ? "up" : "down";
  }

  private async checkRedis(): Promise<DependencyStatus> {
    const url = this.config.get("redisUrl", { infer: true });
    if (!url) return "down";

    const client = new Redis(url, { lazyConnect: true, connectTimeout: 2000, maxRetriesPerRequest: 1 });
    try {
      await client.connect();
      const pong = await client.ping();
      return pong === "PONG" ? "up" : "down";
    } catch (error) {
      this.logger.warn(`Redis health check failed: ${(error as Error).message}`);
      return "down";
    } finally {
      client.disconnect();
    }
  }

  private async checkStorage(): Promise<DependencyStatus> {
    // Module 1D: routed through StorageProvider.healthCheck() instead of
    // an inlined MinIO-specific fetch — this endpoint no longer knows or
    // cares which storage provider is active.
    const { healthy, detail } = await this.storageProvider.healthCheck();
    if (!healthy && detail) this.logger.warn(`Storage health check failed: ${detail}`);
    return healthy ? "up" : "down";
  }
}
