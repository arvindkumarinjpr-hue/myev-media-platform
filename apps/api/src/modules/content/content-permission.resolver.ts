import { Inject, Injectable } from "@nestjs/common";
import { PERMISSION_RESOLVER, type PermissionResolver } from "../rbac/permission-resolver.interface";
import { PERMISSIONS, type PermissionConstant } from "../rbac/permissions.constants";
import type { ContentType } from "../../../generated/prisma";

/**
 * Module 1E Engineering Plan §6 (RBAC): the `ContentType` enum has 6
 * values (BLOG/VIDEO/SHORT/REEL/NEWSLETTER/SOCIAL_POST — AI_CONTENT_
 * DATABASE_AND_ENTITY_DESIGN_V1.0.md §content_items) but only 2 permission
 * families existed at the time (BLOG_*, VIDEO_*). Module 1E deliberately
 * supported only BLOG and VIDEO; the other 4 were reserved for a later
 * module that would add its own permission constants and family mapping.
 *
 * Module 10 Phase 10.1 is that later module for SOCIAL_POST (SOCIAL_*,
 * see permissions.constants.ts). SHORT/REEL/NEWSLETTER remain reserved
 * and unsupported — `isSupportedContentType` stays the single source of
 * truth callers must check before reaching authorization, and it still
 * denies those three by default (no code path anywhere grants them).
 */
export type SupportedContentType = "BLOG" | "VIDEO" | "SOCIAL_POST";

export const SUPPORTED_CONTENT_TYPES: readonly SupportedContentType[] = ["BLOG", "VIDEO", "SOCIAL_POST"];

export function isSupportedContentType(contentType: ContentType): contentType is SupportedContentType {
  return contentType === "BLOG" || contentType === "VIDEO" || contentType === "SOCIAL_POST";
}

/**
 * The 4 actions this module's authorization model distinguishes. Every
 * editorial lifecycle transition collapses onto one of these:
 *  - create: initial content-item creation.
 *  - view: read a single item, list items, read versions/review history.
 *  - edit: update title/body/metadata, start, submit-for-review, archive,
 *    restore, delete, change featured media, change project/series.
 *  - approve: the review decision itself — approve AND reject both use
 *    this (same reviewing authority makes either call; the frozen
 *    AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's Create/Edit/Approve/
 *    Publish/Admin summary table has no separate "reject" column).
 * BLOG_REVIEW/VIDEO_REVIEW are pre-existing constants from the frozen
 * matrix that this module does not gate anything with — no role in the
 * matrix holds REVIEW without also holding APPROVE, and this module's
 * ContentReviewAction enum has no standalone "comment without deciding"
 * action for them to gate.
 */
export type ContentPermissionAction = "create" | "view" | "edit" | "approve";

const ACTION_PERMISSIONS: Record<ContentPermissionAction, Record<SupportedContentType, PermissionConstant>> = {
  create: { BLOG: PERMISSIONS.BLOG_CREATE, VIDEO: PERMISSIONS.VIDEO_CREATE, SOCIAL_POST: PERMISSIONS.SOCIAL_CREATE },
  view: { BLOG: PERMISSIONS.BLOG_VIEW, VIDEO: PERMISSIONS.VIDEO_VIEW, SOCIAL_POST: PERMISSIONS.SOCIAL_VIEW },
  edit: { BLOG: PERMISSIONS.BLOG_EDIT, VIDEO: PERMISSIONS.VIDEO_EDIT, SOCIAL_POST: PERMISSIONS.SOCIAL_EDIT },
  approve: { BLOG: PERMISSIONS.BLOG_APPROVE, VIDEO: PERMISSIONS.VIDEO_APPROVE, SOCIAL_POST: PERMISSIONS.SOCIAL_APPROVE },
};

/**
 * Dynamic, content-type-aware authorization (Module 1E Engineering Plan
 * §6). Deliberately NOT a static @RequirePermission decorator: which
 * permission a content-item route needs depends on the request body's (or
 * the resolved row's) actual `contentType`, known only after the type is
 * read — a decorator applied at the handler level has no access to that.
 * Callers (ContentItemsService, ContentSeriesService) invoke this
 * directly, after resolving `contentType` themselves.
 *
 * `userPublicId` matches the shape every other PermissionResolver caller
 * in this codebase uses (PermissionGuard, WorkspacesController) —
 * `request.user.sub` from the JWT, never the internal id.
 */
@Injectable()
export class ContentPermissionResolver {
  constructor(@Inject(PERMISSION_RESOLVER) private readonly permissionResolver: PermissionResolver) {}

  async can(userPublicId: string, workspaceId: string, action: ContentPermissionAction, contentType: ContentType): Promise<boolean> {
    if (!isSupportedContentType(contentType)) return false;
    const granted = await this.permissionResolver.resolve(userPublicId, workspaceId);
    return granted.includes(ACTION_PERMISSIONS[action][contentType]);
  }

  /**
   * List-endpoint filtering (Module 1E Engineering Plan §6): the caller's
   * viewable-type set, used to constrain the WHERE/count query on top of
   * any requested filter. An empty result means the 403 case — reject at
   * the call site when this returns [].
   */
  async getViewableContentTypes(userPublicId: string, workspaceId: string): Promise<SupportedContentType[]> {
    const granted = await this.permissionResolver.resolve(userPublicId, workspaceId);
    return SUPPORTED_CONTENT_TYPES.filter((type) => granted.includes(ACTION_PERMISSIONS.view[type]));
  }
}
