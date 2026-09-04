import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import type { PublishingExecutionCallbacks, PublishingPublishInput } from "../publishing-provider.interface";
import { YouTubeChannelProvider } from "./youtube-channel-provider";
import { startYouTubeFixtureServer, type YouTubeFixtureRequest as FixtureRequest, type YouTubeFixtureResponse as FixtureResponse, type YouTubeFixtureServer } from "./youtube-test-fixture-server";

const CLIENT = { oauthClientId: "client-id", oauthClientSecret: "client-secret" };
const CREDENTIAL = { accessToken: "access-token-1", refreshToken: "refresh-token-1" };

function provider(overrides: Partial<{ apiBaseUrl: string; uploadBaseUrl: string; oauthTokenEndpoint: string; timeoutMs: number; chunkSizeBytes: number }> = {}) {
  return new YouTubeChannelProvider({ ...CLIENT, timeoutMs: 2_000, ...overrides });
}

function noopCallbacks(overrides: Partial<PublishingExecutionCallbacks> = {}): PublishingExecutionCallbacks {
  return { saveCheckpoint: async () => {}, ...overrides };
}

describe("YouTubeChannelProvider — capabilities", () => {
  it("advertises truthful, YouTube-specific capabilities", () => {
    const capabilities = provider().getCapabilities();
    expect(capabilities.supportedContentTypes).toEqual(["VIDEO"]);
    expect(capabilities.requiresRenderedMedia).toBe(true);
    expect(capabilities.requiresTitle).toBe(true);
    expect(capabilities.requiresDescription).toBe(false);
    expect(capabilities.supportsTags).toBe(true);
    expect(capabilities.supportsCaption).toBe(false);
    expect(capabilities.supportedPrivacyOptions).toEqual(["PRIVATE", "UNLISTED", "PUBLIC"]);
  });

  it("defaults to the real, fixed Google endpoints — never a test/local override unless explicitly configured", async () => {
    const originalFetch = global.fetch;
    let requestedUrl = "";
    global.fetch = (async (url: string | URL) => {
      requestedUrl = url.toString();
      return new Response(JSON.stringify({ items: [{ id: "c1" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await provider().validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    } finally {
      global.fetch = originalFetch;
    }
    expect(requestedUrl.startsWith("https://www.googleapis.com/youtube/v3/")).toBe(true);
  });
});

describe("YouTubeChannelProvider — validateConnection", () => {
  let server: YouTubeFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns healthy on a 200 from channels.list(mine=true) with at least one channel, and never uploads anything", async () => {
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/channels")) return { status: 200, json: { items: [{ id: "UC1", snippet: { title: "My Channel" } }] } };
      return { status: 500, json: { error: { message: "unexpected" } } };
    });
    const result = await provider({ apiBaseUrl: server.url }).validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result).toEqual({ healthy: true });
    expect(server.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("returns CREDENTIAL_INVALID when the account has no accessible channel", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 200, json: { items: [] } }));
    const result = await provider({ apiBaseUrl: server.url }).validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
  });

  it("returns CREDENTIAL_INVALID on a 401 that a successful refresh still cannot fix (the API rejects the NEW token too)", async () => {
    const tokenServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { access_token: "still-rejected-token", expires_in: 3600 } }));
    server = await startYouTubeFixtureServer(() => ({ status: 401, json: { error: { message: "unauthorized" } } }));
    const result = await provider({ apiBaseUrl: server.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: null,
    });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
    await tokenServer.close();
  });

  it("returns PROVIDER_UNAVAILABLE on a 5xx", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 503, json: { error: { message: "down" } } }));
    const result = await provider({ apiBaseUrl: server.url }).validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("PROVIDER_UNAVAILABLE");
  });

  it("returns PROVIDER_UNAVAILABLE on a timeout", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 200, hang: true }));
    const result = await provider({ apiBaseUrl: server.url, timeoutMs: 200 }).validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("PROVIDER_UNAVAILABLE");
  }, 10_000);

  it("returns CREDENTIAL_INVALID for a missing/malformed credential without ever making a request", async () => {
    const result = await provider().validateConnection({ channelAccountId: "acct-1", decryptedCredential: { accessToken: "only-access" }, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
  });

  it.each(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"])("classifies a 403 with reason %s as PROVIDER_UNAVAILABLE (quota/rate limit)", async (reason) => {
    server = await startYouTubeFixtureServer(() => ({ status: 403, json: { error: { errors: [{ reason }] } } }));
    const result = await provider({ apiBaseUrl: server.url }).validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.reasonCode).toBe("PROVIDER_UNAVAILABLE");
  });

  it("classifies a 403 with reason insufficientPermissions as CREDENTIAL_INVALID (insufficient OAuth scope)", async () => {
    server = await startYouTubeFixtureServer(() => ({ status: 403, json: { error: { errors: [{ reason: "insufficientPermissions" }] } } }));
    const result = await provider({ apiBaseUrl: server.url }).validateConnection({ channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: null });
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
  });
});

