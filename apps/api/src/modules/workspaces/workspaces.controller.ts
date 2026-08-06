import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { AllowArchivedWorkspace } from "../../common/decorators/allow-archived-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard, type AuthenticatedRequest } from "../../common/guards/session.guard";
import { PlatformOwnerGuard } from "../../common/guards/platform-owner.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSION_RESOLVER, type PermissionResolver } from "../rbac/permission-resolver.interface";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { WorkspacesService } from "./workspaces.service";
import { CreateWorkspaceDto } from "./dto/create-workspace.dto";
import { UpdateWorkspaceDto } from "./dto/update-workspace.dto";
import { TransferOwnershipDto } from "./dto/transfer-ownership.dto";

@Controller("api/v1/workspaces")
export class WorkspacesController {
  constructor(
    private readonly workspacesService: WorkspacesService,
    @Inject(PERMISSION_RESOLVER) private readonly permissionResolver: PermissionResolver,
  ) {}

  @Post()
  @UseGuards(SessionGuard, PlatformOwnerGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: AuthenticatedRequest["user"], @Body() dto: CreateWorkspaceDto) {
    const workspace = await this.workspacesService.create(user.sub, dto);
    return { data: { publicId: workspace.publicId, name: workspace.name, slug: workspace.slug, status: workspace.status } };
  }

  @Get()
  @UseGuards(SessionGuard)
  async listMine(@CurrentUser() user: AuthenticatedRequest["user"]) {
    const workspaces = await this.workspacesService.listMine(user.sub);
    return { data: workspaces.map((w) => ({ publicId: w.publicId, name: w.name, slug: w.slug, status: w.status })) };
  }

  @Get(":workspaceId")
  @UseGuards(SessionGuard, WorkspaceContextGuard)
  @AllowArchivedWorkspace()
  async findOne(@CurrentWorkspace() workspace: WorkspaceContext) {
    const found = await this.workspacesService.findOne(workspace.id);
    return {
      data: {
        publicId: found.publicId,
        name: found.name,
        slug: found.slug,
        status: found.status,
        settings: found.settings,
        featureFlags: found.featureFlags,
        myRole: workspace.roleName,
      },
    };
  }

  @Patch(":workspaceId")
  @UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
  @RequirePermission(PERMISSIONS.WORKSPACE_UPDATE)
  async update(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: UpdateWorkspaceDto, @Req() req: Request) {
    const updated = await this.workspacesService.updateSettings(workspace.id, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: { publicId: updated.publicId, name: updated.name, slug: updated.slug, settings: updated.settings } };
  }

  @Post(":workspaceId/archive")
  @UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
  @RequirePermission(PERMISSIONS.WORKSPACE_ARCHIVE)
  @HttpCode(HttpStatus.OK)
  async archive(@CurrentWorkspace() workspace: WorkspaceContext, @Req() req: Request) {
    await this.workspacesService.archive(workspace.id, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Post(":workspaceId/restore")
  @UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
  @RequirePermission(PERMISSIONS.WORKSPACE_ARCHIVE)
  @AllowArchivedWorkspace()
  @HttpCode(HttpStatus.OK)
  async restore(@CurrentWorkspace() workspace: WorkspaceContext, @Req() req: Request) {
    await this.workspacesService.restore(workspace.id, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Delete(":workspaceId")
  @UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
  @RequirePermission(PERMISSIONS.WORKSPACE_DELETE)
  @AllowArchivedWorkspace()
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentWorkspace() workspace: WorkspaceContext, @Req() req: Request) {
    await this.workspacesService.softDelete(workspace.id, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Post(":workspaceId/transfer-ownership")
  @UseGuards(SessionGuard, WorkspaceContextGuard)
  @HttpCode(HttpStatus.OK)
  async transferOwnership(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: TransferOwnershipDto, @Req() req: Request) {
    // Not permission-gated (PermissionGuard) — identity-gated: only the
    // current owner may transfer, checked inside the locked transaction
    // itself (Module 1C Engineering Plan §2.D′). A role-based permission
    // check here would be redundant with, and weaker than, that check.
    await this.workspacesService.transferOwnership(workspace.id, workspace.userInternalId, dto.newOwnerUserPublicId, {
      ipAddress: req.ip,
    });
    return { data: { success: true } };
  }

  @Get(":workspaceId/permissions/me")
  @UseGuards(SessionGuard, WorkspaceContextGuard)
  async myPermissions(@CurrentWorkspace() workspace: WorkspaceContext, @CurrentUser() user: AuthenticatedRequest["user"]) {
    const permissions = await this.permissionResolver.resolve(user.sub, workspace.id);
    return { data: { permissions } };
  }
}
