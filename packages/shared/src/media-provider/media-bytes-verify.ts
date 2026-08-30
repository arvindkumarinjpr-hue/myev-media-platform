/**
 * Module 7 Phase 7.4 — minimal fail-closed magic-byte verification for
 * WORKER-ORIGINATED media bytes. The worker cannot import apps/api's
 * `mime-signatures.ts`; this is the small subset the MEDIA processors
 * need before an asset is persisted ACTIVE. Fail-closed: an unrecognized
 * or contradictory signature returns null (rejection), never a guess.
 */
export type VerifiableAssetType = "IMAGE" | "AUDIO" | "SUBTITLE" | "VIDEO";

function bytesAt(buf: Buffer, offset: number, expected: number[]): boolean {
  if (buf.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) if (buf[offset + i] !== expected[i]) return false;
  return true;
}
function asciiAt(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  return buf.toString("ascii", offset, offset + text.length) === text;
}

const EXECUTABLE_PREFIXES: Array<[string, number[]]> = [
  ["mz", [0x4d, 0x5a]],
  ["elf", [0x7f, 0x45, 0x4c, 0x46]],
  ["shebang", [0x23, 0x21]],
];

function looksExecutable(buf: Buffer): boolean {
  return EXECUTABLE_PREFIXES.some(([, sig]) => bytesAt(buf, 0, sig));
}

function sniffImage(buf: Buffer): string | null {
  if (bytesAt(buf, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytesAt(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (asciiAt(buf, 0, "GIF8")) return "image/gif";
  if (asciiAt(buf, 0, "RIFF") && asciiAt(buf, 8, "WEBP")) return "image/webp";
  return null;
}

function sniffAudio(buf: Buffer): string | null {
  if (asciiAt(buf, 0, "RIFF") && asciiAt(buf, 8, "WAVE")) return "audio/wav";
  if (asciiAt(buf, 0, "OggS")) return "audio/ogg";
  if (asciiAt(buf, 0, "ID3") || (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0x00)) return "audio/mpeg";
  return null;
}

function sniffVideo(buf: Buffer): string | null {
  // ISO base media file format: bytes 4..8 are the 'ftyp' box type.
  if (asciiAt(buf, 4, "ftyp")) return "video/mp4";
  // WebM / Matroska EBML header.
  if (bytesAt(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
}

function verifySubtitle(buf: Buffer, declaredMime: string): string | null {
  if (buf.includes(0x00)) return null;
  const text = buf.toString("utf8");
  const looksVtt = /^\uFEFF?WEBVTT(\s|$)/.test(text);
  const looksSrt = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(text);
  if (declaredMime === "text/vtt" && looksVtt) return "text/vtt";
  if (declaredMime === "application/x-subrip" && looksSrt) return "application/x-subrip";
  return null;
}

/** Returns the verified MIME type, or null (rejection). */
export function verifyMediaBytes(buf: Buffer, assetType: VerifiableAssetType, declaredMime: string): string | null {
  if (buf.length === 0) return null;
  if (looksExecutable(buf)) return null;
  if (assetType === "IMAGE") return sniffImage(buf);
  if (assetType === "AUDIO") return sniffAudio(buf);
  if (assetType === "VIDEO") return sniffVideo(buf);
  return verifySubtitle(buf, declaredMime);
}
