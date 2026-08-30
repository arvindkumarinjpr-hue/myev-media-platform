import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { MediaStorageService } from "./media-storage.service";
import { MediaAssetWriterService } from "./media-asset-writer.service";

/**
 * Worker-side media persistence infrastructure: the object write path
 * (`MediaStorageService`, @aws-sdk/client-s3) and worker-originated
 * `MediaAsset` persistence + magic-byte/size/checksum verification
 * (`MediaAssetWriterService`). Consumed by the media + render processors
 * in `apps/render-worker`. Provider adapters (OpenAI image, Azure TTS)
 * are NOT here — those live with the processors that use them.
 */
@Global()
@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [MediaStorageService, MediaAssetWriterService],
  exports: [MediaStorageService, MediaAssetWriterService],
})
export class MediaModule {}
