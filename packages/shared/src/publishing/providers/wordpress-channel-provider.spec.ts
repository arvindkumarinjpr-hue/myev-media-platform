import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import type { PublishingPublishInput } from "../publishing-provider.interface";
import { WordPressChannelProvider } from "./wordpress-channel-provider";
import { startWordPressFixtureServer, type FixtureRequest, type FixtureResponse, type WordPressFixtureServer } from "./wordpress-test-fixture-server";

const CREDENTIAL = { siteUrl: "http://127.0.0.1:0", username: "myev", applicationPassword: "abcd 1234 efgh 5678" };

function credentialFor(server: WordPressFixtureServer) {
  return { ...CREDENTIAL, siteUrl: server.url };
}

function provider(overrides: Partial<{ timeoutMs: number }> = {}) {
  return new WordPressChannelProvider({ allowLocalTestTarget: true, timeoutMs: overrides.timeoutMs ?? 2_000 });
}

const BASE_PUBLISH_INPUT: PublishingPublishInput = {
  contentType: "BLOG",
  metadata: { title: "A Great Post", description: "A short summary." },
  content: { format: "HTML", body: "<p>Hello world.</p>" },
  operationToken: "publishing:target-abc-123:attempt:0",
};

describe("WordPressChannelProvider — capabilities", () => {
  it("advertises truthful, WordPress-specific capabilities", () => {
    const capabilities = provider().getCapabilities();
    expect(capabilities.supportedContentTypes).toEqual(["BLOG"]);
    expect(capabilities.requiresTitle).toBe(true);
    expect(capabilities.requiresRenderedMedia).toBe(false);
    expect(capabilities.supportsTags).toBe(false);
    expect(capabilities.supportsCaption).toBe(false);
    expect(capabilities.supportedPrivacyOptions).toBeUndefined();
  });
});

