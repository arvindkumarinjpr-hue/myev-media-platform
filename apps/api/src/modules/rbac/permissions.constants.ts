/**
 * Canonical permission constants — verbatim from the frozen
 * AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md §Permission Categories.
 * No permission introduced here that isn't already in that document.
 */
export const PERMISSIONS = {
  WORKSPACE_VIEW: "WORKSPACE_VIEW",
  WORKSPACE_CREATE: "WORKSPACE_CREATE",
  WORKSPACE_UPDATE: "WORKSPACE_UPDATE",
  WORKSPACE_DELETE: "WORKSPACE_DELETE",
  // Module 1C: reversible archive/restore, deliberately distinct from
  // WORKSPACE_DELETE (irreversible, Owner-exclusive per FR-WS-001) and from
  // WORKSPACE_UPDATE (held by Administrator, who must NOT be able to
  // archive/restore under this module's design). See MODULE_1C_ENGINEERING
  // PLAN §5, "Missing constant identified."
  WORKSPACE_ARCHIVE: "WORKSPACE_ARCHIVE",

  PROJECT_VIEW: "PROJECT_VIEW",
  PROJECT_CREATE: "PROJECT_CREATE",
  PROJECT_UPDATE: "PROJECT_UPDATE",
  PROJECT_DELETE: "PROJECT_DELETE",

  KP_VIEW: "KP_VIEW",
  KP_CREATE: "KP_CREATE",
  KP_UPDATE: "KP_UPDATE",
  KP_DELETE: "KP_DELETE",
  // Module 2 Phase 2.1 (ACR-014): validation and successful activation
  // remain one Content-Manager-triggered operation (FRD §24.3) — no
  // separate KP_ACTIVATE. KP_ARCHIVE is distinct from KP_DELETE, which
  // remains Draft-only soft deletion.
  KP_VALIDATE: "KP_VALIDATE",
  KP_ARCHIVE: "KP_ARCHIVE",

  RESEARCH_RUN: "RESEARCH_RUN",
  RESEARCH_APPROVE: "RESEARCH_APPROVE",
  // Module 4 Phase 4.1: absent from the frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's
  // formal Permission Categories, same "Missing constant identified"
  // precedent as BLOG_VIEW/VIDEO_VIEW/AI_JOB_VIEW above — RESEARCH_RUN/
  // RESEARCH_APPROVE are both write/workflow actions with no plain read
  // permission among them.
  RESEARCH_VIEW: "RESEARCH_VIEW",

  BLOG_CREATE: "BLOG_CREATE",
  BLOG_EDIT: "BLOG_EDIT",
  BLOG_REVIEW: "BLOG_REVIEW",
  BLOG_APPROVE: "BLOG_APPROVE",
  BLOG_PUBLISH: "BLOG_PUBLISH",

  VIDEO_CREATE: "VIDEO_CREATE",
  VIDEO_RENDER: "VIDEO_RENDER",
  VIDEO_EDIT: "VIDEO_EDIT",
  VIDEO_APPROVE: "VIDEO_APPROVE",
  VIDEO_PUBLISH: "VIDEO_PUBLISH",

  SEO_EDIT: "SEO_EDIT",
  SEO_SCORE: "SEO_SCORE",
  SEO_APPROVE: "SEO_APPROVE",

  PUBLISH_CREATE: "PUBLISH_CREATE",
  PUBLISH_EXECUTE: "PUBLISH_EXECUTE",
  PUBLISH_CANCEL: "PUBLISH_CANCEL",
  // Module 9 Phase 9.1 — "Missing constant identified" (same precedent as
  // WORKSPACE_ARCHIVE/MEDIA_VIEW/SYSTEM_SCHEDULES_MANAGE above): the
  // frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's own role prose
  // names "Configure Channels" (Administrator, §2) and "Connect Channels"
  // (Publisher, §7), but its formal "## Publishing" Permission Category
  // never names a constant for either — only PUBLISH_CREATE/EXECUTE/
  // CANCEL. Deliberately kept distinct from those three: connecting a
  // NEW channel account or revoking/rotating an EXISTING shared
  // credential is a materially different-risk action than scheduling a
  // publish using an already-connected account. Architecture Checkpoint
  // §18's own explicit decision assigns this to Owner/Administrator only
  // — not Publisher — despite the frozen matrix's Publisher-role prose
  // bullet; a future phase's real connect/manage UI may reconsider
  // splitting "connect a channel for one's own publish use" from "manage/
  // revoke a shared credential" if the product wants to honor that
  // Publisher bullet more literally then. See the Phase 9.1 completion
  // report for this deviation, stated explicitly rather than resolved
  // silently either way.
  PUBLISH_CHANNEL_MANAGE: "PUBLISH_CHANNEL_MANAGE",

  ANALYTICS_VIEW: "ANALYTICS_VIEW",
  ANALYTICS_EXPORT: "ANALYTICS_EXPORT",

  // Module 1D: absent from the frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's
  // formal Permission Categories — only informal prose exists ("Manage
  // Media", "Manage Thumbnails" under Video Editor's responsibilities).
  // Added following the same "Missing constant identified" precedent as
  // Module 1C's WORKSPACE_ARCHIVE. See MODULE 1D ENGINEERING PLAN §8.
  MEDIA_VIEW: "MEDIA_VIEW",
  MEDIA_UPLOAD: "MEDIA_UPLOAD",
  MEDIA_MANAGE: "MEDIA_MANAGE",
  MEDIA_DELETE: "MEDIA_DELETE",

  USER_MANAGE: "USER_MANAGE",
  ROLE_MANAGE: "ROLE_MANAGE",
  SETTINGS_MANAGE: "SETTINGS_MANAGE",
  AUDIT_VIEW: "AUDIT_VIEW",

  // Module 1E: absent from the frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's
  // formal Permission Categories. BLOG_VIEW/VIDEO_VIEW are the content-type
  // read gates that ContentPermissionResolver checks dynamically against a
  // content item's actual contentType (existing BLOG_*/VIDEO_* constants are
  // all write/workflow actions with no plain read permission among them).
  // CONTENT_SERIES_MANAGE is the single gate for series CRUD, type-agnostic
  // since a series can span both content types. Added following the same
  // "Missing constant identified" precedent as Module 1C's WORKSPACE_ARCHIVE
  // and Module 1D's MEDIA_*. See MODULE 1E ENGINEERING PLAN §7 (RBAC mapping).
  BLOG_VIEW: "BLOG_VIEW",
  VIDEO_VIEW: "VIDEO_VIEW",
  CONTENT_SERIES_MANAGE: "CONTENT_SERIES_MANAGE",

  // Module 1F: absent from the frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's
  // formal Permission Categories — background jobs are platform/system-level
  // infrastructure (DB Design §5.12), not workspace business content, so
  // these sit alongside USER_MANAGE/ROLE_MANAGE/SETTINGS_MANAGE/AUDIT_VIEW
  // under Administration rather than getting their own category. Added
  // following the same "Missing constant identified" precedent as Module
  // 1C's WORKSPACE_ARCHIVE, Module 1D's MEDIA_*, and Module 1E's
  // BLOG_VIEW/VIDEO_VIEW/CONTENT_SERIES_MANAGE.
  JOB_VIEW: "JOB_VIEW",
  JOB_MANAGE: "JOB_MANAGE",

  // Module 1F Milestone 7 (Scheduler Foundation), Revision 3 §5/§12:
  // absent from the frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's
  // formal Permission Categories, same as JOB_VIEW/JOB_MANAGE above —
  // scheduled jobs are the identical category of platform/system-level
  // infrastructure (workspace-scoped schedule *management*, not business
  // content), so these sit alongside JOB_VIEW/JOB_MANAGE under
  // Administration, following the same "Missing constant identified"
  // precedent. These two constants govern *workspace-scoped* schedule
  // routes only — they never imply, and are never checked for,
  // platform-level (workspaceId: null) authority, which is gated
  // exclusively by PlatformOwnerGuard, entirely independent of this
  // permission system (Revision 3 §3/§12).
  SYSTEM_SCHEDULES_VIEW: "SYSTEM_SCHEDULES_VIEW",
  SYSTEM_SCHEDULES_MANAGE: "SYSTEM_SCHEDULES_MANAGE",

  // Module 3 Phase 3.3: absent from the frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's
  // formal Permission Categories, same "Missing constant identified"
  // precedent as JOB_VIEW/JOB_MANAGE above. Generic (agent-agnostic) —
  // gates the durable AI Job submission/read primitive itself, not any
  // specific content-type's own RESEARCH_RUN/BLOG_CREATE/VIDEO_CREATE
  // (those remain the real per-content-type gates once real business
  // agents exist in a later phase).
  AI_JOB_CREATE: "AI_JOB_CREATE",
  AI_JOB_VIEW: "AI_JOB_VIEW",

  // Module 5 Phase 5.1: absent from the frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's
  // formal Permission Categories, same "Missing constant identified"
  // precedent as CONTENT_SERIES_MANAGE above — a single, type-agnostic
  // gate for topic-cluster CRUD (create/list/get), following that exact
  // pattern rather than a RESEARCH-style RUN/VIEW split, since this is a
  // planning/management action, not an execution one.
  TOPIC_CLUSTER_MANAGE: "TOPIC_CLUSTER_MANAGE",
} as const;

