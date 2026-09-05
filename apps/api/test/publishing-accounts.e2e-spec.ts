import {
  PublishingProviderRegistryBuilder,
  WordPressChannelProvider,
  startMetaFixtureServer,
  startWordPressFixtureServer,
  startYouTubeFixtureServer,
  type MetaFixtureServer,
  type WordPressFixtureServer,
  type YouTubeFixtureServer,
} from "@myev/shared";
import { bootstrapE2eApp, createWorkspaceAsOwner, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/modules/publishing/publishing-provider-registry.factory";

/**
 * Module 9 Phase 9.7 — real end-to-end coverage for account management:
 * WordPress connect/rotate/test-connection/disconnect, and the full
 * YouTube + Meta OAuth connect flows (start -> state -> callback ->
 * discovery -> finalize) against local deterministic fixture servers —
 * no real Google/Meta dependency, mirroring Phase 9.5/9.6's own
 * established fixture-server precedent.
 */
describe("Publishing accounts (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;
  let ws: { publicId: string };
  let wordpressFixture: WordPressFixtureServer;
  let youtubeFixture: YouTubeFixtureServer;
  let metaFixture: MetaFixtureServer;

  beforeAll(async () => {
    wordpressFixture = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json")) return { status: 200, json: { id: 1, name: "Fixture Author" } };
      return { status: 500, json: {} };
    });

    youtubeFixture = await startYouTubeFixtureServer((req) => {
      if (req.path === "/") return { status: 200, json: { access_token: "yt-access-1", refresh_token: "yt-refresh-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.upload" } };
      if (req.path.startsWith("/channels")) return { status: 200, json: { items: [{ id: "UCfixture1", snippet: { title: "Fixture YouTube Channel" } }] } };
      return { status: 500, json: {} };
    });

    metaFixture = await startMetaFixtureServer((req) => {
      if (req.path.startsWith("/v25.0/oauth/access_token") && req.path.includes("fb_exchange_token")) return { status: 200, json: { access_token: "meta-long-lived-1", expires_in: 5184000 } };
      if (req.path.startsWith("/v25.0/oauth/access_token")) return { status: 200, json: { access_token: "meta-short-lived-1", expires_in: 5400 } };
      if (req.path.startsWith("/v25.0/me/accounts")) {
        return { status: 200, json: { data: [{ id: "fb-page-fixture-1", name: "Fixture Page", access_token: "page-token-1", instagram_business_account: { id: "ig-fixture-1" } }] } };
      }
      if (req.path.startsWith("/v25.0/ig-fixture-1")) return { status: 200, json: { id: "ig-fixture-1", username: "fixturebrand", account_type: "BUSINESS" } };
      return { status: 500, json: {} };
    });

    process.env.YOUTUBE_OAUTH_CLIENT_ID = "e2e-test-client-id";
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET = "e2e-test-client-secret";
    process.env.YOUTUBE_OAUTH_REDIRECT_URI = "http://localhost:4000/api/v1/publishing/oauth/youtube/callback";
    process.env.YOUTUBE_OAUTH_TOKEN_ENDPOINT_OVERRIDE = youtubeFixture.url;
    process.env.YOUTUBE_OAUTH_AUTHORIZATION_ENDPOINT_OVERRIDE = youtubeFixture.url;
    process.env.YOUTUBE_OAUTH_API_BASE_URL_OVERRIDE = youtubeFixture.url;
    process.env.META_APP_ID = "e2e-test-app-id";
    process.env.META_APP_SECRET = "e2e-test-app-secret";
    process.env.META_OAUTH_REDIRECT_URI = "http://localhost:4000/api/v1/publishing/oauth/meta/callback";
    process.env.META_OAUTH_DIALOG_BASE_URL_OVERRIDE = metaFixture.url;
    process.env.META_OAUTH_GRAPH_BASE_URL_OVERRIDE = metaFixture.url;

    ctx = await bootstrapE2eApp((builder) =>
      builder.overrideProvider(PUBLISHING_PROVIDER_REGISTRY).useFactory({
        factory: () => {
          const b = new PublishingProviderRegistryBuilder();
          // allowLocalTestTarget: true — the ONLY way a local 127.0.0.1
          // fixture server can pass the real DNS-rebinding-safe SSRF
          // boundary (Phase 9.4's own frozen, unmodified transport).
          b.register(new WordPressChannelProvider({ allowLocalTestTarget: true }));
          return b.freeze();
        },
      }),
    );
    ownerToken = (await loginAsPlatformOwner(ctx)).accessToken;
    ws = await createWorkspaceAsOwner(ctx, ownerToken);
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
    await wordpressFixture.close();
    await youtubeFixture.close();
    await metaFixture.close();
    delete process.env.YOUTUBE_OAUTH_CLIENT_ID;
    delete process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
    delete process.env.YOUTUBE_OAUTH_REDIRECT_URI;
    delete process.env.YOUTUBE_OAUTH_TOKEN_ENDPOINT_OVERRIDE;
    delete process.env.YOUTUBE_OAUTH_AUTHORIZATION_ENDPOINT_OVERRIDE;
    delete process.env.YOUTUBE_OAUTH_API_BASE_URL_OVERRIDE;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    delete process.env.META_OAUTH_REDIRECT_URI;
    delete process.env.META_OAUTH_DIALOG_BASE_URL_OVERRIDE;
    delete process.env.META_OAUTH_GRAPH_BASE_URL_OVERRIDE;
  });

  const server = () => ctx.app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${ownerToken}`, "X-Workspace-Id": ws.publicId });
  const base = () => `/api/v1/workspaces/${ws.publicId}/publishing`;

  it("lists zero accounts initially", async () => {
    const res = await request(server()).get(`${base()}/accounts`).set(auth()).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it("rejects an unreachable WordPress site with a validation error and creates no account/credential row", async () => {
    await request(server())
      .post(`${base()}/accounts/wordpress`)
      .set(auth())
      .send({ siteUrl: "http://127.0.0.1:1", username: "u", applicationPassword: "p", displayName: "Broken Site" })
      .expect(422);
    const res = await request(server()).get(`${base()}/accounts`).set(auth()).expect(200);
    expect(res.body.data).toEqual([]);
  });

  let wordpressAccountId: string;

  it("connects a real WordPress site (validated first, then encrypted+persisted), never echoing applicationPassword back", async () => {
    const res = await request(server())
      .post(`${base()}/accounts/wordpress`)
      .set(auth())
      .send({ siteUrl: wordpressFixture.url, username: "fixture-user", applicationPassword: "fixture-app-password-xyz", displayName: "My Fixture Blog" })
      .expect(201);
    expect(res.body.data.channelType).toBe("WORDPRESS");
    expect(res.body.data.connectionStatus).toBe("CONNECTED");
    expect(res.body.data.externalAccountId).toBe(wordpressFixture.url);
    expect(JSON.stringify(res.body.data)).not.toContain("fixture-app-password-xyz");
    expect(res.body.data).not.toHaveProperty("ciphertext");
    wordpressAccountId = res.body.data.publicId;
  });

  it("rejects connecting the exact same WordPress site twice", async () => {
    await request(server())
      .post(`${base()}/accounts/wordpress`)
      .set(auth())
      .send({ siteUrl: wordpressFixture.url, username: "fixture-user", applicationPassword: "fixture-app-password-xyz", displayName: "Duplicate" })
      .expect(409);
  });

  it("test-connection re-validates and reports healthy without exposing raw provider details", async () => {
    const res = await request(server()).post(`${base()}/accounts/${wordpressAccountId}/test-connection`).set(auth()).expect(200);
    expect(res.body.data.connectionStatus).toBe("CONNECTED");
  });

  it("rotates the WordPress credential after re-validating it", async () => {
    const res = await request(server())
      .put(`${base()}/accounts/${wordpressAccountId}/wordpress/credential`)
      .set(auth())
      .send({ siteUrl: wordpressFixture.url, username: "rotated-user", applicationPassword: "rotated-password-123" })
      .expect(200);
    expect(res.body.data.connectionStatus).toBe("CONNECTED");
    expect(JSON.stringify(res.body.data)).not.toContain("rotated-password-123");
  });

  it("disconnect marks the account REVOKED without deleting it", async () => {
    const res = await request(server()).delete(`${base()}/accounts/${wordpressAccountId}`).set(auth()).expect(200);
    expect(res.body.data.connectionStatus).toBe("REVOKED");
    const detail = await request(server()).get(`${base()}/accounts/${wordpressAccountId}`).set(auth()).expect(200);
    expect(detail.body.data.connectionStatus).toBe("REVOKED");
  });

  it("YouTube OAuth start returns a real authorization URL bound to this workspace via opaque state", async () => {
    const res = await request(server()).get(`${base()}/oauth/youtube/start`).set(auth()).expect(200);
    const url = new URL(res.body.data.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("e2e-test-client-id");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("YouTube callback with a bogus state redirects to the frontend error page, never crashes, never creates an account", async () => {
    const res = await request(server()).get("/api/v1/publishing/oauth/youtube/callback").query({ code: "fake-code", state: "totally-bogus-state-value" }).expect(302);
    expect(res.headers.location).toContain("/publishing/oauth-error");
  });

  it("completes a real YouTube OAuth connect end to end: start -> real state -> real callback -> encrypted credential persisted, tokens never exposed", async () => {
    const startRes = await request(server()).get(`${base()}/oauth/youtube/start`).set(auth()).expect(200);
    const state = new URL(startRes.body.data.authorizationUrl).searchParams.get("state")!;

    const callbackRes = await request(server()).get("/api/v1/publishing/oauth/youtube/callback").query({ code: "real-fixture-code", state }).expect(302);
    expect(callbackRes.headers.location).toContain(`/workspaces/${ws.publicId}/publishing/accounts?connected=youtube`);

    const accountsRes = await request(server()).get(`${base()}/accounts`).set(auth()).expect(200);
    const ytAccount = accountsRes.body.data.find((a: { channelType: string }) => a.channelType === "YOUTUBE");
    expect(ytAccount).toBeDefined();
    expect(ytAccount.displayName).toBe("Fixture YouTube Channel");
    expect(ytAccount.externalAccountId).toBe("UCfixture1");
    expect(JSON.stringify(ytAccount)).not.toContain("yt-access-1");
    expect(JSON.stringify(ytAccount)).not.toContain("yt-refresh-1");
  });

  it("the SAME OAuth state cannot be replayed — a second callback with the identical state is rejected", async () => {
    const startRes = await request(server()).get(`${base()}/oauth/youtube/start`).set(auth()).expect(200);
    const state = new URL(startRes.body.data.authorizationUrl).searchParams.get("state")!;

    await request(server()).get("/api/v1/publishing/oauth/youtube/callback").query({ code: "real-fixture-code", state }).expect(302); // first use — succeeds (reconnects the same channel)
    const replay = await request(server()).get("/api/v1/publishing/oauth/youtube/callback").query({ code: "real-fixture-code", state }).expect(302);
    expect(replay.headers.location).toContain("/publishing/oauth-error");
  });

  it("Meta OAuth: start -> callback discovers Pages -> finalize creates BOTH Facebook and Instagram accounts from operator selection", async () => {
    const startRes = await request(server()).get(`${base()}/oauth/meta/start`).set(auth()).expect(200);
    const state = new URL(startRes.body.data.authorizationUrl).searchParams.get("state")!;

    const callbackRes = await request(server()).get("/api/v1/publishing/oauth/meta/callback").query({ code: "real-meta-code", state }).expect(302);
    const redirectUrl = new URL(callbackRes.headers.location);
    expect(redirectUrl.pathname).toBe(`/workspaces/${ws.publicId}/publishing/accounts/connect/meta`);
    const discoveryToken = redirectUrl.searchParams.get("discoveryToken")!;
    expect(discoveryToken).toBeTruthy();

    const discoveryRes = await request(server()).get(`${base()}/oauth/meta/discovery`).query({ discoveryToken }).set(auth()).expect(200);
    expect(discoveryRes.body.data).toEqual([
      { pageId: "fb-page-fixture-1", pageName: "Fixture Page", instagramBusinessAccountId: "ig-fixture-1", instagramUsername: "fixturebrand", instagramAccountType: "BUSINESS", instagramEligible: true },
    ]);
    expect(JSON.stringify(discoveryRes.body.data)).not.toContain("page-token-1");

    const finalizeRes = await request(server())
      .post(`${base()}/oauth/meta/finalize`)
      .set(auth())
      .send({ discoveryToken, selections: [{ pageId: "fb-page-fixture-1", connectFacebook: true, connectInstagram: true }] })
      .expect(201);
    expect(finalizeRes.body.data).toHaveLength(2);
    const channelTypes = finalizeRes.body.data.map((a: { channelType: string }) => a.channelType).sort();
    expect(channelTypes).toEqual(["FACEBOOK", "INSTAGRAM"]);
    const igAccount = finalizeRes.body.data.find((a: { channelType: string }) => a.channelType === "INSTAGRAM");
    expect(igAccount.displayName).toBe("@fixturebrand");
    expect(JSON.stringify(finalizeRes.body.data)).not.toContain("page-token-1");
  });

  it("YouTube OAuth start is rejected as not-configured when the platform client id is unset", async () => {
    const original = process.env.YOUTUBE_OAUTH_CLIENT_ID;
    delete process.env.YOUTUBE_OAUTH_CLIENT_ID;
    try {
      // A fresh app instance is needed since ConfigService reads env once at bootstrap — reuse ctx's own registry override.
      const unconfiguredCtx = await bootstrapE2eApp((builder) =>
        builder.overrideProvider(PUBLISHING_PROVIDER_REGISTRY).useFactory({ factory: () => new PublishingProviderRegistryBuilder().freeze() }),
      );
      try {
        const token = (await loginAsPlatformOwner(unconfiguredCtx)).accessToken;
        const unconfiguredWs = await createWorkspaceAsOwner(unconfiguredCtx, token);
        await request(unconfiguredCtx.app.getHttpServer())
          .get(`/api/v1/workspaces/${unconfiguredWs.publicId}/publishing/oauth/youtube/start`)
          .set({ Authorization: `Bearer ${token}`, "X-Workspace-Id": unconfiguredWs.publicId })
          .expect(422);
      } finally {
        await teardownE2eApp(unconfiguredCtx);
      }
    } finally {
      process.env.YOUTUBE_OAUTH_CLIENT_ID = original;
    }
  });
});
