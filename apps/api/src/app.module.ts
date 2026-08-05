import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "crypto";
import configuration from "./config/configuration";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { AuditModule } from "./modules/audit/audit.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { AuthModule } from "./modules/auth/auth.module";
import { WorkspacesModule } from "./modules/workspaces/workspaces.module";
import { WorkspaceMembersModule } from "./modules/workspace-members/workspace-members.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import type { AppConfig } from "./config/configuration";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    // Structured logging per Observability & Monitoring Specification §3:
    // timestamp, level, service, request_id, correlation_id, message, context.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        pinoHttp: {
          level: config.get("logLevel", { infer: true }),
          genReqId: (req: { headers: Record<string, unknown> }) =>
            (req.headers["x-request-id"] as string) ?? randomUUID(),
          customProps: () => ({ service: "myev-api" }),
          redact: ["req.headers.authorization", "req.headers.cookie"],
        },
      }),
    }),
    PrismaModule,
    HealthModule,
    AuditModule,
    RbacModule,
    AuthModule,
    WorkspacesModule,
    WorkspaceMembersModule,
    ProjectsModule,
  ],
})
export class AppModule {}
