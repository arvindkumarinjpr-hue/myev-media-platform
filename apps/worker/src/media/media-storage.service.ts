import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3PutClient } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";

/**
 * Module 7 Phase 7.4 — worker-side object write. Uses `@myev/shared`'s
 * dependency-free `S3PutClient` (the worker can't resolve
 * `@aws-sdk/client-s3`). apps/api's presigned browser-upload flow is
 * untouched.
 */
@Injectable()
export class MediaStorageService implements OnModuleInit {
  private readonly logger = new Logger(MediaStorageService.name);
  private readonly client: S3PutClient;
  readonly bucket: string;
  readonly providerIdentity: string;

  constructor(config: ConfigService<WorkerConfig, true>) {
    const s = config.get("storage", { infer: true });
    const protocol = s.useSsl ? "https" : "http";
    this.bucket = s.bucket;
    this.providerIdentity = (process.env.STORAGE_PROVIDER_IDENTITY as string) ?? "MINIO";
    this.client = new S3PutClient({
      endpoint: `${protocol}://${s.endpoint}:${s.port}`,
      region: s.region,
      bucket: s.bucket,
      accessKeyId: s.accessKey,
      secretAccessKey: s.secretKey,
      forcePathStyle: s.forcePathStyle,
    });
  }

  /**
   * The Worker E2E suite runs before apps/api's own suite (which is what
   * normally auto-creates the bucket via MinioStorageProvider.onModuleInit)
   * — so a media worker must ensure its own bucket, exactly as the API
   * provider does. Idempotent; a failure here is warned, not fatal (a
   * later putObject surfaces a real problem loudly).
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.ensureBucket();
    } catch (err) {
      this.logger.warn(`Could not ensure media bucket "${this.bucket}" exists: ${(err as Error).message}`);
    }
  }

  async put(key: string, body: Buffer, contentType: string, signal?: AbortSignal): Promise<void> {
    await this.client.putObject({ key, body, contentType }, signal);
  }

  async getText(key: string, signal?: AbortSignal): Promise<string> {
    return (await this.client.getObject(key, signal)).toString("utf8");
  }
}
