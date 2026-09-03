import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { InternalLinkDiscoveryService } from "./internal-link-discovery.service";
import { InternalLinksQueryService } from "./internal-links-query.service";

/**
 * Module 8 Phase 8.4 — the Blog-scoped half of the human-review API
 * surface: generate/refresh and list, both keyed by the source Blog
 * item. Mirrors BlogController's exact conventions (same guard stack,
 * @RequirePermission per route, {data} envelope). The other half
 * (patch-anchor/accept/reject, keyed by the recommendation's own id) is
 * InternalLinksController — a distinct base path, per the approved API
 * design.
 *
 * Permissions (Module 8 Architecture Checkpoint Correction, corrected
 * D16, reaffirmed for Phase 8.4): BLOG_VIEW reads, SEO_EDIT mutates.
 * This is a NEW Module 8 surface, deliberately not reusing the frozen
 * Module 6 seam route's own BLOG_EDIT gate (POST .../blog/:itemId/
 * internal-linking) — see internal-links.controller.ts's doc comment
 * for the full reasoning.
 */
@Controller("api/v1/workspaces/:workspaceId/blog/:itemId/internal-links")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class BlogInternalLinksController {
  constructor(
    private readonly discovery: InternalLinkDiscoveryService,
    private readonly query: InternalLinksQueryService,
  ) {}

  @Post("generate")
  @RequirePermission(PERMISSIONS.SEO_EDIT)
  @HttpCode(HttpStatus.OK)
  async generate(@CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    // "Refresh" is not a separate route/semantics: generate() is already
    // safe to call repeatedly (Phase 8.2/8.3's own contract — never
    // duplicates a live recommendation, never touches an ACCEPTED one),
    // so calling it again IS the refresh action. See Phase 8.4
    // architecture §F.
    await this.discovery.generateForSource(workspace.id, itemId, workspace.userInternalId, {});
    return { data: await this.query.listForItem(workspace.id, itemId) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.BLOG_VIEW)
  async list(@CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    return { data: await this.query.listForItem(workspace.id, itemId) };
  }
}
