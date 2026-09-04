import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { normalizeHumanAnchorText, validateHumanAnchorText } from "./internal-link-anchor";
import { RejectInternalLinkDto } from "./dto/reject-internal-link.dto";
import { UpdateInternalLinkAnchorDto } from "./dto/update-internal-link-anchor.dto";
import { INTERNAL_LINK_ERRORS } from "./internal-link.errors";
import { InternalLinkIntelligenceService } from "./internal-link-intelligence.service";
import { InternalLinksService } from "./internal-links.service";

function serialize(row: { publicId: string; anchorText: string; relevanceScore: number; status: string; reviewedAt: Date | null; rejectionReason: string | null; staleReason: string | null }) {
  return {
    publicId: row.publicId,
    anchorText: row.anchorText,
    relevanceScore: row.relevanceScore,
    status: row.status,
    reviewedAt: row.reviewedAt,
    rejectionReason: row.rejectionReason,
    staleReason: row.staleReason,
  };
}

/**
 * Module 8 Phase 8.4 — recommendation-id-scoped human review actions:
 * edit anchor, accept, reject. See BlogInternalLinksController's doc
 * comment for the split rationale; SEO_EDIT-gated throughout (corrected
 * D16 — no read route lives here, only mutations).
 */
@Controller("api/v1/workspaces/:workspaceId/internal-links")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class InternalLinksController {
  constructor(
    private readonly internalLinks: InternalLinksService,
    private readonly intelligence: InternalLinkIntelligenceService,
  ) {}

  // Module 8 Phase 8.5 — orphan/cluster/workspace link-health
  // intelligence. All three are read-only, BLOG_VIEW-gated (Part P: no
  // new permission, SEO_EDIT never required merely to inspect health
  // data). Static path segments ("orphans", "cluster-health", "summary")
  // never collide with the :id-scoped PATCH/POST routes below — this
  // controller has no other GET route at all.
  @Get("orphans")
  @RequirePermission(PERMISSIONS.BLOG_VIEW)
  async orphans(@CurrentWorkspace() workspace: WorkspaceContext) {
    return { data: await this.intelligence.listOrphans(workspace.id) };
  }

  @Get("cluster-health")
  @RequirePermission(PERMISSIONS.BLOG_VIEW)
  async clusterHealth(@CurrentWorkspace() workspace: WorkspaceContext) {
    return { data: await this.intelligence.clusterHealth(workspace.id) };
  }

  @Get("summary")
  @RequirePermission(PERMISSIONS.BLOG_VIEW)
  async summary(@CurrentWorkspace() workspace: WorkspaceContext) {
    return { data: await this.intelligence.workspaceSummary(workspace.id) };
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.SEO_EDIT)
  async updateAnchor(@CurrentWorkspace() workspace: WorkspaceContext, @Param("id") id: string, @Body() dto: UpdateInternalLinkAnchorDto) {
    // Human anchor-edit validation is deliberately distinct from the
    // Phase 8.3 automatic engine's own rules (validateAnchorStructure) —
    // see internal-link-anchor.ts's doc comment on validateHumanAnchorText.
    const validation = validateHumanAnchorText(dto.anchorText);
    if (!validation.valid) {
      throw new UnprocessableEntityException({ code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_ANCHOR_VALIDATION_FAILED, message: `Anchor text is invalid: ${validation.reason}.` });
    }
    // Read first only to preserve the existing (Phase 8.2/8.3) evidence
    // onto which this edit's own marker is merged — updateAnchor()'s own
    // atomic, status-scoped write remains the sole authority on WHETHER
    // the edit is allowed to apply (GENERATED only), exactly as it is
    // for the Phase 8.3 automatic engine.
    const current = await this.internalLinks.findOne(workspace.id, id);
    const normalized = normalizeHumanAnchorText(dto.anchorText);
    const mergedEvidence = { ...(current.evidence as Record<string, unknown>), anchor: { ...((current.evidence as Record<string, unknown>)?.anchor as Record<string, unknown> | undefined), humanEdited: true, editedAt: new Date().toISOString(), previousAnchor: current.anchorText } };
    const updated = await this.internalLinks.updateAnchor(workspace.id, id, { anchorText: normalized, evidence: mergedEvidence });
    return { data: serialize(updated) };
  }

  @Post(":id/accept")
  @RequirePermission(PERMISSIONS.SEO_EDIT)
  @HttpCode(HttpStatus.OK)
  async accept(@CurrentWorkspace() workspace: WorkspaceContext, @Param("id") id: string) {
    const updated = await this.internalLinks.accept(workspace.id, id, workspace.userInternalId);
    return { data: serialize(updated) };
  }

  @Post(":id/reject")
  @RequirePermission(PERMISSIONS.SEO_EDIT)
  @HttpCode(HttpStatus.OK)
  async reject(@CurrentWorkspace() workspace: WorkspaceContext, @Param("id") id: string, @Body() dto: RejectInternalLinkDto) {
    const updated = await this.internalLinks.reject(workspace.id, id, workspace.userInternalId, dto.rejectionReason);
    return { data: serialize(updated) };
  }
}
