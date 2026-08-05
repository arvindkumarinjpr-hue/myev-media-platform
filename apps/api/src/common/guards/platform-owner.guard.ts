import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthenticatedRequest } from "./session.guard";

/**
 * Module 1C Engineering Plan §2.A′: workspace creation is gated by the
 * single, global Platform Owner flag, not by any workspace-scoped
 * permission — there is no workspace yet to scope a permission against.
 * Deliberately independent of PermissionGuard/WorkspaceContextGuard: this
 * checks the caller's own `is_platform_owner` column directly, resolved
 * fresh from Postgres (not cached — this action is rare, not a hot path,
 * and its correctness matters more than shaving a query).
 */
@Injectable()
export class PlatformOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Authentication required." });
    }

    const user = await this.prisma.user.findFirst({
      where: { publicId: request.user.sub, deletedAt: null },
    });
    if (!user?.isPlatformOwner) {
      throw new ForbiddenException({ code: "NOT_PLATFORM_OWNER", message: "Only the Platform Owner may perform this action." });
    }
    return true;
  }
}