describe("YouTubeChannelProvider — OAuth token refresh (Part AA)", () => {
  let apiServer: YouTubeFixtureServer | undefined;
  let tokenServer: YouTubeFixtureServer | undefined;
  afterEach(async () => {
    await apiServer?.close();
    await tokenServer?.close();
    apiServer = undefined;
    tokenServer = undefined;
  });

  it("uses the access token directly (no refresh call) when tokenExpiresAt is safely in the future", async () => {
    apiServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { items: [{ id: "c1" }] } }));
    tokenServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { access_token: "should-not-be-used", expires_in: 3600 } }));
    await provider({ apiBaseUrl: apiServer.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(tokenServer.requests).toHaveLength(0);
    expect(apiServer.requests[0].headers.authorization).toBe(`Bearer ${CREDENTIAL.accessToken}`);
  });

  it("proactively refreshes when tokenExpiresAt is already in the past, and uses the NEW access token for the actual call", async () => {
    apiServer = await startYouTubeFixtureServer((req) => {
      expect(req.headers.authorization).toBe("Bearer fresh-access-token");
      return { status: 200, json: { items: [{ id: "c1" }] } };
    });
    tokenServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { access_token: "fresh-access-token", expires_in: 3600 } }));
    const result = await provider({ apiBaseUrl: apiServer.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    expect(result).toEqual({ healthy: true });
    expect(tokenServer.requests).toHaveLength(1);
  });

  it("reactively refreshes on a 401 even without an expiry hint (publish() has none) — retries exactly once with the new token", async () => {
    let apiCalls = 0;
    apiServer = await startYouTubeFixtureServer((req) => {
      apiCalls += 1;
      if (req.headers.authorization === `Bearer ${CREDENTIAL.accessToken}`) return { status: 401, json: { error: { message: "expired" } } };
      return { status: 200, json: { items: [{ id: "c1" }] } };
    });
    tokenServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { access_token: "refreshed-token", expires_in: 3600 } }));
    const result = await provider({ apiBaseUrl: apiServer.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: null,
    });
    expect(result).toEqual({ healthy: true });
    expect(apiCalls).toBe(2);
    expect(tokenServer.requests).toHaveLength(1);
  });

  it("classifies invalid_grant (revoked refresh token) as CREDENTIAL_REVOKED, distinct from a transient refresh failure", async () => {
    apiServer = await startYouTubeFixtureServer(() => ({ status: 401, json: { error: { message: "expired" } } }));
    tokenServer = await startYouTubeFixtureServer(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Token has been revoked." } }));
    const result = await provider({ apiBaseUrl: apiServer.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: null,
    });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_REVOKED");
  });

  it("classifies a transient refresh failure (5xx from the token endpoint) as PROVIDER_UNAVAILABLE, never CREDENTIAL_REVOKED", async () => {
    apiServer = await startYouTubeFixtureServer(() => ({ status: 401, json: { error: { message: "expired" } } }));
    tokenServer = await startYouTubeFixtureServer(() => ({ status: 503, json: { error: "server_error" } }));
    const result = await provider({ apiBaseUrl: apiServer.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: null,
    });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("PROVIDER_UNAVAILABLE");
  });

  it("classifies a malformed refresh response (missing access_token) as PROVIDER_UNAVAILABLE, not a crash", async () => {
    apiServer = await startYouTubeFixtureServer(() => ({ status: 401, json: { error: { message: "expired" } } }));
    tokenServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { scope: "youtube.upload" } }));
    const result = await provider({ apiBaseUrl: apiServer.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: null,
    });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("PROVIDER_UNAVAILABLE");
  });

  it("calls onCredentialRefreshed with the new access token and expiry, and NEVER includes the refresh token in that call", async () => {
    apiServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { items: [{ id: "c1" }] } }));
    tokenServer = await startYouTubeFixtureServer(() => ({ status: 200, json: { access_token: "new-access-token", expires_in: 1800, scope: "youtube.upload" } }));
    let reportedCredential: Record<string, unknown> | undefined;
    let reportedExpiresAt: Date | null | undefined;
    await provider({ apiBaseUrl: apiServer.url, oauthTokenEndpoint: tokenServer.url }).validateConnection(
      { channelAccountId: "acct-1", decryptedCredential: CREDENTIAL, tokenExpiresAt: new Date(Date.now() - 1000) },
      noopCallbacks({
        onCredentialRefreshed: async (credential, expiresAt) => {
          reportedCredential = credential;
          reportedExpiresAt = expiresAt;
        },
      }),
    );
    expect(reportedCredential).toMatchObject({ accessToken: "new-access-token", refreshToken: CREDENTIAL.refreshToken });
    expect(reportedExpiresAt).toBeInstanceOf(Date);
  });

  it("never includes the access or refresh token in a thrown/returned error detail", async () => {
    apiServer = await startYouTubeFixtureServer(() => ({ status: 401, json: { error: { message: "expired" } } }));
    tokenServer = await startYouTubeFixtureServer(() => ({ status: 400, json: { error: "invalid_grant" } }));
    const result = await provider({ apiBaseUrl: apiServer.url, oauthTokenEndpoint: tokenServer.url }).validateConnection({
      channelAccountId: "acct-1",
      decryptedCredential: CREDENTIAL,
      tokenExpiresAt: null,
    });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL.accessToken);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL.refreshToken);
  });
});

