/**
 * Provider-neutral storage abstraction (Module 1D Engineering Plan §4).
 * Business code (MediaAssetsService) depends only on this interface, never
 * on an AWS/MinIO SDK type directly.
 */

/**
 * `method: "PUT"` exists for forward compatibility (a future provider or
 * asset type might need it) — Module 1D's implementations only ever
 * produce `"POST"` instructions (see plan §1). Consuming code must branch
 * on `method` rather than assume POST, even though it only ever sees POST
 * today.
 *
 * `fields` is populated for a POST instruction (multipart form fields,
 * including the storage-enforced policy conditions — see plan §2);
 * `headers` would be populated for a hypothetical future PUT instruction.
 * Never persist `url`/`fields`/`headers` anywhere — not in the database,
 * not in a log line (Module 1D Engineering Plan §9).
 */
export interface PresignedUploadInstruction {
  method: "PUT" | "POST";
  url: string;
  headers?: Record<string, string>;
  fields?: Record<string, string>;
  expiresAt: Date;
}

export interface StorageOperationOptions {
  signal?: AbortSignal;
}

export interface HeadObjectResult {
  exists: boolean;
  // Explicitly NOT called "verifiedContentType" — for a plain PUT/POST
  // upload this is often just the client's own Content-Type echoed back
  // as object metadata by the storage service. Never treated as a
  // verified MIME type anywhere in business logic (see plan §6/§2).
  reportedSizeBytes?: number;
  reportedContentType?: string;
  etag?: string;
}

export interface StorageProvider {
  createUploadInstruction(input: {
    key: string;
    declaredContentType: string;
    minSizeBytes: number;
    maxSizeBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUploadInstruction>;

  /**
   * Module 7 Phase 7.4 — server-side direct write for WORKER-ORIGINATED
   * bytes (a generated image, synthesized audio, a rendered subtitle
   * file). Distinct from the presigned browser-upload flow: the caller
   * already holds trusted, provider-produced bytes in memory — no
   * untrusted client upload, no presigned round-trip. The caller is
   * responsible for having computed the checksum and verified the MIME
   * via magic bytes BEFORE calling this; this method just writes.
   */
  putObject(input: { key: string; body: Buffer; contentType: string }, options?: StorageOperationOptions): Promise<void>;

  headObject(key: string, options?: StorageOperationOptions): Promise<HeadObjectResult>;

  /**
   * Bounded ranged read for magic-byte inspection — never the full
   * object. The implementation caps at `maxBytes` regardless of what a
   * caller requests beyond that.
   */
  inspectObjectPrefix(key: string, maxBytes: number, options?: StorageOperationOptions): Promise<Buffer>;

  /**
   * Full streaming SHA-256 — the only method here that reads an entire
   * object. Callers must enforce the synchronous-size ceiling themselves
   * before calling this; the method has no size awareness of its own.
   */
  computeSha256(key: string, options?: StorageOperationOptions): Promise<string>;

  createPresignedDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    downloadFilename?: string;
  }): Promise<{ downloadUrl: string; expiresAt: Date }>;

  deleteObject(key: string, options?: StorageOperationOptions): Promise<void>;

  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}

export const STORAGE_PROVIDER = Symbol("STORAGE_PROVIDER");
