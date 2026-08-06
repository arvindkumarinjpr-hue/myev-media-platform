import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_PERMISSION_KEY } from "../decorators/require-permission.decorator";
import { PERMISSION_RESOLVER, type PermissionResolver } from "../../modules/rbac/permission-resolver.interface";
import type { PermissionConstant } from "../../modules/rbac/permissions.constants";
import type { AuthenticatedRequest } from "./session.guard";
import type { WorkspaceScopedRequest } from "./workspace-context.guard";

/**
 * Reusable RBAC enforcement (Module 1B.1 Engineering Plan §8). Requires
 * SessionGuard, then WorkspaceContextGuard, to have already run — the
 * latter resolves and validates `request.workspace` (Module 1C), which
 * this guard reads directly rather than re-parsing the `X-Workspace-Id`
 * header itself. Any route using @RequirePermission must apply
 * WorkspaceContextGuard ahead of this one.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PERMISSION_RESOLVER) private readonly permissionResolver: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<PermissionConstant[] | undefined>(REQUIRE_PERMISSION_KEY, context.getHandler());
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Authentication required." });
    }

    const workspaceId = (request as Partial<WorkspaceScopedRequest>).workspace?.id ?? null;
    const granted = await this.permissionResolver.resolve(request.user.sub, workspaceId);
    const missing = required.filter((permission) => !granted.includes(permission));
    if (missing.length > 0) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: `Missing required permission(s): ${missing.join(", ")}.` });
    }
    return true;
  }
}
