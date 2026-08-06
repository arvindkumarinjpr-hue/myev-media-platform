import { Module } from "@nestjs/common";
import { ContentPermissionResolver } from "./content-permission.resolver";
import { ContentBodyValidator } from "./content-body-validator";
import { ContentSeriesService } from "./content-series.service";
import { ContentSeriesController } from "./content-series.controller";
import { ContentItemsService } from "./content-items.service";
import { ContentItemsController } from "./content-items.controller";

@Module({
  controllers: [ContentSeriesController, ContentItemsController],
  providers: [ContentPermissionResolver, ContentBodyValidator, ContentSeriesService, ContentItemsService],
  exports: [ContentPermissionResolver, ContentBodyValidator, ContentSeriesService, ContentItemsService],
})
export class ContentModule {}
