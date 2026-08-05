import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
// Generated to a stable, non-node_modules path — see prisma/schema.prisma's
// custom `output` (Module 1A.1 hardening rationale documented there).
import { PrismaClient } from "../../generated/prisma";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.warn(`Postgres health check failed: ${(error as Error).message}`);
      return false;
    }
  }
}
