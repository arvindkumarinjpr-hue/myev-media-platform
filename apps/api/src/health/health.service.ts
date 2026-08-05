import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import type { DependencyStatus, ReadinessResponse } from "@myev/shared";
import { PrismaService } from "../prisma/prisma.service";
import type { AppConfig } from "../config/configuration";

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
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
    const storage = this.config.get("storage", { infer: true });
    const protocol = storage.useSsl ? "https" : "http";
    const url = `${protocol}://${storage.endpoint}:${storage.port}/minio/health/live`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return response.ok ? "up" : "down";
    } catch (error) {
      this.logger.warn(`Storage (MinIO) health check failed: ${(error as Error).message}`);
      return "down";
    }
  }
}
