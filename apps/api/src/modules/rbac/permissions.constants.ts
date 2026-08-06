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

  RESEARCH_RUN: "RESEARCH_RUN",
  RESEARCH_APPROVE: "RESEARCH_APPROVE",

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
  "Knowledge Packs": [PERMISSIONS.KP_VIEW, PERMISSIONS.KP_CREATE, PERMISSIONS.KP_UPDATE, PERMISSIONS.KP_DELETE],
  Research: [PERMISSIONS.RESEARCH_RUN, PERMISSIONS.RESEARCH_APPROVE],
  Blog: [PERMISSIONS.BLOG_CREATE, PERMISSIONS.BLOG_EDIT, PERMISSIONS.BLOG_REVIEW, PERMISSIONS.BLOG_APPROVE, PERMISSIONS.BLOG_PUBLISH],
  Video: [PERMISSIONS.VIDEO_CREATE, PERMISSIONS.VIDEO_RENDER, PERMISSIONS.VIDEO_EDIT, PERMISSIONS.VIDEO_APPROVE, PERMISSIONS.VIDEO_PUBLISH],
  SEO: [PERMISSIONS.SEO_EDIT, PERMISSIONS.SEO_SCORE, PERMISSIONS.SEO_APPROVE],
  Publishing: [PERMISSIONS.PUBLISH_CREATE, PERMISSIONS.PUBLISH_EXECUTE, PERMISSIONS.PUBLISH_CANCEL],
  Analytics: [PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.ANALYTICS_EXPORT],
  Media: [PERMISSIONS.MEDIA_VIEW, PERMISSIONS.MEDIA_UPLOAD, PERMISSIONS.MEDIA_MANAGE, PERMISSIONS.MEDIA_DELETE],
  Administration: [
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.ROLE_MANAGE,
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.JOB_VIEW,
    PERMISSIONS.JOB_MANAGE,
  ],
  Content: [PERMISSIONS.BLOG_VIEW, PERMISSIONS.VIDEO_VIEW, PERMISSIONS.CONTENT_SERIES_MANAGE],
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
    PERMISSIONS.RESEARCH_RUN,
    PERMISSIONS.RESEARCH_APPROVE,
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
    PERMISSIONS.ANALYTICS_VIEW,
    PERMISSIONS.ANALYTICS_EXPORT,
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.AUDIT_VIEW,
    // Module 1F final RBAC map: background jobs are an operational/system
    // concern, same tier as AUDIT_VIEW — Administrator-and-up only, no
    // other role gets job visibility or control.
    PERMISSIONS.JOB_VIEW,
    PERMISSIONS.JOB_MANAGE,
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
  ],
  "Content Manager": [
    PERMISSIONS.PROJECT_VIEW,
    PERMISSIONS.PROJECT_CREATE,
    PERMISSIONS.PROJECT_UPDATE,
    PERMISSIONS.KP_VIEW,
    PERMISSIONS.RESEARCH_RUN,
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
  ],
  "Content Writer": [
    PERMISSIONS.RESEARCH_RUN,
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
