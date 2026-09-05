import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard, type AuthenticatedRequest } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import type { ContentActor } from "../content/content-items.service";
import { SocialGenerationService } from "./social-generation.service";
import { CreateSocialPostDto } from "./dto/create-social-post.dto";

/**
 * Module 10 Phase 10.2 — Social Media API (POST /api/v1/workspaces/
 * :workspaceId/social-posts only). Strict non-scope (checkpoint Part O):
 * no frontend, no review/approval routes, no publishing handoff — this is
 * the one route Phase 10.2 actually needs to make "create from source"
 * reachable/testable. A static @RequirePermission is correct here (same
 * precedent as BlogController): every item this controller creates is
 * contentType SOCIAL_POST.
 */
@Controller("api/v1/workspaces/:workspaceId/social-posts")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class SocialController {
  constructor(private readonly socialGeneration: SocialGenerationService) {}

  private actor(user: AuthenticatedRequest["user"], workspace: WorkspaceContext): ContentActor {
    return { publicId: user.sub, internalId: workspace.userInternalId };
  }

  @Post()
  @RequirePermission(PERMISSIONS.SOCIAL_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateSocialPostDto, @Req() req: Request) {
    const correlationId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    return { data: await this.socialGeneration.createFromSource({ id: workspace.id }, this.actor(user, workspace), dto, { correlationId }) };
  }
}