export type PermissionConstant = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_CATEGORIES: Record<string, PermissionConstant[]> = {
  Workspace: [
    PERMISSIONS.WORKSPACE_VIEW,
    PERMISSIONS.WORKSPACE_CREATE,
    PERMISSIONS.WORKSPACE_UPDATE,
    PERMISSIONS.WORKSPACE_DELETE,
    PERMISSIONS.WORKSPACE_ARCHIVE,
  ],
  Projects: [PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PROJECT_CREATE, PERMISSIONS.PROJECT_UPDATE, PERMISSIONS.PROJECT_DELETE],
  "Knowledge Packs": [PERMISSIONS.KP_VIEW, PERMISSIONS.KP_CREATE, PERMISSIONS.KP_UPDATE, PERMISSIONS.KP_DELETE, PERMISSIONS.KP_VALIDATE, PERMISSIONS.KP_ARCHIVE],
  Research: [PERMISSIONS.RESEARCH_RUN, PERMISSIONS.RESEARCH_APPROVE, PERMISSIONS.RESEARCH_VIEW],
  Blog: [PERMISSIONS.BLOG_CREATE, PERMISSIONS.BLOG_EDIT, PERMISSIONS.BLOG_REVIEW, PERMISSIONS.BLOG_APPROVE, PERMISSIONS.BLOG_PUBLISH],
  Video: [PERMISSIONS.VIDEO_CREATE, PERMISSIONS.VIDEO_RENDER, PERMISSIONS.VIDEO_EDIT, PERMISSIONS.VIDEO_APPROVE, PERMISSIONS.VIDEO_PUBLISH],
  SEO: [PERMISSIONS.SEO_EDIT, PERMISSIONS.SEO_SCORE, PERMISSIONS.SEO_APPROVE],
  Publishing: [PERMISSIONS.PUBLISH_CREATE, PERMISSIONS.PUBLISH_EXECUTE, PERMISSIONS.PUBLISH_CANCEL, PERMISSIONS.PUBLISH_CHANNEL_MANAGE],
  Analytics: [PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.ANALYTICS_EXPORT],
  Media: [PERMISSIONS.MEDIA_VIEW, PERMISSIONS.MEDIA_UPLOAD, PERMISSIONS.MEDIA_MANAGE, PERMISSIONS.MEDIA_DELETE],
  Administration: [
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.ROLE_MANAGE,
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.JOB_VIEW,
    PERMISSIONS.JOB_MANAGE,
    PERMISSIONS.SYSTEM_SCHEDULES_VIEW,
    PERMISSIONS.SYSTEM_SCHEDULES_MANAGE,
  ],
  Content: [PERMISSIONS.BLOG_VIEW, PERMISSIONS.VIDEO_VIEW, PERMISSIONS.CONTENT_SERIES_MANAGE],
  AI: [PERMISSIONS.AI_JOB_CREATE, PERMISSIONS.AI_JOB_VIEW],
  "Content Planner": [PERMISSIONS.TOPIC_CLUSTER_MANAGE],
};

