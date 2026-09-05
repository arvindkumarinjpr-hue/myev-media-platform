import { buildYouTubeAuthorizationUrl, exchangeYouTubeAuthorizationCode, fetchYouTubeChannelIdentity, YouTubeOAuthExchangeError, YouTubeIdentityLookupError } from "./youtube-oauth-client";
import { startYouTubeFixtureServer, type YouTubeFixtureServer } from "./youtube-test-fixture-server";

const CLIENT = { clientId: "client-1", clientSecret: "secret-1" };

describe("buildYouTubeAuthorizationUrl", () => {
  it("includes access_type=offline and prompt=consent so a refresh token is always granted", () => {
    const url = buildYouTubeAuthorizationUrl(CLIENT, { redirectUri: "https://app.example/callback", state: "opaque-state-1" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("client_id")).toBe("client-1");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
    expect(parsed.searchParams.get("state")).toBe("opaque-state-1");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.upload");
  });
});

describe("exchangeYouTubeAuthorizationCode / fetchYouTubeChannelIdentity", () => {
  let server: YouTubeFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("exchanges a real authorization code for access+refresh tokens", async () => {
    server = await startYouTubeFixtureServer((req) => {
      if (req.path === "/") return { status: 200, json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.upload" } };
      return { status: 500, json: {} };
    });
    const result = await exchangeYouTubeAuthorizationCode("auth-code-1", "https://app.example/callback", { ...CLIENT, tokenEndpoint: server.url });
    expect(result.accessToken).toBe("at-1");
    expect(result.refreshToken).toBe("rt-1");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const req = server.requests[0];
    const bodyText = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body);
    expect(bodyText).toBe("client_id=client-1&client_secret=secret-1&code=auth-code-1&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&grant_type=authorization_code");
  });

  it("classifies invalid_grant as EXCHANGE_INVALID_GRANT (permanent — the code is already used/expired)", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 400, json: { error: "invalid_grant" } }));
    await expect(exchangeYouTubeAuthorizationCode("bad-code", "https://app.example/callback", { ...CLIENT, tokenEndpoint: server.url })).rejects.toMatchObject({
      reasonCode: "EXCHANGE_INVALID_GRANT",
    });
  });

  it("fails safely with EXCHANGE_MALFORMED_RESPONSE when refresh_token is missing (consent screen was skipped)", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 200, json: { access_token: "at-1", expires_in: 3600 } }));
    await expect(exchangeYouTubeAuthorizationCode("code-1", "https://app.example/callback", { ...CLIENT, tokenEndpoint: server.url })).rejects.toBeInstanceOf(YouTubeOAuthExchangeError);
  });

  it("never includes the client secret or the exchanged tokens in a thrown error message", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 500, json: { error: "server_error" } }));
    try {
      await exchangeYouTubeAuthorizationCode("code-1", "https://app.example/callback", { ...CLIENT, tokenEndpoint: server.url });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as Error).message).not.toContain(CLIENT.clientSecret);
    }
  });

  it("fetchYouTubeChannelIdentity returns the real connected channel's id and title", async () => {
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/channels")) return { status: 200, json: { items: [{ id: "UCreal123", snippet: { title: "Real Channel Title" } }] } };
      return { status: 500, json: {} };
    });
    const identity = await fetchYouTubeChannelIdentity("access-token-1", { apiBaseUrl: server.url });
    expect(identity).toEqual({ channelId: "UCreal123", title: "Real Channel Title" });
  });

  it("fetchYouTubeChannelIdentity fails safely when no channel is returned, never fabricating an identity", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 200, json: { items: [] } }));
    await expect(fetchYouTubeChannelIdentity("access-token-1", { apiBaseUrl: server.url })).rejects.toBeInstanceOf(YouTubeIdentityLookupError);
  });
});
