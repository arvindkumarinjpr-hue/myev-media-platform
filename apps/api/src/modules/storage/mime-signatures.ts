/**
 * Magic-byte format definitions for confirmation-time MIME verification
 * (Module 1D Engineering Plan §6). Bounded, prefix-only inspection — never
 * a full-object read. Fail-closed everywhere: an unrecognized or
 * ambiguous signature is never treated as a pass.
 */

import type { MediaAssetType } from "../../../generated/prisma";

interface FormatSignature {
  mimeType: string;
  match: (buf: Buffer) => boolean;
}

function bytesAt(buf: Buffer, offset: number, expected: number[]): boolean {
  if (buf.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buf[offset + i] !== expected[i]) return false;
  }
  return true;
}

function asciiAt(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  return buf.toString("ascii", offset, offset + text.length) === text;
}

// Executable/polyglot deny-list — checked FIRST, always, independent of
// declared assetType or the allowlist below. A match here rejects
// immediately. See plan §6 "executable/polyglot handling".
const EXECUTABLE_SIGNATURES: Array<{ name: string; match: (buf: Buffer) => boolean }> = [
  { name: "windows_pe", match: (b) => bytesAt(b, 0, [0x4d, 0x5a]) }, // "MZ"
  { name: "elf", match: (b) => bytesAt(b, 0, [0x7f, 0x45, 0x4c, 0x46]) },
  { name: "macho_32_le", match: (b) => bytesAt(b, 0, [0xfe, 0xed, 0xfa, 0xce]) },
  { name: "macho_64_le", match: (b) => bytesAt(b, 0, [0xfe, 0xed, 0xfa, 0xcf]) },
  { name: "macho_32_be", match: (b) => bytesAt(b, 0, [0xce, 0xfa, 0xed, 0xfe]) },
  { name: "macho_64_be", match: (b) => bytesAt(b, 0, [0xcf, 0xfa, 0xed, 0xfe]) },
  { name: "macho_universal", match: (b) => bytesAt(b, 0, [0xca, 0xfe, 0xba, 0xbe]) },
  { name: "shebang", match: (b) => bytesAt(b, 0, [0x23, 0x21]) }, // "#!"
];

export function matchesExecutableSignature(buf: Buffer): string | null {
  const hit = EXECUTABLE_SIGNATURES.find((sig) => sig.match(buf));
  return hit ? hit.name : null;
}

function isIsoBmffContainer(buf: Buffer): boolean {
  // ISO Base Media File Format (mp4/m4a/mov's modern variant): a box size
  // (4 bytes) followed by "ftyp" at offset 4.
  if (asciiAt(buf, 4, "ftyp")) return true;
  // Legacy QuickTime .mov without an ftyp box.
  if (asciiAt(buf, 4, "moov") || asciiAt(buf, 4, "mdat") || asciiAt(buf, 4, "wide")) return true;
  return false;
}

function isoBmffBrand(buf: Buffer): string | null {
  if (!asciiAt(buf, 4, "ftyp")) return null;
  return buf.toString("ascii", 8, 12).trim();
}

const QUICKTIME_BRANDS = new Set(["qt  ", "qt"]);

