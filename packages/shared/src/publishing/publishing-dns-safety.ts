import { isIP } from "node:net";
import { promises as dnsPromises } from "node:dns";
import { isLoopbackAddress, isPrivateOrReservedIpv4, isPrivateOrReservedIpv6 } from "./publishing-site-url-safety";

/**
 * Module 9 Phase 9.4 Pre-Merge Security Correction — closes the DNS-
 * rebinding gap `publishing-site-url-safety.ts` explicitly documented as
 * technical debt: hostname validation and the actual socket connection
 * can resolve DNS at different times, so a hostname that validates
 * safely could rebind to a private/link-local address before the TCP
 * connection is made.
 *
 * The fix is NOT "validate, then let `fetch` resolve DNS again" (that is
 * exactly the TOCTOU gap). Instead this module resolves the hostname
 * itself (all A + AAAA records), validates every single returned
 * address, and hands the caller a Node-compatible `lookup` function that
 * IS the resolution mechanism `http.request`/`https.request`/`net.connect`
 * use internally — so the real socket connects to exactly the address
 * this module already validated, and no second, uncontrolled DNS lookup
 * ever happens. Verified empirically (not just by inspection) against a
 * real HTTPS host: a custom `lookup` is invoked exactly once by Node's
 * own connection machinery, and the TCP connection genuinely uses
 * whatever address that function returns — confirmed both by a
 * successful TLS handshake against the real address and by a deliberate
 * ECONNREFUSED when the function is made to return a wrong one.
 *
 * Node's global `fetch` (undici) does not expose a stable, dependency-
 * free way to pin the resolved address for a single call — customizing
 * it would mean adding `undici` as an explicit dependency to reimplement
 * something `node:http`/`node:https` already do natively. Per the
 * "smallest repository-compatible implementation, no large HTTP
 * framework" instruction, `wordpress-channel-provider.ts` instead uses
 * `node:http`/`node:https` directly for its transport, with the `lookup`
 * this module produces.
 *
 * Framework-free — no Prisma, no NestJS, only Node built-ins.
 */

export class UnsafeResolvedAddressError extends Error {
  constructor(
    public readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafeResolvedAddressError";
  }
}

export interface DnsSafetyOptions {
  /** Identical meaning to `SiteUrlSafetyOptions.allowLocalTestTarget` (publishing-site-url-safety.ts) — scoped to loopback only, applied here to the RESOLVED address rather than the configured URL's literal host. Never a production default. */
  allowLocalTestTarget?: boolean;
  /**
   * Test-only DNS resolver injection (Part G: "use injectable/test DNS
   * resolver... if needed for deterministic tests"). Defaults to the
   * real `node:dns` promises API. Never used to bypass validation itself
   * — only to control what a fake hostname "resolves to" in a test,
   * so the real validation/pinning code path runs deterministically
   * without any actual DNS or network dependency.
   */
  resolvers?: DnsResolvers;
}

export interface DnsResolvers {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

const REAL_DNS_RESOLVERS: DnsResolvers = {
  resolve4: (hostname) => dnsPromises.resolve4(hostname),
  resolve6: (hostname) => dnsPromises.resolve6(hostname),
};

export interface ResolvedSafeAddress {
  address: string;
  family: 4 | 6;
}

function isSafeAddress(address: string, family: 4 | 6, allowLocalTestTarget: boolean): boolean {
  const unsafe = family === 4 ? isPrivateOrReservedIpv4(address) : isPrivateOrReservedIpv6(address);
  if (!unsafe) return true;
  // Identical loopback-only exemption as assertSafePublishingSiteUrl's
  // own private-host check — see that function's doc comment for why
  // the bypass is deliberately this narrow.
  return allowLocalTestTarget && isLoopbackAddress(address);
}

/** DNS lookup failures that mean "no such family" rather than a real error — tolerated per-family so a hostname with only AAAA records (or only A records) still resolves. */
function isNoDataError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT";
}

