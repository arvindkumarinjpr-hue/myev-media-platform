import type { MediaAssetType } from "../../../generated/prisma";

/**
 * Never used as or interpolated into the object key — display-only. Strips
 * path separators and control characters, caps length. Module 1D
 * Engineering Plan §8 "Security Model" / base-round entity model.
 */
export function normalizeFilename(originalFilename: string): string {
  const stripped = originalFilename
    .replace(/[/\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim();
  const safe = stripped.length > 0 ? stripped : "file";
  return safe.slice(0, 180);
}

export function extractExtension(filename: string): string {
  const match = /\.[a-zA-Z0-9]+$/.exec(filename);
  return match ? match[0].toLowerCase() : "";
}

/**
 * Canonical, workspace-prefixed, non-guessable key. `assetId` is
 * generated in application code (not DB-default) specifically so it's
 * available here before the row is inserted. Prevents path traversal
 * (every dynamic segment is a UUID or a fixed enum value, never raw user
 * input), cross-workspace substitution (workspace segment is always the
 * caller's own, server-derived), filename collision, and overwrite (each
 * version gets its own key — never reused).
 */
export function buildObjectKey(input: {
  workspacePublicId: string;
  projectPublicId: string | null;
  assetType: MediaAssetType;
  assetId: string;
  versionNumber: number;
  normalizedFilename: string;
}): string {
  const projectSegment = input.projectPublicId ?? "unassigned";
  return [
    "workspaces",
    input.workspacePublicId,
    "projects",
    projectSegment,
    input.assetType.toLowerCase(),
    input.assetId,
    String(input.versionNumber),
    input.normalizedFilename,
  ].join("/");
}
