import { Module } from "@nestjs/common";
import { BullMqModule } from "../bullmq/bullmq.module";
import { BackgroundJobReconciliationManager } from "./background-job-reconciliation.manager";

/** DEFECT-1F-006. Imports BullMqModule to inject BullMqWorkerManager (reused lifecycle transitions — see the manager's own doc comment). */
@Module({
  imports: [BullMqModule],
  providers: [BackgroundJobReconciliationManager],
})
export class BackgroundJobReconciliationModule {}
