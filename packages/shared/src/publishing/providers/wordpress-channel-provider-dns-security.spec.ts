import { PublishingProviderPermanentError } from "../publishing-provider-error";
import type { DnsResolvers } from "../publishing-dns-safety";
import { WordPressChannelProvider } from "./wordpress-channel-provider";
import { startWordPressFixtureServer, type WordPressFixtureServer } from "./wordpress-test-fixture-server";

/**
 * Module 9 Phase 9.4 Pre-Merge Security Correction — connector-level DNS-
 * rebinding and redirect-credential-leak coverage. `publishing-dns-safety.spec.ts`
 * already proves the classifier/lookup primitives in isolation; this
 * file proves `WordPressChannelProvider` itself actually wires them in
 * correctly end to end, using a real local fixture HTTP server and
 * injected DNS resolvers (Part G: "use injectable/test DNS resolver") —
 * still zero public-internet dependency.
 */

const CREDENTIAL_BASE = { username: "myev", applicationPassword: "abcd 1234 efgh 5678" };

function credentialFor(server: WordPressFixtureServer, hostname: string) {
  const url = new URL(server.url);
  return { ...CREDENTIAL_BASE, siteUrl: `http://${hostname}:${url.port}` };
}

function resolversFor(hostname: string, ip: string): DnsResolvers {
  return {
    resolve4: (h) => (h === hostname ? Promise.resolve([ip]) : Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }))),
    resolve6: () => Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" })),
  };
}

describe("WordPressChannelProvider — DNS-rebinding safety (connector-level, injected resolver)", () => {
  let server: WordPressFixtureServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("publishes successfully when the configured hostname resolves (via the injected resolver) to the fixture server's own loopback address", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 201, json: { id: 1, link: "https://example.com/p/1" } };
    });
    const hostname = "wp.dns-safe.test.invalid";
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true, dnsResolvers: resolversFor(hostname, "127.0.0.1") });

    const result = await provider.publish(
      { contentType: "BLOG", metadata: { title: "T" }, content: { format: "HTML", body: "<p>x</p>" }, operationToken: "publishing:t1:attempt:0" },
      credentialFor(server, hostname),
    );
    expect(result).toEqual({ externalContentId: "1", externalUrl: "https://example.com/p/1" });
  });

  it("rejects (and never sends a single request) when the configured hostname resolves to a private RFC1918 address, even under allowLocalTestTarget", async () => {
    server = await startWordPressFixtureServer(() => ({ status: 201, json: { id: 1, link: "https://example.com/p/1" } }));
    const hostname = "wp.rebind.test.invalid";
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true, dnsResolvers: resolversFor(hostname, "10.1.2.3") });

    await expect(
      provider.publish(
        { contentType: "BLOG", metadata: { title: "T" }, content: { format: "HTML", body: "<p>x</p>" }, operationToken: "publishing:t2:attempt:0" },
        credentialFor(server, hostname),
      ),
    ).rejects.toThrow(PublishingProviderPermanentError);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects when the configured hostname resolves to the cloud-metadata link-local address 169.254.169.254", async () => {
    server = await startWordPressFixtureServer(() => ({ status: 201, json: { id: 1, link: "https://example.com/p/1" } }));
    const hostname = "wp.metadata.test.invalid";
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true, dnsResolvers: resolversFor(hostname, "169.254.169.254") });

    await expect(
      provider.validateConnection({ channelAccountId: "acct-1", decryptedCredential: credentialFor(server, hostname), tokenExpiresAt: null }),
    ).resolves.toMatchObject({ healthy: false, reasonCode: "CREDENTIAL_INVALID" });
    expect(server.requests).toHaveLength(0);
  });

  it("DNS-rebinding structural proof at the connector level: the injected resolver is called exactly once per publish() call, and the connection reaches exactly the address that resolution returned", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 201, json: { id: 7, link: "https://example.com/p/7" } };
    });
    const hostname = "wp.onecall.test.invalid";
    let resolve4Calls = 0;
    const resolvers: DnsResolvers = {
      resolve4: (h) => {
        if (h !== hostname) return Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
        resolve4Calls += 1;
        return Promise.resolve(["127.0.0.1"]);
      },
      resolve6: () => Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" })),
    };
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true, dnsResolvers: resolvers });

    const result = await provider.publish(
      { contentType: "BLOG", metadata: { title: "T" }, content: { format: "HTML", body: "<p>x</p>" }, operationToken: "publishing:t3:attempt:0" },
      credentialFor(server, hostname),
    );

    expect(result.externalContentId).toBe("7");
    // publish() makes exactly two HTTP hops (reconciliation search, then
    // create) — each hop resolves DNS exactly once via performOneHop's
    // own fresh lookup, never more, and never a second, uncontrolled
    // resolution for either.
    expect(resolve4Calls).toBe(2);
    expect(server.requests).toHaveLength(2);
  });

  it("re-validates DNS independently for every hop within a single publish() call — a mid-flow rebind between the reconciliation search and the create is caught, not reused from the first hop's already-validated address", async () => {
    server = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 201, json: { id: 1, link: "https://example.com/p/1" } }; // never reached if the second hop's DNS re-check works.
    });
    const hostname = "wp.midflow-rebind.test.invalid";
    let calls = 0;
    const resolvers: DnsResolvers = {
      resolve4: (h) => {
        if (h !== hostname) return Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
        calls += 1;
        // First hop (reconciliation search): a genuinely public/safe
        // answer. Second hop (create): the attacker's DNS flips to a
        // private address — simulating a rebind occurring between two
        // requests of the SAME publish() call, against the SAME
        // hostname. If DNS validation were cached/reused from the first
        // hop rather than re-run per request, this second hop would
        // wrongly be allowed through.
        return Promise.resolve([calls === 1 ? "127.0.0.1" : "10.0.0.9"]);
      },
      resolve6: () => Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" })),
    };
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true, dnsResolvers: resolvers });

    await expect(
      provider.publish(
        { contentType: "BLOG", metadata: { title: "T" }, content: { format: "HTML", body: "<p>x</p>" }, operationToken: "publishing:t7:attempt:0" },
        credentialFor(server, hostname),
      ),
    ).rejects.toThrow(PublishingProviderPermanentError);

    expect(calls).toBe(2);
    // Only the first hop (the safe reconciliation search) ever reached
    // the fixture server — the second hop was rejected before any
    // connection was attempted.
    expect(server.requests).toHaveLength(1);
  });
});