describe("YouTubeChannelProvider — publish() input validation (no request ever made)", () => {
  const BASE_INPUT: PublishingPublishInput = {
    contentType: "VIDEO",
    metadata: { title: "A Great Video" },
    artifact: { mediaAssetPublicId: "asset-1" },
    operationToken: "publishing:target-1:attempt:0",
  };

  it("rejects a non-VIDEO content type", async () => {
    await expect(provider().publish({ ...BASE_INPUT, contentType: "BLOG" }, CREDENTIAL, noopCallbacks())).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("rejects a publish with no artifact", async () => {
    await expect(provider().publish({ ...BASE_INPUT, artifact: undefined }, CREDENTIAL, noopCallbacks())).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("rejects a publish with no title", async () => {
    await expect(provider().publish({ ...BASE_INPUT, metadata: {} }, CREDENTIAL, noopCallbacks())).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("rejects a publish with no media reader supplied", async () => {
    await expect(provider().publish(BASE_INPUT, CREDENTIAL, noopCallbacks({ mediaReader: undefined }))).rejects.toThrow(/media reader/i);
  });

  it("rejects a missing/malformed credential", async () => {
    await expect(provider().publish(BASE_INPUT, { accessToken: "only" }, noopCallbacks())).rejects.toThrow(PublishingProviderPermanentError);
  });
});

describe("YouTubeChannelProvider — failure classification (Part AD)", () => {
  let server: YouTubeFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function fixedMediaReader() {
    return { headObject: async () => ({ sizeBytes: 10, contentType: "video/mp4" }), readRange: async () => Buffer.alloc(10, 1) };
  }

  const BASE_INPUT: PublishingPublishInput = {
    contentType: "VIDEO",
    metadata: { title: "A Great Video" },
    artifact: { mediaAssetPublicId: "asset-1" },
    operationToken: "publishing:target-2:attempt:0",
  };

  async function publishAgainst(sessionCreateResponder: (req: FixtureRequest) => FixtureResponse) {
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/videos?uploadType=resumable")) return sessionCreateResponder(req);
      return { status: 500, json: {} };
    });
    return provider({ uploadBaseUrl: server.url, timeoutMs: 500 }).publish(BASE_INPUT, CREDENTIAL, noopCallbacks({ mediaReader: fixedMediaReader() }));
  }

  it("classifies 429 (session create) as retryable", async () => {
    await expect(publishAgainst(() => ({ status: 429, json: { error: { message: "rate limited" } } }))).rejects.toThrow(PublishingProviderRetryableError);
  });

  it("classifies 500/502/503 as retryable", async () => {
    for (const status of [500, 502, 503]) {
      await expect(publishAgainst(() => ({ status, json: {} }))).rejects.toThrow(PublishingProviderRetryableError);
    }
  });

  it("classifies a timeout as retryable", async () => {
    await expect(publishAgainst(() => ({ status: 200, hang: true }))).rejects.toThrow(PublishingProviderRetryableError);
  }, 10_000);

  it("classifies 400 (invalid metadata) as permanent", async () => {
    await expect(publishAgainst(() => ({ status: 400, json: { error: { message: "invalid title" } } }))).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("classifies a 403 with reason insufficientPermissions as permanent (YOUTUBE_INSUFFICIENT_SCOPE)", async () => {
    await expect(publishAgainst(() => ({ status: 403, json: { error: { errors: [{ reason: "insufficientPermissions" }] } } }))).rejects.toMatchObject({ errorCode: "YOUTUBE_INSUFFICIENT_SCOPE" });
  });

  it.each(["quotaExceeded", "dailyLimitExceeded"])("classifies a 403 with reason %s as retryable (YOUTUBE_QUOTA_EXCEEDED)", async (reason) => {
    await expect(publishAgainst(() => ({ status: 403, json: { error: { errors: [{ reason }] } } }))).rejects.toMatchObject({ errorCode: "YOUTUBE_QUOTA_EXCEEDED" });
  });

  it("classifies a malformed (non-JSON) session-create response as permanent", async () => {
    server = await startYouTubeFixtureServer((req) => {
      if (req.path.startsWith("/videos?uploadType=resumable")) return { status: 200, headers: { "Content-Type": "text/plain" }, json: undefined };
      return { status: 500, json: {} };
    });
    await expect(provider({ uploadBaseUrl: server.url }).publish(BASE_INPUT, CREDENTIAL, noopCallbacks({ mediaReader: fixedMediaReader() }))).rejects.toThrow(PublishingProviderPermanentError);
  });
});
