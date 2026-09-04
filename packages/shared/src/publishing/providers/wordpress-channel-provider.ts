import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import type {
  PublishingChannelCapabilities,
  PublishingChannelProvider,
  PublishingConnectionCheckInput,
  PublishingConnectionValidationResult,
  PublishingPublishInput,
  PublishingPublishResult,
} from "../publishing-provider.interface";
import { assertSafePublishingSiteUrl, isSafePublishingRedirectTarget, UnsafePublishingSiteUrlError } from "../publishing-site-url-safety";
import { parseWordPressCredential, type WordPressCredentialPayload } from "./wordpress-credential";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB — a WordPress REST post/user response never legitimately needs to be larger.

export interface WordPressChannelProviderOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test-only escape hatch for a local fixture HTTP server — never the production default (see publishing-site-url-safety.ts). */
  allowLocalTestTarget?: boolean;
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

  constructor(options: WordPressChannelProviderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.allowLocalTestTarget = options.allowLocalTestTarget ?? false;
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
   * The one focused HTTP client this class uses (Part N) — bounded
   * timeout, a manual, safety-checked, bounded redirect loop (never
   * `redirect: "follow"`), a response-size guard, and curated/sanitized
   * errors only. The Basic Auth header (built from the application
   * password) is never logged, and no raw fetch/DOM exception ever
   * propagates past this method.
   */
  private async request(credential: WordPressCredentialPayload, method: "GET" | "POST", path: string, body?: unknown): Promise<WordPressRequestResult> {
    let target = assertSafePublishingSiteUrl(credential.siteUrl, { allowLocalTestTarget: this.allowLocalTestTarget });
    const authHeader = `Basic ${Buffer.from(`${credential.username}:${credential.applicationPassword}`).toString("base64")}`;

    for (let redirects = 0; ; redirects++) {
      const url = `${target}/wp-json/wp/v2/${path}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: authHeader,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        const message = err instanceof Error && err.name === "AbortError" ? "WordPress request timed out." : "WordPress request failed (network error).";
        throw new PublishingProviderRetryableError("WORDPRESS_NETWORK_ERROR", message);
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new PublishingProviderPermanentError("WORDPRESS_MALFORMED_RESPONSE", "WordPress returned a redirect with no Location header.");
        if (redirects >= this.maxRedirects) throw new PublishingProviderPermanentError("WORDPRESS_TOO_MANY_REDIRECTS", "WordPress redirected too many times.");
        const resolved = new URL(location, url).toString();
        if (!isSafePublishingRedirectTarget(resolved, { allowLocalTestTarget: this.allowLocalTestTarget })) {
          throw new PublishingProviderPermanentError("WORDPRESS_UNSAFE_REDIRECT", "WordPress redirected to a disallowed target.");
        }
        target = resolved.replace(/\/wp-json\/wp\/v2\/.*$/, "");
        continue;
      }

      const text = await this.readBoundedText(response);
      let json: unknown;
      try {
        json = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        // A non-JSON body (e.g. an HTML error page from a
        // misconfigured site) is a malformed response, not a parse
        // crash — status is still reported so the caller can classify it.
        json = undefined;
      }
      return { status: response.status, json };
    }
  }

  private async readBoundedText(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return response.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new PublishingProviderPermanentError("WORDPRESS_RESPONSE_TOO_LARGE", "WordPress response exceeded the maximum allowed size.");
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  }
}

/** Parses the target's own public_id out of PublishingExecutionService's own `publishing:{targetPublicId}:attempt:{n}` operationToken shape (Phase 9.3, unchanged) — never generates a new token here (Part Q). Falls back to the whole token if the expected shape isn't found, so reconciliation degrades safely rather than throwing. */
function extractTargetKey(operationToken: string): string {
  const match = /^publishing:([^:]+):attempt:/.exec(operationToken);
  return match ? match[1] : operationToken;
}
