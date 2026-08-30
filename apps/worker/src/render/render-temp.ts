import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";

/**
 * Module 7 Phase 7.5 — per-job isolated temp storage (checkpoint §28).
 * Every render job gets its own directory under a fixed, trusted root;
 * generated filenames are sanitized; no user-controlled path component
 * is ever joined. The directory is hard-deleted on success, failure,
 * timeout, or shutdown — never archived (FRD §21 storage table).
 */
export class RenderTempDir {
  private constructor(readonly path: string) {}

  static async create(root: string, jobPublicId: string, workspacePublicId: string): Promise<RenderTempDir> {
    const base = root && root.trim() ? resolve(root) : join(tmpdir(), "myev-render");
    // job-scoped + workspace-tagged, both sanitized to a hex/uuid charset.
    const safeJob = sanitizeId(jobPublicId);
    const safeWs = sanitizeId(workspacePublicId);
    const dir = join(base, `ws-${safeWs}`, `job-${safeJob}`);
    await fs.mkdir(dir, { recursive: true });
    return new RenderTempDir(dir);
  }

  /** Resolves a sanitized filename WITHIN this dir — rejects any traversal. */
  file(name: string): string {
    const safe = sanitizeFilename(name);
    const full = resolve(this.path, safe);
    if (!full.startsWith(resolve(this.path) + sep)) {
      throw new Error(`render temp: refusing path outside the job dir (${name})`);
    }
    return full;
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.path, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) || "unknown";
}

export function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[/\\]/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 128);
  return cleaned || "asset";
}
