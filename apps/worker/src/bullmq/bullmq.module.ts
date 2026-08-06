import { Module } from "@nestjs/common";
import { HeartbeatModule } from "../heartbeat/heartbeat.module";
import { BullMqWorkerManager } from "./bullmq-worker.manager";

@Module({
  imports: [HeartbeatModule],
  providers: [BullMqWorkerManager],
})
export class BullMqModule {}
