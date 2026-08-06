import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { SlugReservationService } from "./slug-reservation.service";

@Module({
  imports: [AuthModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, SlugReservationService],
  exports: [WorkspacesService, SlugReservationService],
})
export class WorkspacesModule {}
