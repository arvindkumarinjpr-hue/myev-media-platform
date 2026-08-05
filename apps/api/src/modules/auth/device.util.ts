import { createHash } from "crypto";

export interface DeviceMetadata {
  deviceName: string | null;
  browser: string | null;
  operatingSystem: string | null;
  platform: string | null;
}

const BROWSER_PATTERNS: [RegExp, string][] = [
  [/Edg\/([\d.]+)/, "Edge"],
  [/OPR\/([\d.]+)/, "Opera"],
  [/Chrome\/([\d.]+)/, "Chrome"],
  [/Firefox\/([\d.]+)/, "Firefox"],
  [/Version\/([\d.]+).*Safari/, "Safari"],
];

const OS_PATTERNS: [RegExp, string][] = [
  [/Windows NT ([\d.]+)/, "Windows"],
  [/Mac OS X ([\d_.]+)/, "macOS"],
  [/Android ([\d.]+)/, "Android"],
  [/OS ([\d_]+) like Mac OS X/, "iOS"],
  [/Linux/, "Linux"],
];

/**
 * Module 1B.1 Engineering Plan, Refinement 2: device metadata, persisted
 * for future session-management UI — no UI consumes this in Module 1B.
 * Deliberately a small hand-rolled parser (not a full UA-parsing library):
 * this is best-effort display data, not a security control, so a
 * proportionate amount of code is enough.
 */
export function parseDeviceMetadata(userAgent: string | undefined): DeviceMetadata {
  if (!userAgent) {
    return { deviceName: null, browser: null, operatingSystem: null, platform: null };
  }

  let browser: string | null = null;
  for (const [pattern, name] of BROWSER_PATTERNS) {
    const match = userAgent.match(pattern);
    if (match) {
      browser = `${name} ${match[1] ?? ""}`.trim();
      break;
    }
  }

  let operatingSystem: string | null = null;
  for (const [pattern, name] of OS_PATTERNS) {
    const match = userAgent.match(pattern);
    if (match) {
      operatingSystem = match[1] ? `${name} ${match[1].replace(/_/g, ".")}` : name;
      break;
    }
  }

  const isMobile = /Mobile|Android|iPhone/.test(userAgent);
  const isTablet = /Tablet|iPad/.test(userAgent);
  const platform = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";

  return { deviceName: null, browser, operatingSystem, platform };
}

/**
 * Module 1B.1 Engineering Plan, Refinement 3: server-computed session
 * fingerprint — an observability/anomaly signal only. It is NEVER checked
 * as an authentication requirement (a mismatch does not block a request);
 * it exists so a future risk-scoring pass (or a human investigating a
 * TOKEN_REUSE_DETECTED audit event) can see whether a refresh came from a
 * wildly different client than the one that created the session.
 *
 * `deviceFingerprint` (a client-supplied value, e.g. from a future
 * browser-side fingerprinting library) is intentionally not computed here
 * — no frontend exists yet to produce one. The column is reserved.
 */
export function computeSessionFingerprint(ipAddress: string | undefined, userAgent: string | undefined): string {
  const material = `${ipAddress ?? "unknown"}|${userAgent ?? "unknown"}`;
  return createHash("sha256").update(material).digest("hex");
}
