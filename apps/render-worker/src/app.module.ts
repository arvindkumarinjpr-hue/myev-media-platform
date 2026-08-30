import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "crypto";
import {
  BackgroundJobReconciliationModule,
  BullMqModule,
  HeartbeatModule,
  MediaModule,
  PrismaModule,
  ShutdownModule,
} from "@myev/worker-core";
import configuration from "./config/configuration";
import type { WorkerConfig } from "./config/configuration";
import { MediaProviderRegistryModule } from "./media-provider/media-provider-registry.module";
import { RenderEngineModule } from "./render/render-engine.module";
import { QueueRegistryModule } from "./queue/queue-registry.module";

/**
 * The dedicated render / media worker (`WORKER_QUEUES=MEDIA`). Owns the
 * whole MEDIA queue — image/voice/subtitle generation and video
 * rendering — plus Remotion and every heavy render dependency. Framework
 * infrastructure (Prisma, heartbeat, BullMQ job lifecycle, the
 * reconciliation sweep, bounded shutdown, media persistence) comes from
 * `@myev/worker-core`, shared verbatim with the general worker.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerConfig, true>) => ({
        pinoHttp: {
          level: config.get("logLevel", { infer: true }),
          genReqId: () => randomUUID(),
          customProps: () => ({ service: "myev-render-worker" }),
        },
      }),
    }),
    PrismaModule,
    MediaModule,
    MediaProviderRegistryModule,
    RenderEngineModule,
    QueueRegistryModule,
    HeartbeatModule,
    BullMqModule,
    BackgroundJobReconciliationModule,
    ShutdownModule,
  ],
})
export class AppModule {}
