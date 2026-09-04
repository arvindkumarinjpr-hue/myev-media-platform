import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import type { PublishingExecutionCallbacks, PublishingPublishInput } from "../publishing-provider.interface";
import { InstagramChannelProvider } from "./instagram-channel-provider";
import { startMetaFixtureServer, type MetaFixtureServer } from "./meta-test-fixture-server";

const CREDENTIAL = { accessToken: "fixture-ig-token", igUserId: "ig-user-1" };
const VIDEO_BYTES = Buffer.alloc(20, 3);

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
  metadata: { caption: "A great reel caption." },
  artifact: { mediaAssetPublicId: "asset-1" },
  operationToken: "publishing:target-1:attempt:0",
};

describe("InstagramChannelProvider", () => {
  let server: MetaFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reports truthful capabilities — VIDEO only, no privacy concept, caption supported", () => {
    const provider = new InstagramChannelProvider();
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

  it("validateConnection succeeds for a BUSINESS professional account", async () => {
    server = await startMetaFixtureServer(() => ({ status: 200, json: { id: CREDENTIAL.igUserId, account_type: "BUSINESS" } }));
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url });
    const result = await provider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result).toEqual({ healthy: true });
  });

  it("validateConnection rejects a non-professional (personal) account — 'do not assume ordinary personal accounts are publishable'", async () => {
    server = await startMetaFixtureServer(() => ({ status: 200, json: { id: CREDENTIAL.igUserId, account_type: "PERSONAL" } }));
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url });
    const result = await provider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
  });

  it("validateConnection reports CREDENTIAL_REVOKED on an invalid/expired token", async () => {
    server = await startMetaFixtureServer(() => ({ status: 401, json: { error: { message: "Invalid token.", code: 190 } } }));
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url });
    const result = await provider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.reasonCode).toBe("CREDENTIAL_REVOKED");
  });

  it("publishes a Reel end to end: container create -> upload -> poll FINISHED -> media_publish -> permalink follow-up read, with caption pass-through", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media`) return { status: 200, json: { id: "container-1" } };
      if (req.path === "/ig-api-upload/container-1") return { status: 200, json: { success: true } };
      if (req.path === "/v25.0/container-1?fields=status_code") return { status: 200, json: { status_code: "FINISHED" } };
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media_publish`) return { status: 200, json: { id: "ig-media-1" } };
      if (req.path === "/v25.0/ig-media-1?fields=permalink") return { status: 200, json: { permalink: "https://www.instagram.com/reel/abc123/" } };
      return { status: 500, json: {} };
    });
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    const result = await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);

    expect(result).toEqual({ externalContentId: "ig-media-1", externalUrl: "https://www.instagram.com/reel/abc123/" });
    const containerReq = server.requests.find((r) => r.path === `/v25.0/${CREDENTIAL.igUserId}/media`)!;
    expect((containerReq.body as Record<string, unknown>).media_type).toBe("REELS");
    expect((containerReq.body as Record<string, unknown>).caption).toBe("A great reel caption.");
  });

  it("saves a checkpoint with the container id BEFORE uploading any bytes", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media`) return { status: 200, json: { id: "container-2" } };
      if (req.path === "/v25.0/container-2?fields=status_code") return { status: 200, json: { status_code: "FINISHED" } };
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media_publish`) return { status: 200, json: { id: "ig-media-2" } };
      return { status: 200, json: { success: true } };
    });
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks, getSaved } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);
    expect(getSaved()).toEqual([{ containerId: "container-2" }]);
  });

  it("async processing: still IN_PROGRESS after local bounded polling throws retryable WITHOUT creating a second container", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media`) return { status: 200, json: { id: "container-3" } };
      if (req.path === "/v25.0/container-3?fields=status_code") return { status: 200, json: { status_code: "IN_PROGRESS" } };
      return { status: 200, json: { success: true } };
    });
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    await expect(provider.publish(BASE_INPUT, CREDENTIAL, callbacks)).rejects.toBeInstanceOf(PublishingProviderRetryableError);
    expect(server.requests.filter((r) => r.path === `/v25.0/${CREDENTIAL.igUserId}/media`)).toHaveLength(1);
  }, 30_000);

  it("resuming via a prior checkpoint (containerId) polls the SAME container rather than creating a new one", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media`) return { status: 500, json: { error: { message: "must not be called on resume" } } };
      if (req.path === "/v25.0/container-resume?fields=status_code") return { status: 200, json: { status_code: "FINISHED" } };
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media_publish`) return { status: 200, json: { id: "ig-media-resumed" } };
      return { status: 200, json: {} };
    });
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    const result = await provider.publish({ ...BASE_INPUT, priorCheckpoint: { containerId: "container-resume" } }, CREDENTIAL, callbacks);

    expect(result.externalContentId).toBe("ig-media-resumed");
    expect(server.requests.some((r) => r.path === `/v25.0/${CREDENTIAL.igUserId}/media`)).toBe(false);
  });

  it("permanent processing failure: ERROR status_code throws permanent", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media`) return { status: 200, json: { id: "container-4" } };
      if (req.path === "/v25.0/container-4?fields=status_code") return { status: 200, json: { status_code: "ERROR" } };
      return { status: 200, json: { success: true } };
    });
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await expect(provider.publish(BASE_INPUT, CREDENTIAL, callbacks)).rejects.toMatchObject({ errorCode: "INSTAGRAM_MEDIA_PROCESSING_FAILED" });
  });

  it("duplicate/crash reconciliation: PUBLISHED status_code on a resumed checkpoint never calls media_publish again, fails permanently as unrecoverable rather than fabricating an id", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === "/v25.0/container-published?fields=status_code") return { status: 200, json: { status_code: "PUBLISHED" } };
      return { status: 500, json: { error: { message: "must not be called — would create a duplicate reel" } } };
    });
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    await expect(
      provider.publish({ ...BASE_INPUT, priorCheckpoint: { containerId: "container-published" } }, CREDENTIAL, callbacks),
    ).rejects.toMatchObject({ errorCode: "INSTAGRAM_PUBLISHED_ID_UNRECOVERABLE" });
    expect(server.requests.some((r) => r.path.includes("media_publish"))).toBe(false);
  });

  it("an EXPIRED container (never published) is safe to replace with a fresh container", async () => {
    let mediaCallCount = 0;
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media`) {
        mediaCallCount += 1;
        return { status: 200, json: { id: "container-fresh" } };
      }
      if (req.path === "/v25.0/container-expired?fields=status_code") return { status: 200, json: { status_code: "EXPIRED" } };
      if (req.path === "/v25.0/container-fresh?fields=status_code") return { status: 200, json: { status_code: "FINISHED" } };
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media_publish`) return { status: 200, json: { id: "ig-media-fresh" } };
      return { status: 200, json: { success: true } };
    });
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));

    const result = await provider.publish({ ...BASE_INPUT, priorCheckpoint: { containerId: "container-expired" } }, CREDENTIAL, callbacks);

    expect(result.externalContentId).toBe("ig-media-fresh");
    expect(mediaCallCount).toBe(1);
  });

  it("classifies a rate-limit error as retryable and an invalid-token error as permanent", async () => {
    server = await startMetaFixtureServer(() => ({ status: 200, json: { error: { message: "rate limited", code: 4, is_transient: true } } }));
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks: rateCallbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await expect(provider.publish(BASE_INPUT, CREDENTIAL, rateCallbacks)).rejects.toBeInstanceOf(PublishingProviderRetryableError);
  });

  it("never logs/persists the access token in any captured request body", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media`) return { status: 200, json: { id: "container-5" } };
      if (req.path === "/v25.0/container-5?fields=status_code") return { status: 200, json: { status_code: "FINISHED" } };
      if (req.path === `/v25.0/${CREDENTIAL.igUserId}/media_publish`) return { status: 200, json: { id: "ig-media-5" } };
      return { status: 200, json: { success: true } };
    });
    const provider = new InstagramChannelProvider({ graphBaseUrl: server.url, uploadBaseUrl: server.url });
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await provider.publish(BASE_INPUT, CREDENTIAL, callbacks);
    const serializedBodies = JSON.stringify(server.requests.map((r) => r.body));
    expect(serializedBodies).not.toContain(CREDENTIAL.accessToken);
  });

  it("rejects a missing igUserId credential permanently before any network call", async () => {
    const provider = new InstagramChannelProvider();
    const { callbacks } = callbacksWithCheckpoint(mediaReaderFor(VIDEO_BYTES));
    await expect(provider.publish(BASE_INPUT, { accessToken: "x" }, callbacks)).rejects.toBeInstanceOf(PublishingProviderPermanentError);
  });
});
