/**
 * Module 9 Phase 9.4 — a dedicated, framework-free safe-target validator
 * for any publishing connector that performs outbound HTTP to a user-
 * configured URL (WordPress today; any future self-hosted-style channel
 * later). No such utility existed anywhere in this codebase before this
 * phase (confirmed by repository search) — this is new, focused code,
 * not a reused precedent.
 *
 * Scope: hostname/literal-IP pattern matching against the well-known
 * private/loopback/link-local ranges, plus basic URL-shape hygiene
 * (scheme, embedded credentials). Deliberately does NOT perform DNS
 * resolution or connection-pinning to defend against DNS-rebinding
 * attacks (a real, distinct hardening concern) — that is out of this
 * phase's scope and documented as technical debt, not silently assumed
 * solved.
 */

export class UnsafePublishingSiteUrlError extends Error {
  constructor(
    public readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafePublishingSiteUrlError";
  }
}

export interface SiteUrlSafetyOptions {
  /**
   * A single, explicit, test-only escape hatch (Part E: "allow it ONLY
   * through explicit test configuration, never production default") for
   * pointing a connector at a local fixture HTTP server — relaxes BOTH
   * the HTTPS-scheme requirement AND the private/loopback/link-local
   * host rejection together, since a local fixture server is
   * necessarily both `http://` and a loopback/private address. There is
   * deliberately no way to relax only one of the two independently —
   * a real production siteUrl is never allowed to be either insecure or
   * private, so no caller ever has a legitimate reason to need a
   * finer-grained combination.
   */
  allowLocalTestTarget?: boolean;
}

const IPV4_OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4_PATTERN = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

function isLoopbackIpv4(host: string): boolean {
  const match = IPV4_PATTERN.exec(host);
  return match ? Number(match[1]) === 127 : false;
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const match = IPV4_PATTERN.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 127) return true; // loopback (127.0.0.0/8)
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local (also cloud metadata endpoints)
  if (a === 0) return true; // "this network"
  return false;
}

function isPrivateOrReservedIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique local (fc00::/7)

  // IPv4-mapped IPv6 — Node's URL parser normalizes the embedded address
  // into two trailing hex groups (e.g. "::ffff:127.0.0.1" becomes
  // "::ffff:7f00:1", not the dotted-decimal form), so the embedded
  // address must be reconstructed from those hex groups rather than
  // string-matched.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    const embedded = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
    return isPrivateOrReservedIpv4(embedded);
  }
  // Also accept the (less common, but URL-legal) literal dotted-decimal
  // form some inputs may already carry pre-normalization.
  if (normalized.startsWith("::ffff:") && IPV4_PATTERN.test(normalized.slice("::ffff:".length))) {
    return isPrivateOrReservedIpv4(normalized.slice("::ffff:".length));
  }
  return false;
}

/**
 * True only for loopback (127.0.0.0/8, ::1, and their IPv4-mapped-IPv6
 * equivalents) — the one address class `allowLocalTestTarget` is scoped
 * to bypass (see its own doc comment). Deliberately narrower than
 * `isPrivateOrReservedIpv4`/`isPrivateOrReservedIpv6`: RFC1918, link-local
 * (169.254.0.0/16 — cloud metadata endpoints live here), and IPv6
 * unique-local addresses are NOT loopback and must stay rejected even in
 * test mode, or a malicious/misconfigured redirect during a test run
 * could silently reach a real private-network target.
 */
function isLoopbackAddress(host: string): boolean {
  if (isLoopbackIpv4(host)) return true;
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    const embedded = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
    return isLoopbackIpv4(embedded);
  }
  if (normalized.startsWith("::ffff:") && IPV4_PATTERN.test(normalized.slice("::ffff:".length))) {
    return isLoopbackIpv4(normalized.slice("::ffff:".length));
  }
  return false;
}

const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localdomain"];
const BLOCKED_HOSTNAMES = new Set(["localhost"]);

/**
 * Validates and normalizes a user-configured WordPress `siteUrl` before
 * it is ever used as an outbound HTTP target. Throws
 * `UnsafePublishingSiteUrlError` on any rejection — never returns a
 * partially-validated result. Returns the normalized (trailing-slash-
 * stripped) URL string on success.
 */
export function assertSafePublishingSiteUrl(rawUrl: string, options: SiteUrlSafetyOptions = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafePublishingSiteUrlError("SITE_URL_MALFORMED", "The configured site URL is not a valid URL.");
  }

  if (parsed.protocol !== "https:" && !(options.allowLocalTestTarget && parsed.protocol === "http:")) {
    throw new UnsafePublishingSiteUrlError("SITE_URL_INSECURE_SCHEME", "The configured site URL must use HTTPS.");
  }

  if (parsed.username || parsed.password) {
    throw new UnsafePublishingSiteUrlError("SITE_URL_EMBEDDED_CREDENTIALS", "The configured site URL must not contain embedded credentials.");
  }

  {
    const hostname = parsed.hostname.toLowerCase();
    const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

    if (!options.allowLocalTestTarget) {
      if (BLOCKED_HOSTNAMES.has(bareHost) || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => bareHost.endsWith(suffix))) {
        throw new UnsafePublishingSiteUrlError("SITE_URL_PRIVATE_HOST", "The configured site URL points at a disallowed local/internal host.");
      }
    }

    if (isPrivateOrReservedIpv4(bareHost) || isPrivateOrReservedIpv6(bareHost)) {
      // Under allowLocalTestTarget, only loopback is exempt — a local
      // fixture server binds to 127.0.0.1, never to an RFC1918 or
      // link-local address, so any other private/reserved target
      // (including cloud-metadata-style 169.254.0.0/16 addresses reached
      // via a redirect) stays rejected even in test mode.
      if (!(options.allowLocalTestTarget && isLoopbackAddress(bareHost))) {
        throw new UnsafePublishingSiteUrlError("SITE_URL_PRIVATE_HOST", "The configured site URL points at a private/reserved network address.");
      }
    }
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${normalizedPath}`;
}

/** Used by a provider's own bounded-redirect-following loop (never `redirect: "follow"`) to validate each hop's target before following it — the identical check `assertSafePublishingSiteUrl` performs on the original configured URL. */
export function isSafePublishingRedirectTarget(rawUrl: string, options: SiteUrlSafetyOptions = {}): boolean {
  try {
    assertSafePublishingSiteUrl(rawUrl, options);
    return true;
  } catch {
    return false;
  }
}
