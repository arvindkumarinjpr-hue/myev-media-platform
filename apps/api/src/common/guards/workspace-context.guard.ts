import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../prisma/prisma.service";
import { ALLOW_ARCHIVED_WORKSPACE_KEY } from "../decorators/allow-archived-workspace.decorator";
import type { AuthenticatedRequest } from "./session.guard";

const WORKSPACE_HEADER = "x-workspace-id";

export interface WorkspaceContext {
  /** Internal primary key — used for every DB query. */
  id: string;
  publicId: string;
  /** Internal primary key of the caller within this workspace. */
  membershipId: string;
  /** Internal primary key of the caller (translated once here from the JWT's publicId, see the module comment below). */
  userInternalId: string;
  roleName: string;
}

export interface WorkspaceScopedRequest extends AuthenticatedRequest {
  workspace: WorkspaceContext;
}

/**
 * Module 1C Engineering Plan §2.B/§2.D. Resolves `X-Workspace-Id` (a
 * workspace publicId) to a real, ACTIVE workspace the caller is an ACTIVE
 * member of, and attaches the result as `request.workspace` for
 * `PermissionGuard` and controllers (`@CurrentWorkspace()`) to read.
 *
 * Runs after SessionGuard, before PermissionGuard, on every workspace-
 * scoped route — there is no route that reaches a handler needing
 * workspace context without this guard having validated it first.
 *
 * Enumeration-safe throughout: a caller who isn't an ACTIVE member gets
 * 404, identical to the workspace not existing — never 403, which would
 * confirm existence to someone who can't see into it.
 *
 * SessionGuard only ever decodes the JWT (`request.user.sub` is the
 * caller's publicId, never the internal id `workspace_members.user_id`
 * needs) — this guard is therefore also the one place that translates
 * publicId -> internal id for the current request, since no earlier stage
 * in the pipeline has a reason to.
 */
@Injectable()
export class WorkspaceContextGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const workspacePublicId = request.headers[WORKSPACE_HEADER] as string | undefined;
    if (!workspacePublicId) {
      throw new NotFoundException({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found." });
    }

    const workspace = await this.prisma.workspace.findFirst({
      where: { publicId: workspacePublicId, deletedAt: null },
    });
    if (!workspace) {
      throw new NotFoundException({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found." });
    }

    const allowArchived = this.reflector.get<boolean | undefined>(ALLOW_ARCHIVED_WORKSPACE_KEY, context.getHandler());
    if (workspace.status === "ARCHIVED" && !allowArchived) {
      throw new ForbiddenException({ code: "WORKSPACE_ARCHIVED", message: "This workspace is archived." });
    }

    const user = await this.prisma.user.findFirst({ where: { publicId: request.user.sub, deletedAt: null } });
    if (!user) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Session user not found." });
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    });
    if (!membership || membership.status !== "ACTIVE") {
      // Includes PENDING_ACTIVATION, SUSPENDED, REMOVED, and no membership
      // at all — every one of those must be indistinguishable from
      // "workspace doesn't exist" to the caller.
      throw new NotFoundException({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found." });
    }

    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: membership.roleId } });

    (request as WorkspaceScopedRequest).workspace = {
      id: workspace.id,
      publicId: workspace.publicId,
      membershipId: membership.id,
      userInternalId: user.id,
      roleName: role.name,
    };
    return true;
  }
}
