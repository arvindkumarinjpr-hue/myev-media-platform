import { Injectable } from "@nestjs/common";
import type { PermissionConstant } from "./permissions.constants";
import type { PermissionResolver } from "./permission-resolver.interface";

/**
 * Placeholder resolver for Module 1B.1: no workspace-scoped role
 * assignment exists yet, so every check correctly resolves to "no
 * permissions." Nothing in 1B.1's own endpoint inventory depends on this
 * returning anything else — see Module 1B.1 Engineering Plan §8.
 */
@Injectable()
export class NoAssignmentPermissionResolver implements PermissionResolver {
  async resolve(_userId: string, _workspaceId: string | null): Promise<PermissionConstant[]> {
    return [];
  }
}
