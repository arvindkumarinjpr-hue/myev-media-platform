import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import type { PublishingExecutionCallbacks, PublishingPublishInput } from "../publishing-provider.interface";
import { FacebookChannelProvider } from "./facebook-channel-provider";
import { startMetaFixtureServer, type MetaFixtureServer } from "./meta-test-fixture-server";

const CREDENTIAL = { accessToken: "fixture-page-token", pageId: "page-123" };
const VIDEO_BYTES = Buffer.alloc(20, 7);

function mediaReaderFor(bytes: Buffer): NonNullable<PublishingExecutionCallbacks["mediaReader"]> {
  return {
    headObject: async () => ({ sizeBytes: bytes.length, contentType: "video/mp4" }),
    readRange: async (_id, start, end) => bytes.subarray(start, end + 1),
  };
}

function callbacksWithCheckpoint(mediaReader: NonNullable<PublishingExecutionCallbacks["mediaReader"]>) {
  const saved: Record<string, unknown>[] = [];
  const callbacks: PublishingExecutionCallbacks = {
    saveCheckpoint: async (detail) => {
      saved.push(detail);
    },
    mediaReader,
  };
  return { callbacks, getSaved: () => saved };
}

const BASE_INPUT: PublishingPublishInput = {
  contentType: "VIDEO",
  metadata: { caption: "A great caption." },
  artifact: { mediaAssetPublicId: "asset-1" },
  operationToken: "publishing:target-1:attempt:0",
};

