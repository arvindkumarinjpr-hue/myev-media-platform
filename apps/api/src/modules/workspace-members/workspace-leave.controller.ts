import { Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { MembersService } from "./members.service";

/**
 * A separate, tiny controller (rather than folding this into
 * WorkspacesController) purely to keep module boundaries simple:
 * MembersService lives in this module, and WorkspacesModule would
 * otherwise need a circular import on this module just for one route.
 * Mounted at the exact path from the approved API plan
 * (POST /workspaces/:workspaceId/leave), independent of which module
 * "owns" it.
 */
@Controller("api/v1/workspaces/:workspaceId")
@UseGuards(SessionGuard, WorkspaceContextGuard)
export class WorkspaceLeaveController {
  constructor(private readonly membersService: MembersService) {}

  @Post("leave")
  @HttpCode(HttpStatus.OK)
  async leave(@CurrentWorkspace() workspace: WorkspaceContext, @Req() req: Request) {
    await this.membersService.leave(workspace.id, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }
}
