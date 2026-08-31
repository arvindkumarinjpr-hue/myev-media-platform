import type { ConfigService } from "@nestjs/config";
import { MinioStorageProvider } from "./minio-storage.provider";
import type { AppConfig } from "../../config/configuration";

/**
 * Regression coverage for the MODULE 7 VOICE PREVIEW UAT DEFECT: presigned
 * URLs previously always signed against `storage.endpoint` — the FAST,
 * INTERNAL address the API server itself uses to talk to MinIO (on
 * staging, the Docker Compose service name `minio`, unreachable from any
 * real browser). Signing and connecting used the exact same S3Client, so
 * there was no way for a real browser to ever load a preview, regardless
 * of how correct everything else in the pipeline was.
 *
 * getSignedUrl()/createPresignedPost() are pure, local, offline
 * cryptographic operations — no network call, no live MinIO needed to
 * unit-test which host they sign against.
 */
function makeConfig(overrides: Partial<AppConfig["storage"]> = {}): ConfigService<AppConfig, true> {
  const storage: AppConfig["storage"] = {
    endpoint: "minio",
    port: 9000,
    useSsl: false,
    accessKey: "test-access-key",
    secretKey: "test-secret-key",
    bucket: "test-bucket",
    ...overrides,
  };
  return { get: () => storage } as unknown as ConfigService<AppConfig, true>;
}

describe("MinioStorageProvider — presigned URL host", () => {
  it("with no publicEndpoint configured, signs against the internal endpoint (unchanged fallback — every env that never sets STORAGE_PUBLIC_ENDPOINT is unaffected)", async () => {
    const provider = new MinioStorageProvider(makeConfig());
    const { downloadUrl } = await provider.createPresignedDownloadUrl({ key: "workspaces/w/audio.wav", expiresInSeconds: 300 });
    expect(new URL(downloadUrl).host).toBe("minio:9000");
  });

  it("with publicEndpoint configured, signs the download URL against the PUBLIC host instead — this is what makes it reachable from a real browser", async () => {
    const provider = new MinioStorageProvider(makeConfig({ publicEndpoint: "https://staging.myevmedia.com/media-objects" }));
    const { downloadUrl } = await provider.createPresignedDownloadUrl({ key: "workspaces/w/audio.wav", expiresInSeconds: 300 });
    const url = new URL(downloadUrl);
    expect(url.host).toBe("staging.myevmedia.com");
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toContain("/media-objects/");
    // The internal Docker-only hostname must never appear anywhere in a
    // URL a browser is ever handed.
    expect(downloadUrl).not.toContain("minio:9000");
  });

  it("the upload presign instruction is signed against the same public host when configured (same defect class, same fix)", async () => {
    const provider = new MinioStorageProvider(makeConfig({ publicEndpoint: "https://staging.myevmedia.com/media-objects" }));
    const instruction = await provider.createUploadInstruction({
      key: "workspaces/w/upload.png",
      declaredContentType: "image/png",
      minSizeBytes: 1,
      maxSizeBytes: 1_000_000,
      expiresInSeconds: 300,
    });
    expect(new URL(instruction.url).host).toBe("staging.myevmedia.com");
    expect(instruction.url).not.toContain("minio:9000");
  });

  it("a publicEndpoint with a non-default port is preserved exactly in the signed host", async () => {
    const provider = new MinioStorageProvider(makeConfig({ publicEndpoint: "https://staging.myevmedia.com:8443/media-objects" }));
    const { downloadUrl } = await provider.createPresignedDownloadUrl({ key: "k", expiresInSeconds: 60 });
    expect(new URL(downloadUrl).host).toBe("staging.myevmedia.com:8443");
  });
});
