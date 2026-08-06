import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { MembersController } from "./members.controller";
import { WorkspaceLeaveController } from "./workspace-leave.controller";
import { WorkspaceInvitationsController } from "./workspace-invitations.controller";
import { InvitationsPublicController } from "./invitations-public.controller";
import { MembersService } from "./members.service";
import { InvitationsService } from "./invitations.service";
import { InvitationActivationService } from "./invitation-activation.service";

@Module({
  imports: [AuthModule, EmailModule, WorkspacesModule],
  controllers: [MembersController, WorkspaceLeaveController, WorkspaceInvitationsController, InvitationsPublicController],
  providers: [MembersService, InvitationsService, InvitationActivationService],
})
export class WorkspaceMembersModule {}
