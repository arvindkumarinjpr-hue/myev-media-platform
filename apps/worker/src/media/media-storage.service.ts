import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import type { WorkerConfig } from "../config/configuration";

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Module 7 Phase 7.4 — worker-side object storage for the MEDIA
 * processors. Built on the SAME `@aws-sdk/client-s3` surface apps/api's
 * `MinioStorageProvider` uses (a plain S3 client — MinIO / AWS S3 /
 * Cloudflare R2 / other S3-compatible via endpoint + forcePathStyle +
 * credentials config alone). apps/api's presigned browser-upload flow is
 * untouched; this is purely the worker-side write path for trusted,
 * provider-produced bytes.
 */
@Injectable()
export class MediaStorageService implements OnModuleInit {
  private readonly logger = new Logger(MediaStorageService.name);
  private readonly client: S3Client;
  readonly bucket: string;
  readonly providerIdentity: string;
  private readonly autoCreateBucket: boolean;

  constructor(config: ConfigService<WorkerConfig, true>) {
    const s = config.get("storage", { infer: true });
    const protocol = s.useSsl ? "https" : "http";
    this.bucket = s.bucket;
    this.providerIdentity = s.providerIdentity;
    this.autoCreateBucket = s.autoCreateBucket;
    this.client = new S3Client({
      endpoint: `${protocol}://${s.endpoint}:${s.port}`,
      region: s.region,
      credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
      forcePathStyle: s.forcePathStyle,
    });
  }

  /**
   * Ensures the bucket exists — HeadBucket first, and CreateBucket ONLY
   * when the bucket is genuinely missing AND auto-create is enabled
   * (`MEDIA_STORAGE_AUTO_CREATE_BUCKET`, default true for the local /
   * CI MinIO stack; a production deploy against AWS S3 / R2 sets it
   * false). A permission failure (403) is logged and left alone — it
   * never triggers an infrastructure-creation attempt.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      const missing = status === 404 || name === "NotFound" || name === "NoSuchBucket";
      if (!missing) {
        this.logger.warn(`Bucket "${this.bucket}" head check did not confirm existence (status ${status ?? "?"}, ${name ?? "?"}) — not attempting to create it.`);
        return;
      }
      if (!this.autoCreateBucket) {
        this.logger.warn(`Bucket "${this.bucket}" does not exist and MEDIA_STORAGE_AUTO_CREATE_BUCKET is disabled — not creating it.`);
        return;
      }
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created media bucket "${this.bucket}".`);
      } catch (createErr) {
        const cn = (createErr as { name?: string })?.name;
        if (cn === "BucketAlreadyOwnedByYou" || cn === "BucketAlreadyExists") return;
        this.logger.warn(`Could not create media bucket "${this.bucket}": ${(createErr as Error).message}`);
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }), { abortSignal: signal });
  }

  /** Reads a small sidecar artifact (word-timing JSON) — not large media. */
  async getText(key: string, signal?: AbortSignal): Promise<string> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    if (!res.Body) throw new Error(`getText: object ${key} has no body`);
    return (await streamToBuffer(res.Body as Readable)).toString("utf8");
  }
}
