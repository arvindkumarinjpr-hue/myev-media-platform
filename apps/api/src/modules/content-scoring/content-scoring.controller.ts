import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { ContentScoringService } from "./content-scoring.service";
import { serializeScore } from "./content-score.serializer";

/**
 * Module 6 Phase 6.1 — the generic Content Scoring API.
 *
 * Unlike Module 1E's content-items routes (which need dynamic,
 * content-type-aware authorization), scoring is a single SEO-review
 * action that applies identically to every scoreable content type — so
 * a static `@RequirePermission(SEO_SCORE)` decorator is correct here,
 * exactly as ResearchController uses `RESEARCH_RUN`. `SEO_SCORE` is an
 * existing frozen permission (AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md),
 * already seeded and held by Owner / Administrator / Content Manager /
 * SEO Specialist — no new permission is introduced.
 */
@Controller("api/v1/workspaces/:workspaceId/content-items/:contentItemId/score")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class ContentScoringController {
  constructor(private readonly scoring: ContentScoringService) {}

  @Post()
  @RequirePermission(PERMISSIONS.SEO_SCORE)
  @HttpCode(HttpStatus.CREATED)
  async score(@CurrentWorkspace() workspace: WorkspaceContext, @Param("contentItemId") contentItemId: string) {
    const run = await this.scoring.score(workspace.id, contentItemId, { internalId: workspace.userInternalId });
    return { data: serializeScore(run) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.SEO_SCORE)
  async latest(@CurrentWorkspace() workspace: WorkspaceContext, @Param("contentItemId") contentItemId: string) {
    const latest = await this.scoring.getLatest(workspace.id, contentItemId);
    if (!latest) {
      throw new NotFoundException({ code: "CONTENT_SCORE_NOT_FOUND", message: "This content item has not been scored yet." });
    }
    return { data: serializeScore(latest) };
  }
}