/**
 * The 8 roles, verbatim from the Role & Permission Matrix. This is the
 * first concrete resolution of the granular role -> permission mapping
 * flagged as an open gap in the Phase-0 Readiness Report — derived
 * directly from each role's documented responsibilities in that doc, not
 * invented here.
 */
export const ROLE_PERMISSIONS: Record<string, PermissionConstant[]> = {
  Owner: Object.values(PERMISSIONS),
  Administrator: [
    PERMISSIONS.WORKSPACE_VIEW,
    PERMISSIONS.WORKSPACE_UPDATE,
    PERMISSIONS.PROJECT_VIEW,
    PERMISSIONS.PROJECT_CREATE,
    PERMISSIONS.PROJECT_UPDATE,
    PERMISSIONS.PROJECT_DELETE,
    PERMISSIONS.KP_VIEW,
    PERMISSIONS.KP_CREATE,
    PERMISSIONS.KP_UPDATE,
    PERMISSIONS.KP_DELETE,
    // Module 2 Phase 2.1 (ACR-014).
    PERMISSIONS.KP_VALIDATE,
    PERMISSIONS.KP_ARCHIVE,
    PERMISSIONS.RESEARCH_RUN,
    PERMISSIONS.RESEARCH_APPROVE,
    PERMISSIONS.RESEARCH_VIEW,
    PERMISSIONS.BLOG_CREATE,
    PERMISSIONS.BLOG_EDIT,
    PERMISSIONS.BLOG_REVIEW,
    PERMISSIONS.BLOG_APPROVE,
    PERMISSIONS.BLOG_PUBLISH,
    PERMISSIONS.VIDEO_CREATE,
    PERMISSIONS.VIDEO_RENDER,
    PERMISSIONS.VIDEO_EDIT,
    PERMISSIONS.VIDEO_APPROVE,
    PERMISSIONS.VIDEO_PUBLISH,
    PERMISSIONS.SEO_EDIT,
    PERMISSIONS.SEO_SCORE,
    PERMISSIONS.SEO_APPROVE,
    PERMISSIONS.PUBLISH_CREATE,
    PERMISSIONS.PUBLISH_EXECUTE,
    PERMISSIONS.PUBLISH_CANCEL,
    // Module 9 Phase 9.1: "Configure Channels"/"Manage Publishing" (the
    // frozen matrix's own §2 prose) — see PUBLISH_CHANNEL_MANAGE's own
    // doc comment above for the full reasoning.
    PERMISSIONS.PUBLISH_CHANNEL_MANAGE,
    PERMISSIONS.ANALYTICS_VIEW,
    PERMISSIONS.ANALYTICS_EXPORT,
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.AUDIT_VIEW,
    // Module 1F final RBAC map: background jobs are an operational/system
    // concern, same tier as AUDIT_VIEW — Administrator-and-up only, no
    // other role gets job visibility or control.
    PERMISSIONS.JOB_VIEW,
    PERMISSIONS.JOB_MANAGE,
    // Module 1F Milestone 7 final RBAC map: schedule *management* is the
    // identical operational/system tier as background jobs above —
    // Administrator-and-up only, workspace-scoped only (never platform-
    // level authority, which PlatformOwnerGuard alone gates).
    PERMISSIONS.SYSTEM_SCHEDULES_VIEW,
    PERMISSIONS.SYSTEM_SCHEDULES_MANAGE,
    // Deliberately excluded: WORKSPACE_CREATE/DELETE/ARCHIVE, ROLE_MANAGE,
    // SETTINGS_MANAGE — Owner-exclusive per FR-WS-001 and the Matrix's
    // "Cannot: Transfer Ownership" note. WORKSPACE_ARCHIVE added in Module
    // 1C, kept out of this list on purpose (Module 1C Engineering Plan §2.A:
    // archive/restore is Owner-only, not Administrator-accessible).
    // Module 1D final RBAC map §8: full media footprint.
    PERMISSIONS.MEDIA_VIEW,
    PERMISSIONS.MEDIA_UPLOAD,
    PERMISSIONS.MEDIA_MANAGE,
    PERMISSIONS.MEDIA_DELETE,
    // Module 1E final RBAC map §7: full content footprint.
    PERMISSIONS.BLOG_VIEW,
    PERMISSIONS.VIDEO_VIEW,
    PERMISSIONS.CONTENT_SERIES_MANAGE,
    // Module 3 Phase 3.3: same operational/system tier as JOB_VIEW/
    // JOB_MANAGE above — Administrator-and-up only for now, since a
    // generic "submit any registered agent" capability is a broad,
    // system-level power until real per-content-type RUN permissions
    // (RESEARCH_RUN, BLOG_CREATE, etc.) become the actual business gate
    // in a later phase with real agents.
    PERMISSIONS.AI_JOB_CREATE,
    PERMISSIONS.AI_JOB_VIEW,
    // Module 5 Phase 5.1 final RBAC map: full content-planning footprint,
    // same tier as CONTENT_SERIES_MANAGE above.
    PERMISSIONS.TOPIC_CLUSTER_MANAGE,
  ],
  "Content Manager": [
    PERMISSIONS.PROJECT_VIEW,
    PERMISSIONS.PROJECT_CREATE,
    PERMISSIONS.PROJECT_UPDATE,
    // Module 2 Phase 2.1 (ACR-014): assigned per the approved architecture
    // ("Owner, Administrator, Content Manager"). Pre-existing gap noted,
    // not fixed here (out of Phase 2.1 scope) — this role still lacks
    // KP_CREATE/KP_UPDATE/KP_DELETE despite Database Design Appendix G
    // naming Content Manager the Knowledge Pack business owner.
    PERMISSIONS.KP_VIEW,
    PERMISSIONS.KP_VALIDATE,
    PERMISSIONS.KP_ARCHIVE,
    PERMISSIONS.RESEARCH_RUN,
    PERMISSIONS.RESEARCH_VIEW,
    PERMISSIONS.BLOG_CREATE,
    PERMISSIONS.BLOG_EDIT,
    PERMISSIONS.BLOG_REVIEW,
    PERMISSIONS.BLOG_APPROVE,
    PERMISSIONS.VIDEO_CREATE,
    PERMISSIONS.VIDEO_EDIT,
    PERMISSIONS.VIDEO_APPROVE,
    PERMISSIONS.PUBLISH_CREATE,
    PERMISSIONS.ANALYTICS_VIEW,
    // Module 1D final RBAC map §8: full media footprint.
    PERMISSIONS.MEDIA_VIEW,
    PERMISSIONS.MEDIA_UPLOAD,
    PERMISSIONS.MEDIA_MANAGE,
    PERMISSIONS.MEDIA_DELETE,
    // Module 1E final RBAC map §7: full content footprint.
    PERMISSIONS.BLOG_VIEW,
    PERMISSIONS.VIDEO_VIEW,
    PERMISSIONS.CONTENT_SERIES_MANAGE,
    // Module 3 Phase 3.3: Content Manager already triggers agent-adjacent
    // work (RESEARCH_RUN, BLOG_CREATE, VIDEO_CREATE above) — the natural
    // role to also submit/view generic AI job executions once real
    // business agents exist.
    PERMISSIONS.AI_JOB_CREATE,
    PERMISSIONS.AI_JOB_VIEW,
    // Module 5 Phase 5.1 final RBAC map: Content Manager plans content
    // from Research the same way it already runs Research itself.
    PERMISSIONS.TOPIC_CLUSTER_MANAGE,
  ],
  "Content Writer": [
    PERMISSIONS.RESEARCH_RUN,
    PERMISSIONS.RESEARCH_VIEW,
    PERMISSIONS.BLOG_CREATE,
    PERMISSIONS.BLOG_EDIT,
    PERMISSIONS.KP_VIEW,
    // Module 1D final RBAC map §8: view + upload only — no manage/delete,
    // and no "own uploads only" exception (the current RBAC model has no
    // ownership-scope concept at all; see plan §8).
    PERMISSIONS.MEDIA_VIEW,
    PERMISSIONS.MEDIA_UPLOAD,
    // Module 1E final RBAC map §7: blog content only — no video read access,
    // no series management.
    PERMISSIONS.BLOG_VIEW,
  ],
  "SEO Specialist": [
    PERMISSIONS.RESEARCH_RUN,
    PERMISSIONS.RESEARCH_VIEW,
    PERMISSIONS.SEO_EDIT,
    PERMISSIONS.SEO_SCORE,
    PERMISSIONS.SEO_APPROVE,
    PERMISSIONS.BLOG_EDIT,
    PERMISSIONS.ANALYTICS_VIEW,
    // Module 1D final RBAC map §8: view + upload only.
    PERMISSIONS.MEDIA_VIEW,
    PERMISSIONS.MEDIA_UPLOAD,
    // Module 1E final RBAC map §7: both content types (SEO spans blog and
    // video), no series management.
    PERMISSIONS.BLOG_VIEW,
    PERMISSIONS.VIDEO_VIEW,
    // Module 5 Phase 5.1 final RBAC map: FR-PLAN-002's own user story is
    // written from the SEO Specialist's perspective ("As an SEO
    // Specialist, I want topics grouped into clusters...") — the one role
    // outside Owner/Administrator/Content Manager that gets this.
    PERMISSIONS.TOPIC_CLUSTER_MANAGE,
  ],
  "Video Editor": [
    PERMISSIONS.VIDEO_CREATE,
    PERMISSIONS.VIDEO_RENDER,
    PERMISSIONS.VIDEO_EDIT,
    // Module 1D final RBAC map §8: view + upload + manage (matches this
    // role's explicit "Manage Media"/"Manage Thumbnails" prose in the
    // frozen matrix) — no delete.
    PERMISSIONS.MEDIA_VIEW,
    PERMISSIONS.MEDIA_UPLOAD,
    PERMISSIONS.MEDIA_MANAGE,
    // Module 1E final RBAC map §7: video content only — no blog read
    // access, no series management.
    PERMISSIONS.VIDEO_VIEW,
  ],
  Publisher: [
    PERMISSIONS.PUBLISH_CREATE,
    PERMISSIONS.PUBLISH_EXECUTE,
    PERMISSIONS.PUBLISH_CANCEL,
    // Module 9 Phase 9.1 — deliberately NOT PUBLISH_CHANNEL_MANAGE, per
    // Architecture Checkpoint §18's explicit decision: Publisher may
    // publish using already-connected accounts without being able to
    // manage/revoke a shared workspace credential, even though the
    // frozen AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md's own §7 prose
    // names "Connect Channels" among this role's permissions. See
    // PUBLISH_CHANNEL_MANAGE's own doc comment for the full reasoning.
    PERMISSIONS.BLOG_PUBLISH,
    PERMISSIONS.VIDEO_PUBLISH,
    // Module 1D final RBAC map §8: view only.
    PERMISSIONS.MEDIA_VIEW,
    // Module 1E final RBAC map §7: both content types (publishes either),
    // no series management.
    PERMISSIONS.BLOG_VIEW,
    PERMISSIONS.VIDEO_VIEW,
  ],
  Analyst: [
    PERMISSIONS.ANALYTICS_VIEW,
    PERMISSIONS.ANALYTICS_EXPORT,
    // Module 1D final RBAC map §8: view only.
    PERMISSIONS.MEDIA_VIEW,
    // Module 1E final RBAC map §7: deliberately excluded — no raw draft
    // content access. Analytics on published content does not require
    // BLOG_VIEW/VIDEO_VIEW since those gate the editorial content_items
    // resource, not aggregate analytics.
  ],
};