/**
 * Resolves `hostname` to every A + AAAA record, validates ALL of them,
 * and returns the full validated set — or throws `UnsafeResolvedAddressError`
 * if resolution fails outright, or if ANY returned address (even one
 * among a mix of otherwise-public addresses) is private/reserved. A
 * mixed public+private answer is rejected in its entirety, never
 * filtered down to "the public ones" — an attacker's DNS answer is not
 * a menu to pick the safe-looking option from.
 *
 * A literal IP `hostname` (no DNS involved at all) is validated
 * directly, the same rule applied.
 */
export async function resolveSafeConnectAddresses(hostname: string, options: DnsSafetyOptions = {}): Promise<ResolvedSafeAddress[]> {
  const allowLocalTestTarget = options.allowLocalTestTarget ?? false;
  const resolvers = options.resolvers ?? REAL_DNS_RESOLVERS;

  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isSafeAddress(hostname, literalFamily, allowLocalTestTarget)) {
      throw new UnsafeResolvedAddressError("DNS_RESOLVED_UNSAFE_ADDRESS", "The configured site URL's address is a private/reserved network address.");
    }
    return [{ address: hostname, family: literalFamily }];
  }

  const [v4Result, v6Result] = await Promise.allSettled([resolvers.resolve4(hostname), resolvers.resolve6(hostname)]);

  const addresses: ResolvedSafeAddress[] = [];
  if (v4Result.status === "fulfilled") {
    addresses.push(...v4Result.value.map((address): ResolvedSafeAddress => ({ address, family: 4 })));
  } else if (!isNoDataError(v4Result.reason)) {
    throw new UnsafeResolvedAddressError("DNS_RESOLUTION_FAILED", "Could not resolve the configured site URL's hostname (A).");
  }
  if (v6Result.status === "fulfilled") {
    addresses.push(...v6Result.value.map((address): ResolvedSafeAddress => ({ address, family: 6 })));
  } else if (!isNoDataError(v6Result.reason)) {
    throw new UnsafeResolvedAddressError("DNS_RESOLUTION_FAILED", "Could not resolve the configured site URL's hostname (AAAA).");
  }

  if (addresses.length === 0) {
    throw new UnsafeResolvedAddressError("DNS_RESOLUTION_FAILED", "The configured site URL's hostname did not resolve to any address.");
  }

  for (const { address, family } of addresses) {
    if (!isSafeAddress(address, family, allowLocalTestTarget)) {
      throw new UnsafeResolvedAddressError("DNS_RESOLVED_UNSAFE_ADDRESS", "The configured site URL's hostname resolved to a private/reserved network address.");
    }
  }

  return addresses;
}

/**
 * A Node `lookup`-option-compatible function (the same shape as
 * `dns.lookup`, which is what `http.request`/`net.connect` call by
 * default) backed by `resolveSafeConnectAddresses`. Passing this as
 * `{ lookup }` to `http.request`/`https.request` makes Node use ONLY
 * this function to resolve the hostname for the real socket connection
 * — there is no separate internal DNS step for Node to perform
 * independently, which is exactly what closes the TOCTOU gap.
 *
 * Node may invoke the callback in either of two shapes depending on
 * `options.all` (Happy Eyeballs / `autoSelectFamily` may request the
 * full address list) — both are handled here; either way, every address
 * handed back to Node has already passed `resolveSafeConnectAddresses`.
 * `host`/`servername` passed to `http.request`/`https.request` must
 * remain the ORIGINAL hostname string (never the resolved IP) for this
 * to also produce correct TLS SNI/certificate-hostname verification —
 * that is the caller's responsibility (see wordpress-channel-provider.ts).
 */
export function createSsrfSafeLookup(dnsOptions: DnsSafetyOptions = {}) {
  return (hostname: string, lookupOptions: { all?: boolean } | number, callback: (err: NodeJS.ErrnoException | null, address?: string | ResolvedSafeAddress[], family?: number) => void): void => {
    const wantsAll = typeof lookupOptions === "object" && lookupOptions !== null && lookupOptions.all === true;
    resolveSafeConnectAddresses(hostname, dnsOptions).then(
      (addresses) => {
        if (wantsAll) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
      (err: unknown) => {
        const errno: NodeJS.ErrnoException = err instanceof Error ? err : new Error(String(err));
        callback(errno);
      },
    );
  };
}
