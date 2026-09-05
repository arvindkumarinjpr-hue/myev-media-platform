import {
  buildMetaAuthorizationUrl,
  exchangeForLongLivedMetaToken,
  exchangeMetaAuthorizationCode,
  fetchInstagramAccountIdentity,
  fetchManageablePages,
  MetaOAuthError,
} from "./meta-oauth-client";
import { startMetaFixtureServer, type MetaFixtureServer } from "./meta-test-fixture-server";

const CLIENT = { appId: "app-1", appSecret: "secret-1" };

describe("buildMetaAuthorizationUrl", () => {
  it("builds the versioned Facebook dialog URL with the requested scopes and opaque state", () => {
    const url = buildMetaAuthorizationUrl(CLIENT, { redirectUri: "https://app.example/callback/meta", state: "opaque-state-1" });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v25.0/dialog/oauth");
    expect(parsed.searchParams.get("client_id")).toBe("app-1");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example/callback/meta");
    expect(parsed.searchParams.get("state")).toBe("opaque-state-1");
    expect(parsed.searchParams.get("scope")).toContain("pages_manage_posts");
    expect(parsed.searchParams.get("scope")).toContain("instagram_content_publish");
  });
});

describe("Meta OAuth token exchange + account discovery", () => {
  let server: MetaFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("exchanges a real authorization code for a short-lived user token", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path.startsWith("/v25.0/oauth/access_token") && req.body === undefined) return { status: 200, json: { access_token: "short-lived-1", token_type: "bearer", expires_in: 5400 } };
      return { status: 500, json: {} };
    });
    const result = await exchangeMetaAuthorizationCode("auth-code-1", "https://app.example/callback/meta", { ...CLIENT, graphBaseUrl: server.url });
    expect(result.accessToken).toBe("short-lived-1");
    expect(result.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    const req = server.requests[0];
    expect(req.path).toContain("client_id=app-1");
    expect(req.path).toContain("client_secret=secret-1");
    expect(req.path).toContain("code=auth-code-1");
  });

  it("exchanges a short-lived token for a long-lived one via fb_exchange_token", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path.includes("grant_type=fb_exchange_token")) return { status: 200, json: { access_token: "long-lived-1", expires_in: 5184000 } };
      return { status: 500, json: {} };
    });
    const result = await exchangeForLongLivedMetaToken("short-lived-1", { ...CLIENT, graphBaseUrl: server.url });
    expect(result.accessToken).toBe("long-lived-1");
    const req = server.requests[0];
    expect(req.path).toContain("fb_exchange_token=short-lived-1");
  });

  it("classifies an OAuthException/400 as EXCHANGE_INVALID_GRANT", async () => {
    server = await startMetaFixtureServer(() => ({ status: 400, json: { error: { message: "bad code", type: "OAuthException" } } }));
    await expect(exchangeMetaAuthorizationCode("bad-code", "https://app.example/callback/meta", { ...CLIENT, graphBaseUrl: server.url })).rejects.toMatchObject({
      reasonCode: "EXCHANGE_INVALID_GRANT",
    });
  });

  it("never includes the app secret in a thrown error message", async () => {
    server = await startMetaFixtureServer(() => ({ status: 500, json: { error: { message: "server error" } } }));
    try {
      await exchangeMetaAuthorizationCode("code-1", "https://app.example/callback/meta", { ...CLIENT, graphBaseUrl: server.url });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as Error).message).not.toContain(CLIENT.appSecret);
    }
  });

  it("fetchManageablePages returns real Page identity, its own access token, and the linked Instagram account id where present", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path.startsWith("/v25.0/me/accounts")) {
        return {
          status: 200,
          json: {
            data: [
              { id: "page-1", name: "Real Page One", access_token: "page-token-1", instagram_business_account: { id: "ig-1" } },
              { id: "page-2", name: "Real Page Two (no IG)", access_token: "page-token-2" },
            ],
          },
        };
      }
      return { status: 500, json: {} };
    });
    const pages = await fetchManageablePages("user-token-1", { ...CLIENT, graphBaseUrl: server.url });
    expect(pages).toEqual([
      { pageId: "page-1", name: "Real Page One", pageAccessToken: "page-token-1", instagramBusinessAccountId: "ig-1" },
      { pageId: "page-2", name: "Real Page Two (no IG)", pageAccessToken: "page-token-2", instagramBusinessAccountId: undefined },
    ]);
    expect(server.requests[0].headers.authorization).toBe("Bearer user-token-1");
  });

  it("fetchManageablePages fails safely (DISCOVERY_FAILED) rather than fabricating a Page list on error", async () => {
    server = await startMetaFixtureServer(() => ({ status: 401, json: { error: { message: "invalid token" } } }));
    await expect(fetchManageablePages("bad-token", { ...CLIENT, graphBaseUrl: server.url })).rejects.toBeInstanceOf(MetaOAuthError);
  });

  it("fetchInstagramAccountIdentity returns the real account type so a personal account can be filtered out before selection", async () => {
    server = await startMetaFixtureServer((req) => {
      if (req.path.startsWith("/v25.0/ig-1")) return { status: 200, json: { id: "ig-1", username: "realbrand", account_type: "BUSINESS" } };
      return { status: 500, json: {} };
    });
    const identity = await fetchInstagramAccountIdentity("ig-1", "page-token-1", { ...CLIENT, graphBaseUrl: server.url });
    expect(identity).toEqual({ igUserId: "ig-1", username: "realbrand", accountType: "BUSINESS" });
  });
});
