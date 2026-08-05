import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { WorkspaceCacheService } from "../workspaces/workspace-cache.service";
import type { PermissionConstant } from "./permissions.constants";
import type { PermissionResolver } from "./permission-resolver.interface";

/**
 * Module 1C Engineering Plan §2.E: the real implementation
 * NoAssignmentPermissionResolver was always a placeholder for. Resolves
 * (userPublicId, workspaceId) -> the caller's ACTIVE workspace_members role
 * -> its permissions via the existing role_permissions catalog. No
 * membership, or any non-ACTIVE status (PENDING_ACTIVATION, SUSPENDED,
 * REMOVED), resolves to an empty set — identically, no special-casing.
 *
 * `workspaceId` here is always the workspace's INTERNAL id (PermissionGuard
 * passes `request.workspace.id`, resolved by WorkspaceContextGuard, which
 * has already validated ACTIVE membership) — this resolver does not
 * re-validate the workspace's own status.
 */
@Injectable()
export class WorkspaceMembershipPermissionResolver implements PermissionResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: WorkspaceCacheService,
  ) {}

  async resolve(userPublicId: string, workspaceId: string | null): Promise<PermissionConstant[]> {
    if (!workspaceId) return [];

    const user = await this.prisma.user.findFirst({ where: { publicId: userPublicId, deletedAt: null } });
    if (!user) return [];

    const cached = await this.cache.getPermissions(workspaceId, user.id);
    if (cached) return cached as PermissionConstant[];

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (!membership || membership.status !== "ACTIVE") return [];

    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId: membership.roleId },
      include: { permission: true },
    });
    const permissions = rolePermissions.map((rp) => rp.permission.constant as PermissionConstant);

    await this.cache.setPermissions(workspaceId, user.id, permissions);
    return permissions;
  }
}