describe("WordPressChannelProvider — validateConnection", () => {
  let server: WordPressFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns healthy on a 200 from /users/me, and never creates a post", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path === "/wp-json/wp/v2/users/me" && req.method === "GET") return { status: 200, json: { id: 1, name: "MYEV Bot" } };
      return { status: 500, json: { message: "unexpected request" } };
    });
    const result = await provider().validateConnection({ channelAccountId: "acct-1", decryptedCredential: credentialFor(server), tokenExpiresAt: null });
    expect(result.healthy).toBe(true);
    expect(server.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it.each([401, 403])("returns CREDENTIAL_INVALID on HTTP %i", async (status) => {
    server = await startWordPressFixtureServer(() => ({ status, json: { code: "rest_forbidden" } }));
    const result = await provider().validateConnection({ channelAccountId: "acct-1", decryptedCredential: credentialFor(server), tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
  });

  it("returns PROVIDER_UNAVAILABLE on a 5xx", async () => {
    server = await startWordPressFixtureServer(() => ({ status: 503, json: { message: "down" } }));
    const result = await provider().validateConnection({ channelAccountId: "acct-1", decryptedCredential: credentialFor(server), tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("PROVIDER_UNAVAILABLE");
  });

  it("returns PROVIDER_UNAVAILABLE on a timeout", async () => {
    server = await startWordPressFixtureServer(() => ({ status: 200, hang: true }));
    const result = await provider({ timeoutMs: 200 }).validateConnection({ channelAccountId: "acct-1", decryptedCredential: credentialFor(server), tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("PROVIDER_UNAVAILABLE");
  }, 10_000);

  it("returns CREDENTIAL_INVALID for a missing/malformed credential without ever making a request", async () => {
    const result = await provider().validateConnection({ channelAccountId: "acct-1", decryptedCredential: { siteUrl: "https://example.com" }, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
  });

  it("returns CREDENTIAL_INVALID for an unsafe (private-network) siteUrl even with allowLocalTestTarget off", async () => {
    const insecureProvider = new WordPressChannelProvider();
    const result = await insecureProvider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: { ...CREDENTIAL, siteUrl: "http://127.0.0.1:9" }, tokenExpiresAt: null });
    expect(result.healthy).toBe(false);
    expect(result.reasonCode).toBe("CREDENTIAL_INVALID");
  });
});

describe("WordPressChannelProvider — publish success + response mapping", () => {
  let server: WordPressFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("creates a post and maps id/link to externalContentId/externalUrl", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] }; // no existing post
      if (req.path === "/wp-json/wp/v2/posts" && req.method === "POST") return { status: 201, json: { id: 42, link: "https://example.com/2026/09/a-great-post/" } };
      return { status: 500, json: {} };
    });
    const result = await provider().publish(BASE_PUBLISH_INPUT, credentialFor(server));
    expect(result).toEqual({ externalContentId: "42", externalUrl: "https://example.com/2026/09/a-great-post/" });
  });

  it("sends the title, HTML body (with the reconciliation marker appended), status=publish, and the description as excerpt", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 201, json: { id: 1, link: "https://example.com/p/1" } };
    });
    await provider().publish(BASE_PUBLISH_INPUT, credentialFor(server));
    const createRequest = server.requests.find((r) => r.method === "POST")!;
    const body = createRequest.body as { title: string; content: string; status: string; excerpt?: string };
    expect(body.title).toBe("A Great Post");
    expect(body.status).toBe("publish");
    expect(body.excerpt).toBe("A short summary.");
    expect(body.content).toContain("<p>Hello world.</p>");
    expect(body.content).toContain("<!-- myev-publish-target:target-abc-123 -->");
  });

  it("rejects a non-BLOG content type without making a request", async () => {
    await expect(provider().publish({ ...BASE_PUBLISH_INPUT, contentType: "VIDEO" }, CREDENTIAL)).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("rejects a publish with no resolved content", async () => {
    await expect(provider().publish({ ...BASE_PUBLISH_INPUT, content: undefined }, CREDENTIAL)).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("rejects a publish with no title", async () => {
    await expect(provider().publish({ ...BASE_PUBLISH_INPUT, metadata: {} }, CREDENTIAL)).rejects.toThrow(PublishingProviderPermanentError);
  });
});

describe("WordPressChannelProvider — reconciliation / duplicate prevention", () => {
  let server: WordPressFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("finds an existing post carrying the exact reconciliation marker and returns it instead of creating a new one", async () => {
    const marker = "<!-- myev-publish-target:target-abc-123 -->";
    let postCreateCalls = 0;
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) {
        return { status: 200, json: [{ id: 99, link: "https://example.com/p/99", content: { raw: `<p>Already there.</p>\n${marker}` } }] };
      }
      if (req.path === "/wp-json/wp/v2/posts" && req.method === "POST") {
        postCreateCalls += 1;
        return { status: 201, json: { id: 100, link: "https://example.com/p/100" } };
      }
      return { status: 500, json: {} };
    });
    const result = await provider().publish(BASE_PUBLISH_INPUT, credentialFor(server));
    expect(result).toEqual({ externalContentId: "99", externalUrl: "https://example.com/p/99" });
    expect(postCreateCalls).toBe(0);
  });

  it("ignores a search hit that does NOT carry the exact marker (fuzzy match is not enough) and creates a new post", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) {
        return { status: 200, json: [{ id: 5, link: "https://example.com/p/5", content: { raw: "unrelated content, no marker here" } }] };
      }
      if (req.path === "/wp-json/wp/v2/posts" && req.method === "POST") return { status: 201, json: { id: 6, link: "https://example.com/p/6" } };
      return { status: 500, json: {} };
    });
    const result = await provider().publish(BASE_PUBLISH_INPUT, credentialFor(server));
    expect(result.externalContentId).toBe("6");
  });

  it("reconciles across attempt generations — a different operationToken for the SAME target still finds the earlier post", async () => {
    const marker = "<!-- myev-publish-target:target-abc-123 -->";
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) {
        return { status: 200, json: [{ id: 77, link: "https://example.com/p/77", content: { raw: marker } }] };
      }
      return { status: 500, json: {} };
    });
    const retryInput: PublishingPublishInput = { ...BASE_PUBLISH_INPUT, operationToken: "publishing:target-abc-123:attempt:1" };
    const result = await provider().publish(retryInput, credentialFor(server));
    expect(result.externalContentId).toBe("77");
  });
});

