import { Module } from "@nestjs/common";
import { HeartbeatModule } from "../heartbeat/heartbeat.module";
import { SchedulerTickManager } from "./scheduler-tick.manager";

@Module({
  imports: [HeartbeatModule],
  providers: [SchedulerTickManager],
})
export class SchedulerModule {}
