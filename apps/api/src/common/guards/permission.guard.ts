import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_PERMISSION_KEY } from "../decorators/require-permission.decorator";
import { PERMISSION_RESOLVER, type PermissionResolver } from "../../modules/rbac/permission-resolver.interface";
import type { PermissionConstant } from "../../modules/rbac/permissions.constants";
import type { AuthenticatedRequest } from "./session.guard";

/**
 * Reusable RBAC enforcement (Module 1B.1 Engineering Plan §8). Requires
 * SessionGuard to have already run and populated `request.user` — apply
 * both guards together (SessionGuard first) on any future endpoint that
 * needs a specific permission, not just authentication.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PERMISSION_RESOLVER) private readonly permissionResolver: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<PermissionConstant | undefined>(REQUIRE_PERMISSION_KEY, context.getHandler());
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Authentication required." });
    }

    const workspaceId = (request.headers["x-workspace-id"] as string) ?? null;
    const granted = await this.permissionResolver.resolve(request.user.sub, workspaceId);
    if (!granted.includes(required)) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: `Missing required permission: ${required}.` });
    }
    return true;
  }
}