describe("WordPressChannelProvider — failure classification", () => {
  let server: WordPressFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function publishAgainst(responder: (req: FixtureRequest) => FixtureResponse) {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return responder(req);
    });
    return provider({ timeoutMs: 300 }).publish(BASE_PUBLISH_INPUT, credentialFor(server));
  }

  it("classifies a timeout as retryable", async () => {
    await expect(publishAgainst(() => ({ status: 200, hang: true }))).rejects.toThrow(PublishingProviderRetryableError);
  }, 10_000);

  it("classifies 429 as retryable", async () => {
    await expect(publishAgainst(() => ({ status: 429, json: { message: "rate limited" } }))).rejects.toThrow(PublishingProviderRetryableError);
  });

  it("classifies 500/502/503 as retryable", async () => {
    for (const status of [500, 502, 503]) {
      await expect(publishAgainst(() => ({ status, json: {} }))).rejects.toThrow(PublishingProviderRetryableError);
    }
  });

  it("classifies 400 as permanent", async () => {
    await expect(publishAgainst(() => ({ status: 400, json: { code: "rest_invalid_param" } }))).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("classifies 401 as permanent (auth)", async () => {
    await expect(publishAgainst(() => ({ status: 401, json: { code: "rest_not_logged_in" } }))).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("classifies 403 as permanent (insufficient permission)", async () => {
    await expect(publishAgainst(() => ({ status: 403, json: { code: "rest_cannot_create" } }))).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("classifies a malformed (non-JSON / unexpected-shape) response as permanent", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 201, headers: { "Content-Type": "text/plain" }, json: undefined };
    });
    await expect(provider().publish(BASE_PUBLISH_INPUT, credentialFor(server))).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("classifies a reconciliation-lookup failure as a typed error, never silently treated as no-existing-post", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 503, json: {} };
      return { status: 201, json: { id: 1, link: "https://example.com/p/1" } };
    });
    await expect(provider().publish(BASE_PUBLISH_INPUT, credentialFor(server))).rejects.toThrow(PublishingProviderRetryableError);
  });
});

describe("WordPressChannelProvider — security", () => {
  let server: WordPressFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("sends Basic Auth built from username:applicationPassword, never the raw fields as separate headers", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 201, json: { id: 1, link: "https://example.com/p/1" } };
    });
    await provider().publish(BASE_PUBLISH_INPUT, credentialFor(server));
    const expected = `Basic ${Buffer.from(`${CREDENTIAL.username}:${CREDENTIAL.applicationPassword}`).toString("base64")}`;
    expect(server.requests.every((r) => r.authorization === expected)).toBe(true);
  });

  it("never includes the application password in a thrown error's message", async () => {
    server = await startWordPressFixtureServer(() => ({ status: 401, json: {} }));
    try {
      await provider().publish(BASE_PUBLISH_INPUT, credentialFor(server));
      throw new Error("expected publish() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PublishingProviderPermanentError);
      expect((err as Error).message).not.toContain(CREDENTIAL.applicationPassword);
    }
  });

  it("rejects publishing against a private-network siteUrl even when the caller forgets allowLocalTestTarget", async () => {
    const insecureProvider = new WordPressChannelProvider();
    await expect(insecureProvider.publish(BASE_PUBLISH_INPUT, { ...CREDENTIAL, siteUrl: "http://127.0.0.1:9" })).rejects.toThrow();
  });

  it("rejects a redirect to a private-network host rather than following it", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 301, headers: { Location: "http://169.254.169.254/latest/meta-data" } };
    });
    await expect(provider().publish(BASE_PUBLISH_INPUT, credentialFor(server))).rejects.toThrow(PublishingProviderPermanentError);
  });

  it("rejects more than the bounded number of redirects", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 301, headers: { Location: `${server!.url}/wp-json/wp/v2/posts` } };
    });
    await expect(provider().publish(BASE_PUBLISH_INPUT, credentialFor(server))).rejects.toThrow(PublishingProviderPermanentError);
  });
});
