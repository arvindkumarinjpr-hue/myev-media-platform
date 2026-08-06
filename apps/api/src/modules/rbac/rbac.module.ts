import { Global, Module } from "@nestjs/common";
import { PERMISSION_RESOLVER } from "./permission-resolver.interface";
import { WorkspaceMembershipPermissionResolver } from "./workspace-membership-permission-resolver";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { WorkspaceContextGuard } from "../../common/guards/workspace-context.guard";
import { PlatformOwnerGuard } from "../../common/guards/platform-owner.guard";
// Provided here rather than in its own home module (workspaces/) to avoid
// a circular import between RbacModule and WorkspacesModule — permission
// resolution is this cache's primary consumer, and RbacModule is already
// @Global(), which is what every future workspace-scoped module needs
// this cache to be anyway.
import { WorkspaceCacheService } from "../workspaces/workspace-cache.service";

/**
 * Module 1C Engineering Plan §2.E: NoAssignmentPermissionResolver (always
 * `[]`) is replaced by WorkspaceMembershipPermissionResolver — the real
 * implementation the placeholder existed to be swapped for. Nothing else
 * about this module's shape changes: same token, same guard, same
 * @Global() availability every 1B.1 caller already depends on.
 */
@Global()
@Module({
  providers: [
    { provide: PERMISSION_RESOLVER, useClass: WorkspaceMembershipPermissionResolver },
    PermissionGuard,
    WorkspaceContextGuard,
    PlatformOwnerGuard,
    WorkspaceCacheService,
  ],
  exports: [PERMISSION_RESOLVER, PermissionGuard, WorkspaceContextGuard, PlatformOwnerGuard, WorkspaceCacheService],
})
export class RbacModule {}
