import { Module } from "@nestjs/common";
import { WorkerHeartbeatService } from "./worker-heartbeat.service";

@Module({
  providers: [WorkerHeartbeatService],
  exports: [WorkerHeartbeatService],
})
export class HeartbeatModule {}
