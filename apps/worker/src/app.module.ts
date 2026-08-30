import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "crypto";
import {
  BackgroundJobReconciliationModule,
  BullMqModule,
  HeartbeatModule,
  PrismaModule,
  ShutdownModule,
} from "@myev/worker-core";
import configuration from "./config/configuration";
import type { WorkerConfig } from "./config/configuration";
import { AiProviderRegistryModule } from "./ai-provider/ai-provider-registry.module";
import { AgentRegistryModule } from "./ai-provider/agent-registry.module";
import { QueueRegistryModule } from "./queue/queue-registry.module";
import { SchedulerModule } from "./scheduler/scheduler.module";
import { EventsModule } from "./events/events.module";
import { OutboxRelayModule } from "./events/outbox-relay.module";
import { SimulatedShutdownFailureModule } from "./testing/simulated-shutdown-failure.module";

/**
 * The general worker: SYSTEM (system.ping.v1) + AI (ai.execute.v1) work,
 * the scheduler tick, and the outbox relay. Framework infrastructure
 * (Prisma, heartbeat, BullMQ job lifecycle, the reconciliation sweep,
 * bounded shutdown) is imported from `@myev/worker-core`.
 *
 * This process has NO media, storage, or render dependency — the
 * dedicated render/media worker (`apps/render-worker`) owns the MEDIA
 * queue, every media processor, and Remotion.
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
          customProps: () => ({ service: "myev-worker" }),
        },
      }),
    }),
    PrismaModule,
    AiProviderRegistryModule,
    AgentRegistryModule,
    QueueRegistryModule,
    HeartbeatModule,
    BullMqModule,
    SchedulerModule,
    EventsModule,
    OutboxRelayModule,
    BackgroundJobReconciliationModule,
    ShutdownModule,
    ...(process.env.SIMULATE_SHUTDOWN_FAILURE === "true" || process.env.SIMULATE_TRACKER_FAILURE === "true" ? [SimulatedShutdownFailureModule] : []),
  ],
})
export class AppModule {}
