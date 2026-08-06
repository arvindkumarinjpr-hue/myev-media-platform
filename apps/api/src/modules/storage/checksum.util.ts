/**
 * Module 1D Engineering Plan §6 "Checksum Input Format": exactly 64 hex
 * characters; canonical storage is lowercase; uppercase/mixed case is
 * normalized, not rejected; malformed values are rejected outright.
 */
const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

export function normalizeExpectedChecksum(input: string): string | null {
  if (!SHA256_HEX_PATTERN.test(input)) return null;
  return input.toLowerCase();
}

// Debug/diagnostic logs must never carry the full value (plan §6) — full
// values are only ever written to the access-controlled audit_logs table.
export function truncateChecksumForLogging(checksum: string): string {
  return `${checksum.slice(0, 8)}...`;
}
