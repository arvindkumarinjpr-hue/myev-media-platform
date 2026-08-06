import { Module } from "@nestjs/common";
import { STORAGE_PROVIDER } from "./storage-provider.interface";
import { MinioStorageProvider } from "./minio-storage.provider";

/**
 * MinioStorageProvider is the only implementation shipped — it's a plain
 * S3-API client, so the same class already serves any real S3-compatible
 * backend (AWS S3, Cloudflare R2, other) via config alone (endpoint,
 * forcePathStyle, credentials), not a second implementation class. See
 * Module 1D Engineering Plan §4/§7.
 */
@Module({
  providers: [{ provide: STORAGE_PROVIDER, useClass: MinioStorageProvider }],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
