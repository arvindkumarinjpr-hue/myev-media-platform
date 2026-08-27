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
import { KnowledgePacksModule } from "./modules/knowledge-packs/knowledge-packs.module";
import { AiAgentsModule } from "./modules/ai-agents/ai-agents.module";
import { AiJobsModule } from "./modules/ai-jobs/ai-jobs.module";
import { ResearchModule } from "./modules/research/research.module";
import { TopicClustersModule } from "./modules/topic-clusters/topic-clusters.module";
import { MediaAssetsModule } from "./modules/media-assets/media-assets.module";
import { ContentModule } from "./modules/content/content.module";
import { BackgroundJobsModule } from "./modules/background-jobs/background-jobs.module";
import { SchedulesModule } from "./modules/schedules/schedules.module";
import { EventsModule } from "./modules/events/events.module";
import { ShutdownModule } from "./shutdown/shutdown.module";
import { SimulatedShutdownFailureModule } from "./testing/simulated-shutdown-failure.module";
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
    KnowledgePacksModule,
    AiAgentsModule,
    AiJobsModule,
    ResearchModule,
    TopicClustersModule,
    MediaAssetsModule,
    ContentModule,
    BackgroundJobsModule,
    SchedulesModule,
    EventsModule,
    ShutdownModule,
    // DEFECT-1F-001 FINAL SIGNAL ERROR-HANDLING FIX — test fixture only,
    // inert unless SIMULATE_SHUTDOWN_FAILURE=true is explicitly set. See
    // testing/simulated-shutdown-failure.module.ts's own doc comment.
    ...(process.env.SIMULATE_SHUTDOWN_FAILURE === "true" || process.env.SIMULATE_TRACKER_FAILURE === "true" ? [SimulatedShutdownFailureModule] : []),
  ],
})
export class AppModule {}
