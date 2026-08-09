import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
// The Worker deliberately has no Prisma schema of its own — apps/api/prisma/schema.prisma
// remains the single source of truth for the database (Module 1A decision). This
// process generates its own client instance from that same schema (see
// package.json's `prisma:generate`/`postinstall`, which `cd ../api` before
// running `prisma generate` — CWD must match the schema's own package
// directory, or Prisma's project-root inference gets confused by the
// CWD/schema-path mismatch and tries to auto-install itself into the
// wrong directory) and imports the resulting output — landing, per the
// schema's own `output` path, at apps/api/generated/prisma regardless of
// which app invoked the generate command. This mirrors apps/api's own
// PrismaService import exactly (see apps/api/src/prisma/prisma.service.ts),
// just one directory level further out.
import { PrismaClient } from "../../../api/generated/prisma";

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
