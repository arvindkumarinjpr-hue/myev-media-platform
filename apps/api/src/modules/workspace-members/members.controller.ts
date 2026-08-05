import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { MembersService } from "./members.service";
import { UpdateMemberDto } from "./dto/update-member.dto";

@Controller("api/v1/workspaces/:workspaceId/members")
@UseGuards(SessionGuard, WorkspaceContextGuard)
export class MembersController {
  constructor(
    private readonly membersService: MembersService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.WORKSPACE_VIEW)
  async list(@CurrentWorkspace() workspace: WorkspaceContext) {
    const members = await this.membersService.list(workspace.id);
    return {
      data: members.map((m) => ({
        publicId: m.publicId,
        userId: m.userId,
        status: m.status,
        roleId: m.roleId,
        joinedAt: m.joinedAt,
      })),
    };
  }

  @Patch(":memberId")
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @HttpCode(HttpStatus.OK)
  async update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("memberId") memberId: string,
    @Body() dto: UpdateMemberDto,
    @Req() req: Request,
  ) {
    await this.membersService.updateMember(workspace.id, memberId, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Delete(":memberId")
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentWorkspace() workspace: WorkspaceContext, @Param("memberId") memberId: string, @Req() req: Request) {
    await this.membersService.remove(workspace.id, memberId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Post(":memberId/resend-activation")
  @UseGuards(PermissionGuard)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @HttpCode(HttpStatus.OK)
  async resendActivation(@CurrentWorkspace() workspace: WorkspaceContext, @Param("memberId") memberId: string, @Req() req: Request) {
    const workspaceDetail = await this.workspacesService.findOne(workspace.id);
    await this.membersService.resendActivation(
      workspace.id,
      workspace.publicId,
      workspaceDetail.name,
      memberId,
      workspace.userInternalId,
      { ipAddress: req.ip },
    );
    return { data: { success: true } };
  }
}
