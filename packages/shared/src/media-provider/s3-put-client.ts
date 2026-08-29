/**
 * Module 7 Phase 7.4 — minimal S3-compatible PutObject client.
 *
 * WHY this exists rather than reusing apps/api's `MinioStorageProvider`:
 * the MEDIA-queue processors run in the apps/worker process, which has
 * its own strictly-isolated dependency tree and cannot resolve
 * `@aws-sdk/client-s3` (an apps/api-only dependency). This implements the
 * single operation the processors need — a signed `PUT` of a known-length
 * body — using only Node built-ins (`crypto`, global `fetch`), so no new
 * package is added anywhere. AWS Signature V4 for a single unchunked PUT
 * is small and well-specified.
 *
 * apps/api's browser presigned-upload flow and its full StorageProvider
 * surface are untouched — this is purely the worker-side write path for
 * trusted, provider-produced bytes.
 */
import { createHash, createHmac } from "crypto";

export interface S3PutClientConfig {
  /** e.g. "http://localhost:9000" or "https://s3.amazonaws.com". No trailing slash. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** MinIO / most S3-compatible providers need path-style addressing. */
  readonly forcePathStyle?: boolean;
}

export class S3PutError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "S3PutError";
  }
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function uriEncodeKey(key: string): string {
  // Encode each path segment; keep the "/" separators.
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");
}

export class S3PutClient {
  constructor(private readonly config: S3PutClientConfig) {}

  async putObject(input: { key: string; body: Buffer; contentType: string }, signal?: AbortSignal): Promise<void> {
    const res = await this.signedRequest("PUT", input.key, { body: input.body, contentType: input.contentType, signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new S3PutError(`S3 PutObject failed with ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`, res.status);
    }
  }

  /** Reads an object's full bytes. Intended for small sidecar artifacts (e.g. word-timing JSON), not large media. */
  async getObject(key: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await this.signedRequest("GET", key, { signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new S3PutError(`S3 GetObject failed with ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`, res.status);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async signedRequest(
    method: "PUT" | "GET",
    key: string,
    opts: { body?: Buffer; contentType?: string; signal?: AbortSignal },
  ): Promise<Response> {
    const { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle } = this.config;
    const url = new URL(endpoint);
    const encodedKey = uriEncodeKey(key);
    const canonicalUri = forcePathStyle ? `/${bucket}/${encodedKey}` : `/${encodedKey}`;
    const requestHost = forcePathStyle ? url.host : `${bucket}.${url.host}`;
    const requestUrl = `${url.protocol}//${requestHost}${canonicalUri}`;

    const { amzDate: xAmzDate, dateStamp } = amzDate(new Date());
    const payloadHash = opts.body ? sha256Hex(opts.body) : sha256Hex("");

    const headers: Record<string, string> = { host: requestHost, "x-amz-content-sha256": payloadHash, "x-amz-date": xAmzDate };
    if (method === "PUT" && opts.contentType) headers["content-type"] = opts.contentType;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", xAmzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kSigning = hmac(hmac(hmac(kDate, region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      return await fetch(requestUrl, { method, headers: { ...headers, authorization }, body: opts.body, signal: opts.signal });
    } catch (err) {
      throw new S3PutError(`S3 ${method}Object network failure: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
