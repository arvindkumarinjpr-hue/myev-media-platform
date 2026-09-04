import type { PublishingExecutionCallbacks, PublishingPublishInput } from "../publishing-provider.interface";
import { YouTubeChannelProvider } from "./youtube-channel-provider";
import { startYouTubeFixtureServer, type YouTubeFixtureResponse as FixtureResponse, type YouTubeFixtureServer } from "./youtube-test-fixture-server";

const CLIENT = { oauthClientId: "client-id", oauthClientSecret: "super-secret-client-secret" };
const CREDENTIAL = { accessToken: "super-secret-access-token", refreshToken: "super-secret-refresh-token" };
const VIDEO_BYTES = Buffer.alloc(10, 1);

function mediaReader() {
  return { headObject: async () => ({ sizeBytes: VIDEO_BYTES.length, contentType: "video/mp4" }), readRange: async () => VIDEO_BYTES };
}

describe("YouTubeChannelProvider — security (Part AF)", () => {
  let server: YouTubeFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("sends the access token only as a Bearer Authorization header, never as a query param or body field", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 200, json: { items: [{ id: "c1" }] } }));
    await new YouTubeChannelProvider({ ...CLIENT, apiBaseUrl: server.url }).validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    const req = server.requests[0];
    expect(req.headers.authorization).toBe(`Bearer ${CREDENTIAL.accessToken}`);
    expect(req.path).not.toContain(CREDENTIAL.accessToken);
    expect(JSON.stringify(req.body ?? {})).not.toContain(CREDENTIAL.accessToken);
  });

  it("never includes accessToken, refreshToken, or the OAuth client secret in a thrown error's message, for every failure classification", async () => {
    const scenarios: Array<() => FixtureResponse> = [
      () => ({ status: 400, json: { error: { message: "invalid" } } }),
      () => ({ status: 403, json: { error: { errors: [{ reason: "forbidden" }] } } }),
      () => ({ status: 500, json: {} }),
    ];
    for (const responder of scenarios) {
      server = await startYouTubeFixtureServer(responder);
      const input: PublishingPublishInput = { contentType: "VIDEO", metadata: { title: "T" }, artifact: { mediaAssetPublicId: "a1" }, operationToken: "publishing:t:attempt:0" };
      try {
        await new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url }).publish(input, CREDENTIAL, { saveCheckpoint: async () => {}, mediaReader: mediaReader() });
        throw new Error("expected publish() to throw");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(CREDENTIAL.accessToken);
        expect(message).not.toContain(CREDENTIAL.refreshToken);
        expect(message).not.toContain(CLIENT.oauthClientSecret);
      }
      await server.close();
      server = undefined;
    }
  });

  it("never includes the refresh token or client secret in the request body sent to Google's token endpoint's OWN error path being surfaced back (only sanitized reason codes reach the caller)", async () => {
    const tokenServer = await startYouTubeFixtureServer(() => ({ status: 400, json: { error: "invalid_grant", error_description: "token revoked" } }));
    server = await startYouTubeFixtureServer(() => ({ status: 401, json: { error: { message: "expired" } } }));
    const result = await new YouTubeChannelProvider({ ...CLIENT, apiBaseUrl: server.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: null,
    });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL.refreshToken);
    expect(JSON.stringify(result)).not.toContain(CLIENT.oauthClientSecret);
    await tokenServer.close();
  });

  it("checkpoint details saved via saveCheckpoint NEVER contain the access token, refresh token, or client secret — only the non-secret session URI/byte count", async () => {
    server = await startYouTubeFixtureServer((req): FixtureResponse => {
      if (req.path.startsWith("/videos?uploadType=resumable")) return { status: 200, headers: { Location: `${server!.url}/upload/session/s1` } };
      return { status: 201, json: { id: "vid1" } };
    });
    let savedDetail: Record<string, unknown> | undefined;
    const input: PublishingPublishInput = { contentType: "VIDEO", metadata: { title: "T" }, artifact: { mediaAssetPublicId: "a1" }, operationToken: "publishing:t:attempt:0" };
    const callbacks: PublishingExecutionCallbacks = {
      saveCheckpoint: async (detail) => {
        savedDetail = detail;
      },
      mediaReader: mediaReader(),
    };
    await new YouTubeChannelProvider({ ...CLIENT, uploadBaseUrl: server.url }).publish(input, CREDENTIAL, callbacks);

    expect(savedDetail).toBeDefined();
    const serialized = JSON.stringify(savedDetail);
    expect(serialized).not.toContain(CREDENTIAL.accessToken);
    expect(serialized).not.toContain(CREDENTIAL.refreshToken);
    expect(serialized).not.toContain(CLIENT.oauthClientSecret);
    expect(Object.keys(savedDetail!).sort()).toEqual(["totalBytes", "uploadSessionUri"]);
  });

  it("the credential reported to onCredentialRefreshed carries only the refreshed access token/scope (plus the unchanged refresh token) — never the OAuth client secret", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 200, json: { items: [{ id: "c1" }] } }));
    const tokenServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { access_token: "new-token", expires_in: 3600 } }));
    let reported: Record<string, unknown> | undefined;
    await new YouTubeChannelProvider({ ...CLIENT, apiBaseUrl: server.url, oauthTokenEndpoint: tokenServer.url }).validateConnection(
      { channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: new Date(Date.now() - 1000) },
      {
        saveCheckpoint: async () => {},
        onCredentialRefreshed: async (credential) => {
          reported = credential;
        },
      },
    );
    expect(JSON.stringify(reported)).not.toContain(CLIENT.oauthClientSecret);
    await tokenServer.close();
  });

  it("uses the fixed, real Google API/upload/OAuth hosts by default — a caller must explicitly opt into a different (test-only) host, it can never happen accidentally", () => {
    const provider = new YouTubeChannelProvider(CLIENT); // no apiBaseUrl/uploadBaseUrl/oauthTokenEndpoint override at all.
    // Constructing without overrides must not throw and must be usable —
    // the real assertion (the actual URLs used) is proven by the
    // dedicated "defaults to the real, fixed Google endpoints" test in
    // youtube-channel-provider.spec.ts; this test additionally confirms
    // the options object accepts zero test-only fields without any
    // special production/test flag needing to be set (unlike WordPress's
    // allowLocalTestTarget, there is no flag here to accidentally leave on).
    expect(provider.channelType).toBe("YOUTUBE");
  });
});
