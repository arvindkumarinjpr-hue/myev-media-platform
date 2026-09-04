import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import type {
  PublishingChannelCapabilities,
  PublishingChannelProvider,
  PublishingConnectionCheckInput,
  PublishingConnectionValidationResult,
  PublishingPublishInput,
  PublishingPublishResult,
} from "../publishing-provider.interface";
import { createSsrfSafeLookup, UnsafeResolvedAddressError, type DnsResolvers } from "../publishing-dns-safety";
import { assertSafePublishingSiteUrl, isSafePublishingRedirectTarget, UnsafePublishingSiteUrlError } from "../publishing-site-url-safety";
import { parseWordPressCredential, type WordPressCredentialPayload } from "./wordpress-credential";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB — a WordPress REST post/user response never legitimately needs to be larger.

const TIMEOUT_MARKER = Symbol("wordpress-request-timeout");
interface TimeoutError extends Error {
  [TIMEOUT_MARKER]: true;
}
function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof Error && TIMEOUT_MARKER in err;
}

export interface WordPressChannelProviderOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test-only escape hatch for a local fixture HTTP server — never the production default (see publishing-site-url-safety.ts). Scoped to loopback only, both at the URL-shape layer AND (Pre-Merge Security Correction) at DNS-resolution time. */
  allowLocalTestTarget?: boolean;
  /** Test-only DNS resolver injection, passed straight through to publishing-dns-safety.ts — see its own doc comment. Defaults to real DNS. */
  dnsResolvers?: DnsResolvers;
  /**
   * Test-only additional trusted CA certificate(s) (PEM), passed straight
   * through to `https.request`'s own `ca` option — ADDS trust for a
   * specific test-only self-signed certificate, it never disables or
   * weakens verification (`rejectUnauthorized` is never touched, here or
   * anywhere else in this class). Exists solely so a local HTTPS fixture
   * server can be used in tests without either reaching the real
   * internet or ever setting `rejectUnauthorized: false`. Undefined by
   * default — production connections rely on Node's normal system CA
   * trust store, exactly as before.
   */
  caCertificates?: string[] | Buffer[];
}

interface WordPressRequestResult {
  status: number;
  json: unknown;
}