describe("WordPressChannelProvider — redirect credential policy (cross-origin rejection)", () => {
  let originServer: WordPressFixtureServer | undefined;
  let otherOriginServer: WordPressFixtureServer | undefined;
  afterEach(async () => {
    await originServer?.close();
    await otherOriginServer?.close();
    originServer = undefined;
    otherOriginServer = undefined;
  });

  it("follows a same-origin redirect and DOES send Authorization to it", async () => {
    let redirected = false;
    originServer = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      if (req.path === "/wp-json/wp/v2/posts" && !redirected) {
        redirected = true;
        return { status: 301, headers: { Location: `${originServer!.url}/wp-json/wp/v2/posts` } };
      }
      return { status: 201, json: { id: 9, link: "https://example.com/p/9" } };
    });
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true });

    const result = await provider.publish(
      { contentType: "BLOG", metadata: { title: "T" }, content: { format: "HTML", body: "<p>x</p>" }, operationToken: "publishing:t4:attempt:0" },
      { ...CREDENTIAL_BASE, siteUrl: originServer.url },
    );

    expect(result.externalContentId).toBe("9");
    const expectedAuth = `Basic ${Buffer.from(`${CREDENTIAL_BASE.username}:${CREDENTIAL_BASE.applicationPassword}`).toString("base64")}`;
    expect(originServer.requests.every((r) => r.authorization === expectedAuth)).toBe(true);
  });

  it("rejects a redirect to a different origin, and the other origin never receives ANY request (Authorization never forwarded)", async () => {
    otherOriginServer = await startWordPressFixtureServer(() => ({ status: 201, json: { id: 999, link: "https://should-never.example/p/999" } }));
    originServer = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 301, headers: { Location: `${otherOriginServer!.url}/wp-json/wp/v2/posts` } };
    });
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true });

    await expect(
      provider.publish(
        { contentType: "BLOG", metadata: { title: "T" }, content: { format: "HTML", body: "<p>x</p>" }, operationToken: "publishing:t5:attempt:0" },
        { ...CREDENTIAL_BASE, siteUrl: originServer.url },
      ),
    ).rejects.toMatchObject({ errorCode: "WORDPRESS_CROSS_ORIGIN_REDIRECT_REJECTED" });

    expect(otherOriginServer.requests).toHaveLength(0);
  });

  it("never includes the application password in the cross-origin-rejection error's message", async () => {
    otherOriginServer = await startWordPressFixtureServer(() => ({ status: 201, json: { id: 1, link: "https://x/p/1" } }));
    originServer = await startWordPressFixtureServer((req) => {
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] };
      return { status: 301, headers: { Location: `${otherOriginServer!.url}/wp-json/wp/v2/posts` } };
    });
    const provider = new WordPressChannelProvider({ allowLocalTestTarget: true });

    try {
      await provider.publish(
        { contentType: "BLOG", metadata: { title: "T" }, content: { format: "HTML", body: "<p>x</p>" }, operationToken: "publishing:t6:attempt:0" },
        { ...CREDENTIAL_BASE, siteUrl: originServer.url },
      );
      throw new Error("expected publish() to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(CREDENTIAL_BASE.applicationPassword);
    }
  });
});
