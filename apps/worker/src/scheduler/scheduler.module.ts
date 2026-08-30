import { Module } from "@nestjs/common";
import { HeartbeatModule } from "@myev/worker-core";
import { SchedulerTickManager } from "./scheduler-tick.manager";

@Module({
  imports: [HeartbeatModule],
  providers: [SchedulerTickManager],
})
export class SchedulerModule {}
