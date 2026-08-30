import { Module } from "@nestjs/common";
import { HeartbeatModule } from "../heartbeat/heartbeat.module";
import { BullMqWorkerManager } from "./bullmq-worker.manager";

@Module({
  imports: [HeartbeatModule],
  providers: [BullMqWorkerManager],
  // DEFECT-1F-006: exported so BackgroundJobReconciliationManager can
  // inject it and reuse scheduleRetryOrDeadLetter directly rather than
  // duplicating any lifecycle-transition logic.
  exports: [BullMqWorkerManager],
})
export class BullMqModule {}
