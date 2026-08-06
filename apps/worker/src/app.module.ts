import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "crypto";
import configuration from "./config/configuration";
import type { WorkerConfig } from "./config/configuration";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueRegistryModule } from "./queue/queue-registry.module";
import { HeartbeatModule } from "./heartbeat/heartbeat.module";
import { BullMqModule } from "./bullmq/bullmq.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    // Structured logging kept schema-consistent with apps/api's own
    // LoggerModule config (Observability & Monitoring Specification §3),
    // minus the HTTP-only fields — this process never serves requests.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerConfig, true>) => ({
        pinoHttp: {
          level: config.get("logLevel", { infer: true }),
          genReqId: () => randomUUID(),
          customProps: () => ({ service: "myev-worker" }),
        },
      }),
    }),
    PrismaModule,
    QueueRegistryModule,
    HeartbeatModule,
    BullMqModule,
  ],
})
export class AppModule {}
