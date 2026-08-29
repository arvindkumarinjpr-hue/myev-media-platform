/**
 * Module 7 Phase 7.4 — worker-side copy of apps/api's `object-key.util.ts`
 * (the worker cannot import apps/api). Same canonical, workspace-prefixed,
 * non-guessable scheme so an asset written by a processor is
 * indistinguishable from one uploaded through the browser.
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

export function buildObjectKey(input: {
  workspacePublicId: string;
  projectPublicId: string | null;
  assetType: string;
  assetId: string;
  versionNumber: number;
  normalizedFilename: string;
}): string {
  return [
    "workspaces",
    input.workspacePublicId,
    "projects",
    input.projectPublicId ?? "unassigned",
    input.assetType.toLowerCase(),
    input.assetId,
    String(input.versionNumber),
    input.normalizedFilename,
  ].join("/");
}
