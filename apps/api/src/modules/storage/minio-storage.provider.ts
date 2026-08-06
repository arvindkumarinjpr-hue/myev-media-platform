import { createHash } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "stream";
import type { AppConfig } from "../../config/configuration";
import type {
  HeadObjectResult,
  PresignedUploadInstruction,
  StorageOperationOptions,
  StorageProvider,
} from "./storage-provider.interface";

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * MinIO implementation, built on the standard S3 API surface — S3 POST
 * policies, HeadObject, ranged GetObject, presigned GetObject, are all
 * plain S3 operations MinIO implements natively. A real S3-compatible
 * provider (AWS S3, Cloudflare R2, other) uses this exact same class with
 * different endpoint/forcePathStyle config — see Module 1D Engineering
 * Plan §4/§7: the CODE implementation is shared; only the deployment-time
 * config (and the `MediaStorageProviderIdentity` stamped onto each row)
 * differs.
 */
@Injectable()
export class MinioStorageProvider implements StorageProvider {
  private readonly logger = new Logger(MinioStorageProvider.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly healthCheckUrl: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const storage = this.config.get("storage", { infer: true });
    const protocol = storage.useSsl ? "https" : "http";
    const endpoint = `${protocol}://${storage.endpoint}:${storage.port}`;
    this.bucket = storage.bucket;
    this.healthCheckUrl = `${endpoint}/minio/health/live`;
    this.client = new S3Client({
      endpoint,
      region: "us-east-1", // MinIO ignores region but the SDK requires one
      credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
      forcePathStyle: true, // required for MinIO; harmless for most S3-compatible providers
    });
  }

  async createUploadInstruction(input: {
    key: string;
    declaredContentType: string;
    minSizeBytes: number;
    maxSizeBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUploadInstruction> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: input.key,
      Conditions: [
        ["content-length-range", input.minSizeBytes, input.maxSizeBytes],
        ["eq", "$Content-Type", input.declaredContentType],
      ],
      Fields: {
        "Content-Type": input.declaredContentType,
      },
      Expires: input.expiresInSeconds,
    });
    return {
      method: "POST",
      url,
      fields,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async headObject(key: string, options?: StorageOperationOptions): Promise<HeadObjectResult> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: options?.signal,
      });
      return {
        exists: true,
        reportedSizeBytes: result.ContentLength,
        reportedContentType: result.ContentType,
        etag: result.ETag,
      };
    } catch (error) {
      if (this.isNotFound(error)) return { exists: false };
      throw error;
    }
  }

  async inspectObjectPrefix(key: string, maxBytes: number, options?: StorageOperationOptions): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }),
      { abortSignal: options?.signal },
    );
    if (!result.Body) return Buffer.alloc(0);
    return streamToBuffer(result.Body as Readable);
  }

  async computeSha256(key: string, options?: StorageOperationOptions): Promise<string> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: options?.signal,
    });
    if (!result.Body) throw new Error(`computeSha256: object ${key} has no body`);
    const hash = createHash("sha256");
    for await (const chunk of result.Body as Readable) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }

  async createPresignedDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    downloadFilename?: string;
  }): Promise<{ downloadUrl: string; expiresAt: Date }> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ResponseContentDisposition: input.downloadFilename ? `attachment; filename="${input.downloadFilename}"` : undefined,
    });
    const downloadUrl = await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds });
    return { downloadUrl, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000) };
  }

  async deleteObject(key: string, options?: StorageOperationOptions): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: options?.signal });
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(this.healthCheckUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) return { healthy: true };
      return { healthy: false, detail: `MinIO health endpoint returned ${response.status}` };
    } catch (error) {
      this.logger.warn(`Storage (MinIO) health check failed: ${(error as Error).message}`);
      return { healthy: false, detail: (error as Error).message };
    }
  }

  private isNotFound(error: unknown): boolean {
    const name = (error as { name?: string })?.name;
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return name === "NotFound" || name === "NoSuchKey" || statusCode === 404;
  }
}
