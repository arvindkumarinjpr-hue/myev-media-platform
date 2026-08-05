import type { PermissionConstant } from "./permissions.constants";

/**
 * Resolves which permissions a user holds. In Module 1B.1 there is no
 * assignment mechanism yet — that's `workspace_members`, Module 1C's
 * table — so the only implementation registered here is a placeholder
 * that always returns no permissions. This interface exists now
 * specifically so 1C can supply a real implementation without redesigning
 * the guard (Module 1B.1 Engineering Plan §8).
 */
export interface PermissionResolver {
  resolve(userId: string, workspaceId: string | null): Promise<PermissionConstant[]>;
}

export const PERMISSION_RESOLVER = Symbol("PERMISSION_RESOLVER");
