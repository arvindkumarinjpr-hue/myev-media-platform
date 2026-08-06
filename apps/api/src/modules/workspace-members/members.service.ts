import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { WorkspaceMember } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AdaptiveProtectionService } from "../../common/rate-limit/adaptive-protection.service";
import { WorkspaceCacheService } from "../workspaces/workspace-cache.service";
import { InvitationActivationService } from "./invitation-activation.service";
import type { UpdateMemberDto } from "./dto/update-member.dto";

interface RequestContext {
  ipAddress?: string;
}

const RESEND_RATE_LIMIT = { perUserLimit: 5, perUserWindowSeconds: 3600, perWorkspaceLimit: 10, perWorkspaceWindowSeconds: 3600 };

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: WorkspaceCacheService,
    private readonly protection: AdaptiveProtectionService,
    private readonly activation: InvitationActivationService,
  ) {}

  /** Every status, including PENDING_ACTIVATION — visible to anyone who can view the workspace (Module 1C Engineering Plan §2.C: no separate hiding). */
  async list(workspaceId: string): Promise<WorkspaceMember[]> {
    const cached = await this.cache.getMembers<WorkspaceMember[]>(workspaceId);
    if (cached) return cached;

    const members = await this.prisma.workspaceMember.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
    await this.cache.setMembers(workspaceId, members);
    return members;
  }

  async updateMember(
    workspaceId: string,
    memberPublicId: string,
    callerUserId: string,
    dto: UpdateMemberDto,
    context: RequestContext,
  ): Promise<void> {
    const member = await this.prisma.workspaceMember.findFirst({ where: { publicId: memberPublicId, workspaceId } });
    if (!member) {
      throw new BadRequestException({ code: "MEMBER_NOT_FOUND", message: "Member not found." });
    }
    if (member.userId === callerUserId) {
      throw new ForbiddenException({ code: "CANNOT_MODIFY_SELF", message: "Use another Owner or Administrator to change your own membership." });
    }

    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    if (member.userId === workspace.ownerId) {
      throw new ForbiddenException({ code: "CANNOT_MODIFY_OWNER", message: "Transfer ownership before changing the Owner's membership." });
    }

    if (dto.roleName) {
      // No invitation or role-change endpoint may ever name Owner —
      // ASSIGNABLE_ROLE_NAMES (validated by the DTO) already excludes it,
      // so this is a defensive second check, not the primary enforcement.
      const role = await this.prisma.role.findUniqueOrThrow({ where: { name: dto.roleName } });
      await this.prisma.workspaceMember.update({ where: { id: member.id }, data: { roleId: role.id } });
      await this.audit.record({
        action: "WORKSPACE_MEMBER_ROLE_CHANGED",
        actorUserId: callerUserId,
        workspaceId,
        entityType: "workspace_member",
        entityId: member.publicId,
        ipAddress: context.ipAddress,
        afterState: { roleName: dto.roleName },
      });
    }

    if (dto.status) {
      await this.prisma.workspaceMember.update({ where: { id: member.id }, data: { status: dto.status } });
      await this.audit.record({
        action: "WORKSPACE_MEMBER_SUSPENDED",
        actorUserId: callerUserId,
        workspaceId,
        entityType: "workspace_member",
        entityId: member.publicId,
        ipAddress: context.ipAddress,
        afterState: { status: dto.status },
      });
    }

    await this.cache.invalidateForMembershipChange(workspaceId, member.userId);
  }

  async remove(workspaceId: string, memberPublicId: string, callerUserId: string, context: RequestContext): Promise<void> {
    const member = await this.prisma.workspaceMember.findFirst({ where: { publicId: memberPublicId, workspaceId } });
    if (!member) {
      throw new BadRequestException({ code: "MEMBER_NOT_FOUND", message: "Member not found." });
    }
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    if (member.userId === workspace.ownerId) {
      throw new ConflictException({ code: "CANNOT_REMOVE_OWNER", message: "Transfer ownership before removing the Owner." });
    }

    await this.prisma.workspaceMember.update({ where: { id: member.id }, data: { status: "REMOVED" } });
    await this.audit.record({
      action: "WORKSPACE_MEMBER_REMOVED",
      actorUserId: callerUserId,
      workspaceId,
      entityType: "workspace_member",
      entityId: member.publicId,
      ipAddress: context.ipAddress,
    });
    await this.cache.invalidateForMembershipChange(workspaceId, member.userId);
  }

  async leave(workspaceId: string, callerUserId: string, context: RequestContext): Promise<void> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    if (workspace.ownerId === callerUserId) {
      throw new ConflictException({ code: "OWNER_CANNOT_LEAVE", message: "Transfer ownership before leaving this workspace." });
    }
    const membership = await this.prisma.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId, userId: callerUserId } },
    });
    await this.prisma.workspaceMember.update({ where: { id: membership.id }, data: { status: "REMOVED" } });
    await this.audit.record({
      action: "WORKSPACE_MEMBER_LEFT",
      actorUserId: callerUserId,
      workspaceId,
      entityType: "workspace_member",
      entityId: membership.publicId,
      ipAddress: context.ipAddress,
    });
    await this.cache.invalidateForMembershipChange(workspaceId, callerUserId);
  }

  /**
   * Module 1C Engineering Plan §3. Scoped entirely to the initiating
   * workspace: authorization, response, and audit trail here never expose
   * or depend on the target user's membership status in any other
   * workspace.
   */
  async resendActivation(
    workspaceId: string,
    workspacePublicId: string,
    workspaceName: string,
    memberPublicId: string,
    callerUserId: string,
    context: RequestContext,
  ): Promise<void> {
    const member = await this.prisma.workspaceMember.findFirst({ where: { publicId: memberPublicId, workspaceId } });
    if (!member || member.status !== "PENDING_ACTIVATION") {
      throw new ConflictException({ code: "MEMBER_NOT_PENDING_ACTIVATION", message: "This member is not pending activation." });
    }

    const perUser = await this.protection.checkRateLimit(
      `resend-activation:user:${member.userId}`,
      RESEND_RATE_LIMIT.perUserLimit,
      RESEND_RATE_LIMIT.perUserWindowSeconds,
    );
    const perWorkspace = await this.protection.checkRateLimit(
      `resend-activation:workspace:${workspaceId}:member:${member.userId}`,
      RESEND_RATE_LIMIT.perWorkspaceLimit,
      RESEND_RATE_LIMIT.perWorkspaceWindowSeconds,
    );
    if (!perUser.allowed || !perWorkspace.allowed) {
      throw new HttpException({ code: "RATE_LIMITED", message: "Too many resend requests. Try again later." }, HttpStatus.TOO_MANY_REQUESTS);
    }

    await this.activation.issueActivationToken(member.userId, {
      initiatingWorkspacePublicId: workspacePublicId,
      workspaceNameForEmail: workspaceName,
      reason: "explicit_resend",
    });

    await this.audit.record({
      action: "WORKSPACE_MEMBER_ACTIVATION_RESENT",
      actorUserId: callerUserId,
      workspaceId,
      entityType: "workspace_member",
      entityId: member.publicId,
      ipAddress: context.ipAddress,
    });
  }
}