// The MP4 container family (ISO-BMFF) cannot be reliably split into
// "audio/mp4" vs "video/mp4" from the container-level signature alone
// without parsing internal boxes — both use an identical ftyp-box scheme.
// SIGNATURES below intentionally returns BOTH candidate mime types for an
// ISO-BMFF match; the caller narrows using the declared assetType's
// allowlist (see mime-sniffer.ts). This is a documented, honest
// limitation, not a silent gap.
const SIGNATURES: FormatSignature[] = [
  { mimeType: "image/jpeg", match: (b) => bytesAt(b, 0, [0xff, 0xd8, 0xff]) },
  { mimeType: "image/png", match: (b) => bytesAt(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mimeType: "image/gif", match: (b) => asciiAt(b, 0, "GIF8") },
  { mimeType: "image/webp", match: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP") },
  { mimeType: "audio/wav", match: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WAVE") },
  { mimeType: "audio/ogg", match: (b) => asciiAt(b, 0, "OggS") },
  // ID3-tagged MP3, or a bare frame sync (0xFFFB/0xFFF3/0xFFF2 family).
  {
    mimeType: "audio/mpeg",
    match: (b) => asciiAt(b, 0, "ID3") || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0x00),
  },
  { mimeType: "video/quicktime", match: (b) => isIsoBmffContainer(b) && QUICKTIME_BRANDS.has(isoBmffBrand(b) ?? "") },
  { mimeType: "video/webm", match: (b) => bytesAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
  { mimeType: "application/pdf", match: (b) => asciiAt(b, 0, "%PDF-") },
];

export interface SniffResult {
  matched: boolean;
  mimeType: string | null;
  isAmbiguousMp4Family: boolean;
}

export function sniffMimeType(buf: Buffer): SniffResult {
  if (isIsoBmffContainer(buf)) {
    const brand = isoBmffBrand(buf) ?? "";
    if (!QUICKTIME_BRANDS.has(brand)) {
      // Ambiguous between audio/mp4 and video/mp4 — see comment above.
      // Caller resolves using the declared assetType.
      return { matched: true, mimeType: null, isAmbiguousMp4Family: true };
    }
  }
  const hit = SIGNATURES.find((sig) => sig.match(buf));
  if (hit) return { matched: true, mimeType: hit.mimeType, isAmbiguousMp4Family: false };
  return { matched: false, mimeType: null, isAmbiguousMp4Family: false };
}

// Per-assetType allowlist — see plan §6. DOCUMENT is intentionally
// PDF-only in Module 1D: ZIP-based office formats (docx/xlsx/pptx) are
// indistinguishable from a bare ZIP via magic bytes alone without deeper
// structural parsing, so rather than accept them ambiguously, they're
// out of scope until real structural verification is added.
export const ALLOWED_MIME_BY_ASSET_TYPE: Record<MediaAssetType, string[]> = {
  IMAGE: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  AUDIO: ["audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg"],
  VIDEO: ["video/mp4", "video/quicktime", "video/webm"],
  DOCUMENT: ["application/pdf"],
  // Module 7 Phase 7.4 — generated caption documents. Plain-text formats,
  // verified structurally (see verifySubtitleBytes) rather than by magic
  // bytes.
  SUBTITLE: ["text/vtt", "application/x-subrip"],
};

// Extension <-> declared-MIME compatibility (soft check at intent time,
// hard check — against the SNIFFED mime — at finalize time).
export const EXTENSION_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".vtt": "text/vtt",
  ".srt": "application/x-subrip",
};

/**
 * Module 7 Phase 7.4 — subtitle content is UTF-8 text with a recognisable
 * structure, not a magic-byte format. Fail-closed: returns the verified
 * MIME only when the bytes genuinely look like the format they claim.
 *  - VTT: must begin with the "WEBVTT" signature line.
 *  - SRT: must contain a "HH:MM:SS,mmm --> HH:MM:SS,mmm" cue line.
 * Rejects (returns null) anything containing NUL bytes or an executable
 * signature.
 */
export function verifySubtitleBytes(buf: Buffer, declaredMime: string): string | null {
  if (matchesExecutableSignature(buf)) return null;
  if (buf.includes(0x00)) return null;
  const text = buf.toString("utf8");
  if (text.length === 0) return null;
  const looksVtt = /^\uFEFF?WEBVTT(\s|$)/.test(text);
  const looksSrt = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(text);
  if (declaredMime === "text/vtt" && looksVtt) return "text/vtt";
  if (declaredMime === "application/x-subrip" && looksSrt) return "application/x-subrip";
  return null;
}

/**
 * Resolves a sniff result against the declared assetType, handling the
 * MP4-family ambiguity. Returns the verified MIME type, or null if the
 * bytes don't match anything acceptable for this assetType — the caller
 * treats null as a rejection, never a guess.
 */
export function resolveVerifiedMimeType(sniff: SniffResult, assetType: MediaAssetType): string | null {
  const allowed = ALLOWED_MIME_BY_ASSET_TYPE[assetType];
  if (sniff.isAmbiguousMp4Family) {
    const candidate = assetType === "VIDEO" ? "video/mp4" : assetType === "AUDIO" ? "audio/mp4" : null;
    return candidate && allowed.includes(candidate) ? candidate : null;
  }
  if (!sniff.matched || !sniff.mimeType) return null;
  return allowed.includes(sniff.mimeType) ? sniff.mimeType : null;
}
