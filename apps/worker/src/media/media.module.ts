import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MediaProviderRegistryModule } from "../media-provider/media-provider-registry.module";
import { MediaStorageService } from "./media-storage.service";
import { MediaAssetWriterService } from "./media-asset-writer.service";

/**
 * Module 7 Phase 7.4 — worker-side media infrastructure: the object
 * write path (`MediaStorageService` → `@myev/shared` S3PutClient) and the
 * worker-originated MediaAsset persistence + verification
 * (`MediaAssetWriterService`). Consumed by the three MEDIA processors.
 */
@Global()
@Module({
  imports: [ConfigModule, MediaProviderRegistryModule],
  providers: [MediaStorageService, MediaAssetWriterService],
  exports: [MediaStorageService, MediaAssetWriterService],
})
export class MediaModule {}
