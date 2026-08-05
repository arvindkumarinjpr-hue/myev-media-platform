import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { InvitationsService } from "./invitations.service";
import { InviteMemberDto } from "./dto/invite-member.dto";

@Controller("api/v1/workspaces/:workspaceId/invitations")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class WorkspaceInvitationsController {
  constructor(
    private readonly invitationsService: InvitationsService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async invite(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: InviteMemberDto, @Req() req: Request) {
    const workspaceDetail = await this.workspacesService.findOne(workspace.id);
    await this.invitationsService.invite(workspace.id, workspaceDetail.name, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Get()
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  async list(@CurrentWorkspace() workspace: WorkspaceContext) {
    const invitations = await this.invitationsService.list(workspace.id);
    return {
      data: invitations.map((i) => ({
        publicId: i.publicId,
        invitedEmail: i.invitedEmail,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    };
  }

  @Delete(":invitationId")
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @HttpCode(HttpStatus.OK)
  async revoke(@CurrentWorkspace() workspace: WorkspaceContext, @Param("invitationId") invitationId: string, @Req() req: Request) {
    await this.invitationsService.revoke(workspace.id, invitationId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }
}
