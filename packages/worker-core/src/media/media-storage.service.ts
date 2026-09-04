import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import type { WorkerCoreConfig } from "../config/worker-core-config";

/** Result of `MediaStorageService.headObject()` — just enough to plan a bounded/ranged read; never exposes the underlying S3 SDK's own response type. */
export interface MediaObjectHead {
  sizeBytes: number;
  contentType?: string;
}

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

  constructor(config: ConfigService<WorkerCoreConfig, true>) {
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

  /**
   * Reads an object's full bytes from the trusted internal store. Used by
   * the render worker to materialize a render's private input assets
   * (scene images, narration audio, subtitle track) into a job-scoped
   * temp dir. `maxBytes` fails closed on an unexpectedly large object.
   */
  async getBytes(key: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    if (!res.Body) throw new Error(`getBytes: object ${key} has no body`);
    const declared = res.ContentLength ?? 0;
    if (declared > maxBytes) throw new Error(`getBytes: object ${key} is ${declared} bytes, over the ${maxBytes} limit`);
    const buf = await streamToBuffer(res.Body as Readable);
    if (buf.length > maxBytes) throw new Error(`getBytes: object ${key} exceeded the ${maxBytes} limit while streaming`);
    return buf;
  }

  /**
   * Module 9 Phase 9.5 (enabling change, Publishing/YouTube-scoped) —
   * object size/content-type without reading any bytes. The one thing a
   * caller needs before planning a chunked/ranged read of a large object
   * (e.g. a resumable-upload connector) — never buffers the object
   * itself. `getBytes()` above is unchanged and remains the right choice
   * for every existing (small/bounded) consumer.
   */
  async headObject(key: string, signal?: AbortSignal): Promise<MediaObjectHead> {
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    if (res.ContentLength === undefined) throw new Error(`headObject: object ${key} reported no Content-Length`);
    return { sizeBytes: res.ContentLength, contentType: res.ContentType };
  }

  /**
   * Module 9 Phase 9.5 (enabling change) — reads exactly one bounded
   * byte range `[start, end]` (both inclusive, S3/MinIO `Range` header
   * semantics) via the SAME `GetObjectCommand` `getBytes()` already
   * uses, generalized from `inspectObjectPrefix`'s own fixed-start-at-0
   * precedent (apps/api's MinioStorageProvider). Memory usage is bounded
   * by the caller's own chunk size — this method itself never reads more
   * than the one requested range into memory, so a caller can read an
   * arbitrarily large object incrementally (one chunk at a time) without
   * ever buffering the full object. Throws if the object returns fewer
   * bytes than the requested range implies (a short/truncated read is
   * never silently accepted as complete).
   */
  async getRange(key: string, start: number, end: number, signal?: AbortSignal): Promise<Buffer> {
    if (start < 0 || end < start) throw new Error(`getRange: invalid range [${start}, ${end}] for object ${key}`);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }), { abortSignal: signal });
    if (!res.Body) throw new Error(`getRange: object ${key} has no body`);
    const buf = await streamToBuffer(res.Body as Readable);
    const expectedBytes = end - start + 1;
    if (buf.length !== expectedBytes) throw new Error(`getRange: object ${key} returned ${buf.length} bytes for range [${start}, ${end}], expected ${expectedBytes}`);
    return buf;
  }
}
