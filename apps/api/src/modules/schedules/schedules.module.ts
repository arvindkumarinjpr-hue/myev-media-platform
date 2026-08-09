import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { QueueRegistryModule } from "../background-jobs/queue-registry.module";
import { WorkspaceSchedulesController } from "./workspace-schedules.controller";
import { PlatformSchedulesController } from "./platform-schedules.controller";
import { SchedulesService } from "./schedules.service";

@Module({
  imports: [AuthModule, QueueRegistryModule],
  controllers: [WorkspaceSchedulesController, PlatformSchedulesController],
  providers: [SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
