import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import type { MediaAssetStatus, MediaAssetType } from "../../../generated/prisma";
import { MediaAssetsService, type MediaAssetWithProjectPublicId } from "./media-assets.service";
import { CreateUploadIntentDto, CreateVersionUploadIntentDto } from "./dto/create-upload-intent.dto";
import { UpdateMediaAssetDto } from "./dto/update-media-asset.dto";

// DEFECT-1D-001: projectId here is the related project's PUBLIC id (via
// the `project` relation every MediaAssetsService read/write method now
// includes) — never asset.projectId itself, which is the internal FK and
// must never reach a client.
function serializeAsset(asset: MediaAssetWithProjectPublicId) {
  return {
    publicId: asset.publicId,
    projectId: asset.project?.publicId ?? null,
    assetType: asset.assetType,
    originalFilename: asset.originalFilename,
    normalizedFilename: asset.normalizedFilename,
    declaredMimeType: asset.declaredMimeType,
    verifiedMimeType: asset.verifiedMimeType,
    declaredSizeBytes: asset.declaredSizeBytes.toString(),
    verifiedSizeBytes: asset.verifiedSizeBytes?.toString() ?? null,
    status: asset.status,
    malwareScanStatus: asset.malwareScanStatus,
    rejectionReason: asset.rejectionReason,
    versionNumber: asset.versionNumber,
    assetGroupId: asset.assetGroupId,
    duplicateOfAssetId: asset.duplicateOfAssetId,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

@Controller("api/v1/workspaces/:workspaceId/assets")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class MediaAssetsController {
  constructor(private readonly mediaAssets: MediaAssetsService) {}

  @Get("upload-capabilities")
  @RequirePermission(PERMISSIONS.MEDIA_VIEW)
  getUploadCapabilities() {
    return { data: this.mediaAssets.getUploadCapabilities() };
  }

  @Post("upload-intent")
  @RequirePermission(PERMISSIONS.MEDIA_UPLOAD)
  @HttpCode(HttpStatus.CREATED)
  async createUploadIntent(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateUploadIntentDto, @Req() req: Request) {
    const result = await this.mediaAssets.createUploadIntent(workspace, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: result };
  }

  @Post(":assetId/versions/upload-intent")
  @RequirePermission([PERMISSIONS.MEDIA_UPLOAD, PERMISSIONS.MEDIA_MANAGE])
  @HttpCode(HttpStatus.CREATED)
  async createVersionUploadIntent(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("assetId") assetId: string,
    @Body() dto: CreateVersionUploadIntentDto,
    @Req() req: Request,
  ) {
    const result = await this.mediaAssets.createVersionUploadIntent(workspace, workspace.userInternalId, assetId, dto, { ipAddress: req.ip });
    return { data: result };
  }

  @Post(":assetId/confirm")
  @RequirePermission(PERMISSIONS.MEDIA_UPLOAD)
  @HttpCode(HttpStatus.OK)
  async confirm(@CurrentWorkspace() workspace: WorkspaceContext, @Param("assetId") assetId: string, @Req() req: Request) {
    const result = await this.mediaAssets.confirmUpload(workspace, workspace.userInternalId, assetId, { ipAddress: req.ip });
    return { data: result };
  }

  @Post(":assetId/retry-verification")
  @RequirePermission(PERMISSIONS.MEDIA_MANAGE)
  @HttpCode(HttpStatus.OK)
  async retryVerification(@CurrentWorkspace() workspace: WorkspaceContext, @Param("assetId") assetId: string, @Req() req: Request) {
    const result = await this.mediaAssets.retryVerification(workspace, workspace.userInternalId, assetId, { ipAddress: req.ip });
    return { data: result };
  }

  @Get()
  @RequirePermission(PERMISSIONS.MEDIA_VIEW)
  async list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query("projectId") projectId?: string,
    @Query("assetType") assetType?: MediaAssetType,
    @Query("status") status?: MediaAssetStatus,
  ) {
    const assets = await this.mediaAssets.list(workspace.id, { projectId, assetType, status });
    return { data: assets.map(serializeAsset) };
  }

  @Get(":assetId")
  @RequirePermission(PERMISSIONS.MEDIA_VIEW)
  async findOne(@CurrentWorkspace() workspace: WorkspaceContext, @Param("assetId") assetId: string) {
    const asset = await this.mediaAssets.findOne(workspace.id, assetId);
    return { data: serializeAsset(asset) };
  }

  @Get(":assetId/download-url")
  @RequirePermission(PERMISSIONS.MEDIA_VIEW)
  async getDownloadUrl(@CurrentWorkspace() workspace: WorkspaceContext, @Param("assetId") assetId: string, @Req() req: Request) {
    const result = await this.mediaAssets.getDownloadUrl(workspace, workspace.userInternalId, assetId, { ipAddress: req.ip });
    return { data: result };
  }

  @Patch(":assetId")
  @RequirePermission(PERMISSIONS.MEDIA_MANAGE)
  async updateMetadata(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("assetId") assetId: string,
    @Body() dto: UpdateMediaAssetDto,
    @Req() req: Request,
  ) {
    const asset = await this.mediaAssets.updateMetadata(workspace, workspace.userInternalId, assetId, dto, { ipAddress: req.ip });
    return { data: serializeAsset(asset) };
  }

  @Post(":assetId/archive")
  @RequirePermission(PERMISSIONS.MEDIA_MANAGE)
  @HttpCode(HttpStatus.OK)
  async archive(@CurrentWorkspace() workspace: WorkspaceContext, @Param("assetId") assetId: string, @Req() req: Request) {
    const asset = await this.mediaAssets.archive(workspace, workspace.userInternalId, assetId, { ipAddress: req.ip });
    return { data: serializeAsset(asset) };
  }

  @Post(":assetId/restore")
  @RequirePermission(PERMISSIONS.MEDIA_MANAGE)
  @HttpCode(HttpStatus.OK)
  async restore(@CurrentWorkspace() workspace: WorkspaceContext, @Param("assetId") assetId: string, @Req() req: Request) {
    const asset = await this.mediaAssets.restore(workspace, workspace.userInternalId, assetId, { ipAddress: req.ip });
    return { data: serializeAsset(asset) };
  }

  @Delete(":assetId")
  @RequirePermission(PERMISSIONS.MEDIA_DELETE)
  @HttpCode(HttpStatus.OK)
  async softDelete(@CurrentWorkspace() workspace: WorkspaceContext, @Param("assetId") assetId: string, @Req() req: Request) {
    const asset = await this.mediaAssets.softDelete(workspace, workspace.userInternalId, assetId, { ipAddress: req.ip });
    return { data: serializeAsset(asset) };
  }
}
