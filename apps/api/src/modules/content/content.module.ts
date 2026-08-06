import { Module } from "@nestjs/common";
import { ContentPermissionResolver } from "./content-permission.resolver";

@Module({
  providers: [ContentPermissionResolver],
  exports: [ContentPermissionResolver],
})
export class ContentModule {}
