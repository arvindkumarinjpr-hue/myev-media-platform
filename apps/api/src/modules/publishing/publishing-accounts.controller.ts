import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { ConnectWordPressDto, RotateWordPressDto } from "./dto/connect-wordpress.dto";
import { PublishingAccountsService } from "./publishing-accounts.service";

/**
 * Module 9 Phase 9.7 (Part D/E/F/L/M) — connected-channel-account
 * management. Every WRITE route (connect/rotate/test-connection/
 * disconnect) is gated by PUBLISH_CHANNEL_MANAGE — the existing,
 * Phase 9.1-frozen, deliberately Owner/Administrator-only permission
 * (see that constant's own doc comment for why it is NOT granted to
 * Publisher despite the frozen matrix's ambiguous prose).
 *
 * The two READ routes (list/detail) are a deliberate, disclosed
 * exception: gated by PUBLISH_CREATE instead. Research finding — no
 * PUBLISH_VIEW permission exists anywhere in the frozen matrix (unlike
 * BLOG_VIEW/VIDEO_VIEW, which ARE real, separate permissions in a
 * different "Content" category), and every role that has ANY Publishing
 * permission today (Administrator, Publisher) has PUBLISH_CREATE bundled
 * together with PUBLISH_EXECUTE/PUBLISH_CANCEL — never one without the
 * others. Gating account visibility behind PUBLISH_CHANNEL_MANAGE alone
 * would make it structurally impossible for a Publisher (who legitimately
 * has PUBLISH_CREATE) to ever see which channel accounts exist to select
 * when creating a publication. This is a considered choice, not an
 * invented permission — see the Phase 9.7 completion report's own Part 7
 * for the full reasoning.
 */
@Controller("api/v1/workspaces/:workspaceId/publishing/accounts")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class PublishingAccountsController {
  constructor(private readonly accounts: PublishingAccountsService) {}

  private ctx(req: Request): { ipAddress?: string } {
    return { ipAddress: req.ip };
  }

  @Get()
  @RequirePermission(PERMISSIONS.PUBLISH_CREATE)
  async list(@CurrentWorkspace() workspace: WorkspaceContext) {
    return { data: await this.accounts.list(workspace.id) };
  }

  @Get(":accountId")
  @RequirePermission(PERMISSIONS.PUBLISH_CREATE)
  async detail(@CurrentWorkspace() workspace: WorkspaceContext, @Param("accountId") accountId: string) {
    return { data: await this.accounts.detail(workspace.id, accountId) };
  }

  @Post("wordpress")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async connectWordPress(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: ConnectWordPressDto) {
    return { data: await this.accounts.connectWordPress(workspace.id, workspace.userInternalId, dto, this.ctx(req)) };
  }

  @Put(":accountId/wordpress/credential")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  async rotateWordPress(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Param("accountId") accountId: string, @Body() dto: RotateWordPressDto) {
    return { data: await this.accounts.rotateWordPressCredential(workspace.id, workspace.userInternalId, accountId, dto, this.ctx(req)) };
  }

  @Post(":accountId/test-connection")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  @HttpCode(HttpStatus.OK)
  async testConnection(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Param("accountId") accountId: string) {
    return { data: await this.accounts.testConnection(workspace.id, accountId, this.ctx(req)) };
  }

  @Delete(":accountId")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  @HttpCode(HttpStatus.OK)
  async disconnect(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Param("accountId") accountId: string) {
    return { data: await this.accounts.disconnect(workspace.id, accountId, this.ctx(req)) };
  }
}
