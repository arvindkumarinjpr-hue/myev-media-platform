import { Module } from "@nestjs/common";
import { ContentPermissionResolver } from "./content-permission.resolver";
import { ContentBodyValidator } from "./content-body-validator";
import { ContentSeriesService } from "./content-series.service";
import { ContentSeriesController } from "./content-series.controller";

@Module({
  controllers: [ContentSeriesController],
  providers: [ContentPermissionResolver, ContentBodyValidator, ContentSeriesService],
  exports: [ContentPermissionResolver, ContentBodyValidator, ContentSeriesService],
})
export class ContentModule {}
