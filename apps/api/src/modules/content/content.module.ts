import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ContentPermissionResolver } from "./content-permission.resolver";
import { ContentBodyValidator } from "./content-body-validator";
import { ContentSeriesService } from "./content-series.service";
import { ContentSeriesController } from "./content-series.controller";
import { ContentItemsService } from "./content-items.service";
import { ContentItemsController } from "./content-items.controller";

// AuthModule import is required here (same pattern as MediaAssetsModule):
// both controllers' SessionGuard depends on JwtService, which AuthModule
// provides/exports — not automatically visible just because RbacModule is
// @Global().
@Module({
  imports: [AuthModule],
  controllers: [ContentSeriesController, ContentItemsController],
  providers: [ContentPermissionResolver, ContentBodyValidator, ContentSeriesService, ContentItemsService],
  exports: [ContentPermissionResolver, ContentBodyValidator, ContentSeriesService, ContentItemsService],
})
export class ContentModule {}