interface WordPressPostSummary {
  id: number;
  link: string;
  content?: { raw?: string; rendered?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Module 9 Phase 9.4 — the first real PublishingChannelProvider. Plugs
 * into the existing Phase 9.1-9.3 backbone unchanged: no schedule(), no
 * delete(), no webhook methods, `publish()`/`validateConnection()` are
 * the only entry points a caller ever uses.
 *
 * Framework-free (no NestJS, no Prisma) — uses the global `fetch` +
 * `AbortController`, the same convention `HttpResearchSourceProvider`
 * already established (apps/api/src/modules/research/). Fully stateless
 * across calls: siteUrl/credentials come from the decrypted credential
 * passed into each call, never from environment or constructor config —
 * so this ONE class is shared verbatim by both apps/api's and
 * apps/worker's own provider-registry factories (Part T: no connector
 * business-rule duplication).
 *
 * Never queries Prisma and never knows about ContentVersion's storage
 * shape — the caller (apps/worker's execution service) resolves the
 * post body via `resolveBlogPublishingContent()` and passes the result
 * in as `PublishingPublishInput.content` before this class is ever
 * invoked.
 */
export class WordPressChannelProvider implements PublishingChannelProvider {
  readonly channelType = "WORDPRESS" as const;

  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly allowLocalTestTarget: boolean;
  private readonly dnsResolvers: DnsResolvers | undefined;
  private readonly caCertificates: string[] | Buffer[] | undefined;

  constructor(options: WordPressChannelProviderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.allowLocalTestTarget = options.allowLocalTestTarget ?? false;
    this.dnsResolvers = options.dnsResolvers;
    this.caCertificates = options.caCertificates;
  }

  getCapabilities(): PublishingChannelCapabilities {
    return {
      supportedContentTypes: ["BLOG"],
      // WordPress always needs the rendered post body (Part G) — the
      // shared "requiresRenderedMedia" flag exists for the VIDEO-shaped
      // artifact concept; WordPress instead requires
      // PublishingPublishInput.content, checked explicitly in publish()
      // itself since the shared readiness engine's own artifact
      // resolution is VIDEO-only today (see readiness's new
      // BLOG_PUBLISHING_CONTENT_MISSING reason for the BLOG equivalent).
      requiresRenderedMedia: false,
      requiresTitle: true,
      requiresDescription: false,
      // Part L: categories/tags are deliberately NOT mapped in v1 — no
      // product/data authority exists for auto-creating or matching
      // WordPress categories/taxonomies against anything MYEV stores
      // today (BlogArticle has no category/tag field). `supportsTags:
      // false` is truthful, not a placeholder — publish() never sends
      // categories/tags, and a Blog publishes successfully without them.
      // Deferred and documented, not silently dropped.
      supportsTags: false,
      supportsCaption: false,
      // Part M: featured image is deliberately NOT implemented in v1 —
      // `ContentItem.featuredMediaAssetId` exists but the Blog pipeline
      // never populates it, and adding WordPress media-upload (a second,
      // materially larger HTTP flow: multipart upload to `/media`, then
      // referencing the resulting attachment id from the post payload)
      // is out of this phase's scope per Part M's own explicit
      // permission to defer absent product-doc authority. Readiness
      // never blocks on a missing featured image (no such check exists
      // here or in the shared readiness engine).
      // WordPress's own privacy concept is post *status*, not a
      // YouTube-style privacy enum — publish() always uses "publish"
      // (Part J: platform-controlled scheduling remains authoritative,
      // WordPress-native scheduling/status=future is never used).
      // No supportedPrivacyOptions advertised in v1.
    };
  }

  async validateConnection(input: PublishingConnectionCheckInput): Promise<PublishingConnectionValidationResult> {
    const credential = parseWordPressCredential(input.decryptedCredential);
    if (!credential) {
      return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "Stored WordPress credential is missing required fields." };
    }

    try {
      // /wp/v2/users/me — a minimal, always-available WordPress core
      // REST endpoint (no plugin required) that simultaneously proves
      // the site is reachable, the credential authenticates, and the
      // authenticated user exists. Never creates a post during
      // validation (Part H).
      const { status } = await this.request(credential, "GET", "users/me");
      if (status === 200) return { healthy: true };
      if (status === 401 || status === 403) return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: `WordPress rejected the credential (HTTP ${status}).` };
      return { healthy: false, reasonCode: "PROVIDER_UNAVAILABLE", detail: `Unexpected WordPress response (HTTP ${status}).` };
    } catch (err) {
      if (err instanceof UnsafePublishingSiteUrlError) {
        return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "The configured WordPress site URL failed safety validation." };
      }
      // DNS-resolution-time rejection (Pre-Merge Security Correction) —
      // a hostname that validated at the URL-shape layer but resolved to
      // a private/reserved address is the same class of "this site is
      // misconfigured/unsafe" problem as a literal private IP, so it is
      // classified identically rather than as a generic unavailability.
      if (err instanceof PublishingProviderPermanentError && err.errorCode === "WORDPRESS_UNSAFE_CONNECT_TARGET") {
        return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "The configured WordPress site URL resolved to a disallowed network address." };
      }
      return { healthy: false, reasonCode: "PROVIDER_UNAVAILABLE", detail: "WordPress site unreachable or timed out." };
    }
  }

  async publish(input: PublishingPublishInput, decryptedCredential: Record<string, unknown>): Promise<PublishingPublishResult> {
    const credential = parseWordPressCredential(decryptedCredential);
    if (!credential) {
      throw new PublishingProviderPermanentError("WORDPRESS_CREDENTIAL_INVALID", "Stored WordPress credential is missing required fields.");
    }
    if (input.contentType !== "BLOG") {
      throw new PublishingProviderPermanentError("WORDPRESS_UNSUPPORTED_CONTENT_TYPE", `WordPress does not support publishing content type "${input.contentType}".`);
    }
    if (!input.content || input.content.format !== "HTML") {
      throw new PublishingProviderPermanentError("WORDPRESS_CONTENT_MISSING", "No resolved HTML body content was provided to publish.");
    }
    if (!input.metadata.title) {
      throw new PublishingProviderPermanentError("WORDPRESS_TITLE_MISSING", "A title is required to publish to WordPress.");
    }

    // Reconciliation marker (Part P/Q): scoped to the TARGET, not the
    // per-attempt operationToken — operationToken's own generation
    // increments on every explicit domain-level retry (Phase 9.3's own
    // semantics, unchanged), but "has this target already produced a
    // real WordPress post" is a target-scoped fact that must survive
    // across attempt generations, not just redeliveries of the exact
    // same attempt. Parsed from operationToken's own stable
    // `publishing:{targetPublicId}:attempt:{n}` shape (apps/worker's
    // PublishingExecutionService) rather than inventing a new token.
    const targetKey = extractTargetKey(input.operationToken);
    const marker = `<!-- myev-publish-target:${targetKey} -->`;

    const existing = await this.findPostByMarker(credential, targetKey, marker);
    if (existing) {
      return { externalContentId: String(existing.id), externalUrl: existing.link };
    }

    const payload: Record<string, unknown> = {
      title: input.metadata.title,
      content: `${input.content.body}\n${marker}`,
      status: "publish",
    };
    if (input.metadata.description) {
      // BlogArticle.metaDescription -> excerpt is a truthful mapping —
      // both are a short, human-written summary of the same article
      // (Part K). No canonical URL, no fabricated public URL anywhere
      // in this payload.
      payload.excerpt = input.metadata.description;
    }

    const { status, json } = await this.request(credential, "POST", "posts", payload);
    if (status === 201 && isRecord(json) && typeof json.id === "number" && typeof json.link === "string") {
      return { externalContentId: String(json.id), externalUrl: json.link };
    }
    throw this.classifyFailure(status, json, "publish");
  }

  /**
   * Reconciliation-before-create (Part P): WordPress core REST's own
   * `search` parameter (full-text across title/content/excerpt, no
   * plugin required) combined with `context=edit` (returns
   * `content.raw`, the exact unfiltered stored content) lets this class
   * find an already-created post carrying the exact HTML-comment marker
   * without ever needing custom post-meta registration or a server-side
   * plugin — the generic, no-plugin-required strategy Part P asks for.
   * Matching is exact-string, never fuzzy, against `content.raw`.
   */
  private async findPostByMarker(credential: WordPressCredentialPayload, targetKey: string, marker: string): Promise<WordPressPostSummary | null> {
    const { status, json } = await this.request(credential, "GET", `posts?search=${encodeURIComponent(targetKey)}&status=any&context=edit`);
    if (status !== 200 || !Array.isArray(json)) {
      // A reconciliation-lookup failure must never be silently treated
      // as "no existing post" — that would risk a real duplicate. It is
      // classified and thrown exactly like any other request failure.
      throw this.classifyFailure(status, json, "reconciliation lookup");
    }
    for (const candidate of json) {
      if (!isRecord(candidate) || typeof candidate.id !== "number" || typeof candidate.link !== "string") continue;
      const content = isRecord(candidate.content) ? candidate.content : undefined;
      const raw = typeof content?.raw === "string" ? content.raw : typeof content?.rendered === "string" ? content.rendered : "";
      if (raw.includes(marker)) {
        return { id: candidate.id, link: candidate.link };
      }
    }
    return null;
  }

  private classifyFailure(status: number, json: unknown, operation: string): PublishingProviderRetryableError | PublishingProviderPermanentError {
    const detail = `WordPress ${operation} failed (HTTP ${status}).`;
    if (status === 429 || status >= 500) {
      return new PublishingProviderRetryableError(status === 429 ? "WORDPRESS_RATE_LIMITED" : "WORDPRESS_SERVER_ERROR", detail);
    }
    if (status === 401) return new PublishingProviderPermanentError("WORDPRESS_UNAUTHORIZED", detail);
    if (status === 403) return new PublishingProviderPermanentError("WORDPRESS_FORBIDDEN", detail);
    if (status === 400) return new PublishingProviderPermanentError("WORDPRESS_INVALID_PAYLOAD", detail);
    // Any other unexpected status or a malformed/unparseable body —
    // "unsupported/malformed endpoint" is explicitly a PERMANENT
    // classification (Part O), never assumed transient.
    void json;
    return new PublishingProviderPermanentError("WORDPRESS_MALFORMED_RESPONSE", detail);
  }

  /**
   * The one focused HTTP client this class uses (Part N), hardened
   * against DNS rebinding (Pre-Merge Security Correction): a bounded
   * timeout, a manual, safety-checked, bounded redirect loop (never
   * `redirect: "follow"`), a response-size guard, and curated/sanitized
   * errors only — plus, for EVERY hop (initial request and every
   * redirect alike), DNS resolution is performed and validated by this
   * class itself via `createSsrfSafeLookup()` and handed to
   * `http(s).request()`'s own `lookup` option, so the real socket
   * connects to exactly the address that was validated. There is no
   * separate "validate the URL, then let the HTTP client resolve DNS
   * again" step for a rebinding attacker to exploit. `host` passed to
   * `http(s).request()` always stays the ORIGINAL hostname string
   * (never the resolved IP), which is what keeps TLS SNI and
   * certificate-hostname verification — and the `Host` header — correct
   * automatically; this class never sets `rejectUnauthorized: false` and
   * never overrides `servername`. The Basic Auth header is only ever
   * attached when the current hop's origin still matches the originally
   * configured site's origin (see `request`'s own redirect-origin check)
   * and is never logged.
   */
  private async request(credential: WordPressCredentialPayload, method: "GET" | "POST", path: string, body?: unknown): Promise<WordPressRequestResult> {
    const initialTarget = assertSafePublishingSiteUrl(credential.siteUrl, { allowLocalTestTarget: this.allowLocalTestTarget });
    const originalOrigin = new URL(initialTarget).origin;
    const authHeader = `Basic ${Buffer.from(`${credential.username}:${credential.applicationPassword}`).toString("base64")}`;

    let target = initialTarget;
    for (let redirects = 0; ; redirects++) {
      const url = `${target}/wp-json/wp/v2/${path}`;
      const parsedUrl = new URL(url);
      const includeAuth = parsedUrl.origin === originalOrigin;

      const response = await this.performOneHop(parsedUrl, method, includeAuth ? authHeader : undefined, body);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers["location"];
        if (!location || typeof location !== "string") throw new PublishingProviderPermanentError("WORDPRESS_MALFORMED_RESPONSE", "WordPress returned a redirect with no Location header.");
        if (redirects >= this.maxRedirects) throw new PublishingProviderPermanentError("WORDPRESS_TOO_MANY_REDIRECTS", "WordPress redirected too many times.");
        const resolved = new URL(location, url).toString();
        if (!isSafePublishingRedirectTarget(resolved, { allowLocalTestTarget: this.allowLocalTestTarget })) {
          throw new PublishingProviderPermanentError("WORDPRESS_UNSAFE_REDIRECT", "WordPress redirected to a disallowed target.");
        }
        if (new URL(resolved).origin !== originalOrigin) {
          // Part E/I: never forward the Authorization header to a
          // different origin. The simplest safe policy — reject the
          // redirect outright rather than attempting a credential-less
          // follow (which WordPress would reject anyway) — the
          // applicationPassword must never even be considered for a
          // host the workspace didn't configure.
          throw new PublishingProviderPermanentError("WORDPRESS_CROSS_ORIGIN_REDIRECT_REJECTED", "WordPress redirected to a different origin than the configured site; the credential was not forwarded.");
        }
        target = resolved.replace(/\/wp-json\/wp\/v2\/.*$/, "");
        continue;
      }

      let json: unknown;
      try {
        json = response.text.length > 0 ? JSON.parse(response.text) : undefined;
      } catch {
        // A non-JSON body (e.g. an HTML error page from a
        // misconfigured site) is a malformed response, not a parse
        // crash — status is still reported so the caller can classify it.
        json = undefined;
      }
      return { status: response.status, json };
    }
  }

  /** One single HTTP request/response round trip — DNS-safe connect, bounded timeout, bounded response size. Never follows a redirect itself; that is `request()`'s own loop. */
  private performOneHop(parsedUrl: URL, method: "GET" | "POST", authHeader: string | undefined, body: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
    return new Promise((resolve, reject) => {
      const isHttps = parsedUrl.protocol === "https:";
      const transport = isHttps ? httpsRequest : httpRequest;
      const lookup = createSsrfSafeLookup({ allowLocalTestTarget: this.allowLocalTestTarget, resolvers: this.dnsResolvers });
      const payload = body !== undefined ? JSON.stringify(body) : undefined;

      const req = transport(
        {
          protocol: parsedUrl.protocol,
          host: parsedUrl.hostname, // ALWAYS the original hostname — never the resolved IP — so SNI/cert/Host stay correct.
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method,
          agent: false, // No connection pooling/reuse across hops or calls — every request resolves and connects fresh.
          lookup: lookup as never, // Node's own LookupFunction type doesn't model the options.all=true shape our function also handles; verified correct at runtime (publishing-dns-safety.spec.ts).
          // Test-only ADDITIONAL trust (never a substitute for real CA
          // trust, never rejectUnauthorized:false) — see caCertificates'
          // own doc comment. Only meaningful for https; harmless/ignored
          // by http.request's own option surface.
          ...(isHttps && this.caCertificates ? { ca: this.caCertificates } : {}),
          headers: {
            ...(authHeader ? { Authorization: authHeader } : {}),
            ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let rejected = false;
          res.on("data", (chunk: Buffer) => {
            if (rejected) return;
            total += chunk.length;
            if (total > MAX_RESPONSE_BYTES) {
              rejected = true;
              res.destroy();
              reject(new PublishingProviderPermanentError("WORDPRESS_RESPONSE_TOO_LARGE", "WordPress response exceeded the maximum allowed size."));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (rejected) return;
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") });
          });
          res.on("error", (err) => {
            if (rejected) return;
            reject(new PublishingProviderRetryableError("WORDPRESS_NETWORK_ERROR", "WordPress request failed (network error)."));
            void err;
          });
        },
      );

      const timer = setTimeout(() => {
        const timeoutError = new Error("WordPress request timed out.") as Error & { [TIMEOUT_MARKER]: true };
        timeoutError[TIMEOUT_MARKER] = true;
        req.destroy(timeoutError);
      }, this.timeoutMs);

      req.on("error", (err) => {
        clearTimeout(timer);
        if (err instanceof PublishingProviderPermanentError || err instanceof PublishingProviderRetryableError) {
          reject(err);
          return;
        }
        if (isTimeoutError(err)) {
          reject(new PublishingProviderRetryableError("WORDPRESS_NETWORK_ERROR", "WordPress request timed out."));
          return;
        }
        if (err instanceof UnsafeResolvedAddressError) {
          if (err.reasonCode === "DNS_RESOLVED_UNSAFE_ADDRESS") {
            reject(new PublishingProviderPermanentError("WORDPRESS_UNSAFE_CONNECT_TARGET", "The configured WordPress site resolved to a private/reserved network address."));
          } else {
            reject(new PublishingProviderRetryableError("WORDPRESS_NETWORK_ERROR", "WordPress request failed (network error)."));
          }
          return;
        }
        reject(new PublishingProviderRetryableError("WORDPRESS_NETWORK_ERROR", "WordPress request failed (network error)."));
      });

      req.on("close", () => clearTimeout(timer));

      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}

/** Parses the target's own public_id out of PublishingExecutionService's own `publishing:{targetPublicId}:attempt:{n}` operationToken shape (Phase 9.3, unchanged) — never generates a new token here (Part Q). Falls back to the whole token if the expected shape isn't found, so reconciliation degrades safely rather than throwing. */
function extractTargetKey(operationToken: string): string {
  const match = /^publishing:([^:]+):attempt:/.exec(operationToken);
  return match ? match[1] : operationToken;
}
