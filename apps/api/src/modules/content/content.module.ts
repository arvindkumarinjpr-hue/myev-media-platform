import { Module } from "@nestjs/common";
import { ContentPermissionResolver } from "./content-permission.resolver";
import { ContentSeriesService } from "./content-series.service";
import { ContentSeriesController } from "./content-series.controller";

@Module({
  controllers: [ContentSeriesController],
  providers: [ContentPermissionResolver, ContentSeriesService],
  exports: [ContentPermissionResolver, ContentSeriesService],
})
export class ContentModule {}
