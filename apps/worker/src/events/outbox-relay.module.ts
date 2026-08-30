import { Module } from "@nestjs/common";
import { HeartbeatModule } from "@myev/worker-core";
import { OutboxRelayManager } from "./outbox-relay.manager";

/**
 * Milestone 8.2 — its own dedicated module, mirroring
 * SchedulerModule/BullMqModule's identical one-module-per-major-
 * lifecycle-hooked-component convention rather than folding
 * OutboxRelayManager into EventsModule (which owns registration/
 * publishing only, not dispatch). EVENT_REGISTRY and SHUTDOWN_TRACKER
 * are both @Global(), so no explicit import of EventsModule/
 * ShutdownModule is needed here for those — HeartbeatModule is imported
 * because WorkerHeartbeatService is not global.
 */
@Module({
  imports: [HeartbeatModule],
  providers: [OutboxRelayManager],
})
export class OutboxRelayModule {}