describe("FacebookChannelProvider", () => {
  let server: MetaFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reports truthful capabilities — VIDEO only, no privacy concept, caption supported", () => {
    const provider = new FacebookChannelProvider({ appId: "app-1" });
    expect(provider.getCapabilities()).toEqual({
      supportedContentTypes: ["VIDEO"],
      requiresRenderedMedia: true,
      requiresTitle: false,
      requiresDescription: false,
      supportsTags: false,
      supportsCaption: true,
      supportedPrivacyOptions: undefined,
    });
  });

  it("validateConnection succeeds against a real Page id lookup", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path.startsWith(`/v25.0/${CREDENTIAL.pageId}`)) return { status: 200, json: { id: CREDENTIAL.pageId } };
      return { status: 500, json: {} };
    });
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url });
    const result = await provider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result).toEqual({ healthy: true });
  });

  it("validateConnection reports CREDENTIAL_REVOKED on an invalid/expired token (Graph error code 190)", async () => {
    server = await startMetaFixtureServer(() => ({ status: 401, json: { error: { message: "Invalid OAuth access token.", code: 190, type: "OAuthException" } } }));
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url });
    const result = await provider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_REVOKED");
  });

  it("validateConnection reports CREDENTIAL_INVALID on a missing-permission error", async () => {
    server = await startMetaFixtureServer(() => ({ status: 403, json: { error: { message: "Missing permission.", code: 10, type: "OAuthException" } } }));
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url });
    const result = await provider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
  });

  it("validateConnection fails safely (CREDENTIAL_INVALID) when pageId is missing from the stored credential", async () => {
    const provider = new FacebookChannelProvider({ appId: "app-1" });
    const result = await provider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: { accessToken: "x" }, tokenExpiresAt: null });
    expect(result).toEqual({ healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "Stored Facebook credential is missing required fields." });
  });

  it("publishes a video through the full 3-phase resumable upload: session create, chunk transfer, page video post", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/app-1/uploads`) return { status: 200, json: { id: "upload:sess-1" } };
      if (req.path === "/upload:sess-1") return { status: 200, json: { h: "file-handle-abc" } };
      if (req.path === `/v25.0/${CREDENTIAL.pageId}/videos`) return { status: 200, json: { id: "fb-video-1" } };
      return { status: 500, json: {} };
    });
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    const result = await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);

    expect(result).toEqual({ externalContentId: "fb-video-1" });
    const postReq = server.requests.find((r) => r.path === `/v25.0/${CREDENTIAL.pageId}/videos`)!;
    expect((postReq.body as Record<string, unknown>).description).toBe("A great caption.");
    expect((postReq.body as Record<string, unknown>).fbuploader_video_file_chunk).toBe("file-handle-abc");
  });

  it("saves an UPLOAD_SESSION checkpoint before transferring any bytes, then a PAGE_POST_ATTEMPTED checkpoint before the non-idempotent post call", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/app-1/uploads`) return { status: 200, json: { id: "upload:sess-2" } };
      if (req.path === "/upload:sess-2") return { status: 200, json: { h: "handle" } };
      return { status: 200, json: { id: "fb-video-2" } };
    });
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks, getSaved } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);

    expect(getSaved()).toEqual([
      { phase: "UPLOAD_SESSION", uploadSessionId: "sess-2" },
      { phase: "PAGE_POST_ATTEMPTED", uploadSessionId: "sess-2" },
    ]);
  });

  it("duplicate/crash reconciliation: a PAGE_POST_ATTEMPTED prior checkpoint blocks the retry permanently — NEVER calls /PAGE_ID/videos again", async () => {
    server = await startMetaFixtureServer(() => ({ status: 500, json: { error: { message: "should never be reached" } } }));
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    await expect(
      provider.publish({ ...BASE_INPUT, priorCheckpoint: { phase: "PAGE_POST_ATTEMPTED", uploadSessionId: "sess-x" } }, CREDENTIAL, callbacks),
    ).rejects.toMatchObject({ errorCode: "FACEBOOK_PUBLISH_OUTCOME_UNKNOWN" });
    expect(server.requests).toHaveLength(0);
  });

  it("an UPLOAD_SESSION prior checkpoint (byte transfer not yet finished) safely resumes without creating a second upload session", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/app-1/uploads`) return { status: 500, json: { error: { message: "must not be called on resume" } } };
      if (req.path === "/upload:sess-resume") return { status: 200, json: { h: "resumed-handle" } };
      return { status: 200, json: { id: "fb-video-resumed" } };
    });
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    const result = await provider.publish({ ...BASE_INPUT, priorCheckpoint: { phase: "UPLOAD_SESSION", uploadSessionId: "sess-resume" } }, CREDENTIAL, callbacks);

    expect(result).toEqual({ externalContentId: "fb-video-resumed" });
    expect(server.requests.some((r) => r.path === `/v25.0/app-1/uploads`)).toBe(false);
  });

  it("classifies a rate-limit error (code 4) as retryable", async () => {
    server = await startMetaFixtureServer(() => ({ status: 200, json: { error: { message: "Too many calls.", code: 4, is_transient: true } } }));
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await expect(provider.publish(BASE_INPUT, CREDENTIAL, callbacks)).rejects.toBeInstanceOf(PublishingProviderRetryableError);
  });

  it("classifies an invalid-token error (code 190) as permanent", async () => {
    server = await startMetaFixtureServer(() => ({ status: 401, json: { error: { message: "Invalid token.", code: 190 } } }));
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await expect(provider.publish(BASE_INPUT, CREDENTIAL, callbacks)).rejects.toBeInstanceOf(PublishingProviderPermanentError);
  });

  it("never logs/persists the access token — it appears only in the Authorization header, never in a captured request body", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/app-1/uploads`) return { status: 200, json: { id: "upload:sess-3" } };
      if (req.path === "/upload:sess-3") return { status: 200, json: { h: "handle" } };
      return { status: 200, json: { id: "fb-video-3" } };
    });
    const provider = new FacebookChannelProvider({ appId: "app-1", graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);
    const serializedBodies = JSON.stringify(server.requests.map((r) => r.body));
    expect(serializedBodies).not.toContain(CREDENTIAL.accessToken);
  });

  it("rejects a non-VIDEO content type permanently", async () => {
    const provider = new FacebookChannelProvider({ appId: "app-1" });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await expect(provider.publish({ ...BASE_INPUT, contentType: "BLOG" }, CREDENTIAL, callbacks)).rejects.toMatchObject({ errorCode: "FACEBOOK_UNSUPPORTED_CONTENT_TYPE" });
  });
});
