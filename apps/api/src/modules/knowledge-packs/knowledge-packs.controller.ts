import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { KnowledgePacksService, type KnowledgePackWithChildren } from "./knowledge-packs.service";
import { CreateKnowledgePackDto } from "./dto/create-knowledge-pack.dto";
import { UpdateKnowledgePackDto } from "./dto/update-knowledge-pack.dto";

/**
 * Phase 2.2 — Core CRUD (Draft only). Phase 2.3 adds validate/activate,
 * now covering both first-version and successor supersession (Phase 2.4).
 * Phase 2.4 adds version creation/history. No explicit archive endpoint
 * here — see MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §17, Phase 2.5.
 */
function serialize(pack: KnowledgePackWithChildren) {
  return {
    publicId: pack.publicId,
    name: pack.name,
    status: pack.status,
    versionNumber: pack.versionNumber,
    lockVersion: pack.lockVersion,
    industryProfile: pack.industryProfile,
    publishingStrategy: pack.publishingStrategy,
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
    sources: pack.knowledgeSources.map((s) => ({ sourceType: s.sourceType, url: s.url })),
    promptTemplates: pack.promptTemplates.map((p) => ({ contentType: p.contentType, promptBody: p.promptBody, versionNumber: p.versionNumber })),
    seoRules: pack.seoRules.map((r) => ({
      primaryKeywords: r.primaryKeywords,
      secondaryKeywords: r.secondaryKeywords,
      internalLinkingPolicy: r.internalLinkingPolicy,
      schemaPreferences: r.schemaPreferences,
    })),
    brandGuidelines: pack.brandGuidelines.map((b) => ({ toneOfVoice: b.toneOfVoice, terminology: b.terminology, ctaRules: b.ctaRules, logoAssetId: b.logoAssetId })),
    keywordSets: pack.keywordSets.map((k) => ({ name: k.name, keywords: k.keywords })),
    competitors: pack.competitors.map((c) => ({ domain: c.domain, notes: c.notes })),
  };
}

@Controller("api/v1/workspaces/:workspaceId/knowledge-packs")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class KnowledgePacksController {
  constructor(private readonly knowledgePacks: KnowledgePacksService) {}

  @Post()
  @RequirePermission(PERMISSIONS.KP_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateKnowledgePackDto, @Req() req: Request) {
    const pack = await this.knowledgePacks.create(workspace.id, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: serialize(pack) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.KP_VIEW)
  async list(@CurrentWorkspace() workspace: WorkspaceContext, @Query("projectId") projectId?: string) {
    const packs = await this.knowledgePacks.list(workspace.id, { projectId });
    return { data: packs.map((p) => ({ publicId: p.publicId, name: p.name, status: p.status, versionNumber: p.versionNumber })) };
  }

  @Get(":knowledgePackId")
  @RequirePermission(PERMISSIONS.KP_VIEW)
  async findOne(@CurrentWorkspace() workspace: WorkspaceContext, @Param("knowledgePackId") knowledgePackId: string) {
    const pack = await this.knowledgePacks.findOne(workspace.id, knowledgePackId);
    return { data: serialize(pack) };
  }

  @Patch(":knowledgePackId")
  @RequirePermission(PERMISSIONS.KP_UPDATE)
  async update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("knowledgePackId") knowledgePackId: string,
    @Body() dto: UpdateKnowledgePackDto,
    @Req() req: Request,
  ) {
    const pack = await this.knowledgePacks.update(workspace.id, knowledgePackId, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: serialize(pack) };
  }

  @Delete(":knowledgePackId")
  @RequirePermission(PERMISSIONS.KP_DELETE)
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentWorkspace() workspace: WorkspaceContext, @Param("knowledgePackId") knowledgePackId: string, @Req() req: Request) {
    await this.knowledgePacks.remove(workspace.id, knowledgePackId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Post(":knowledgePackId/validate")
  @RequirePermission(PERMISSIONS.KP_VALIDATE)
  @HttpCode(HttpStatus.OK)
  async validate(@CurrentWorkspace() workspace: WorkspaceContext, @Param("knowledgePackId") knowledgePackId: string, @Req() req: Request) {
    const pack = await this.knowledgePacks.validate(workspace.id, knowledgePackId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: serialize(pack) };
  }

  @Post(":knowledgePackId/archive")
  @RequirePermission(PERMISSIONS.KP_ARCHIVE)
  @HttpCode(HttpStatus.OK)
  async archive(@CurrentWorkspace() workspace: WorkspaceContext, @Param("knowledgePackId") knowledgePackId: string, @Req() req: Request) {
    const pack = await this.knowledgePacks.archive(workspace.id, knowledgePackId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: serialize(pack) };
  }

  @Post(":knowledgePackId/versions")
  @RequirePermission(PERMISSIONS.KP_UPDATE)
  @HttpCode(HttpStatus.CREATED)
  async createVersion(@CurrentWorkspace() workspace: WorkspaceContext, @Param("knowledgePackId") knowledgePackId: string, @Req() req: Request) {
    const pack = await this.knowledgePacks.createVersion(workspace.id, knowledgePackId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: serialize(pack) };
  }

  @Get(":knowledgePackId/versions")
  @RequirePermission(PERMISSIONS.KP_VIEW)
  async listVersions(@CurrentWorkspace() workspace: WorkspaceContext, @Param("knowledgePackId") knowledgePackId: string) {
    const versions = await this.knowledgePacks.listVersions(workspace.id, knowledgePackId);
    return {
      data: versions.map((v) => ({
        publicId: v.publicId,
        name: v.name,
        status: v.status,
        versionNumber: v.versionNumber,
        currentVersionOfPublicId: v.currentVersionOf?.publicId ?? null,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
        archivedAt: v.archivedAt,
      })),
    };
  }
}
