import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { QueueRegistryModule } from "./queue-registry.module";
import { BackgroundJobsController } from "./background-jobs.controller";
import { BackgroundJobsService } from "./background-jobs.service";

@Module({
  imports: [AuthModule, QueueRegistryModule],
  controllers: [BackgroundJobsController],
  providers: [BackgroundJobsService],
  exports: [BackgroundJobsService],
})
export class BackgroundJobsModule {}
