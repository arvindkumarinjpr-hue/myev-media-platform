# AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md

# AI Content Operating System (AI-COS)

## Role & Permission Matrix

**Version:** 1.1\
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN

------------------------------------------------------------------------

# Purpose

This document defines the user roles, access levels, permissions, and
authorization model for AI-COS Version 1.

------------------------------------------------------------------------

# Access Principles

-   Least Privilege
-   Role-Based Access Control (RBAC)
-   Workspace Isolation
-   Audit Logging
-   Explicit Permission Assignment

------------------------------------------------------------------------

# Roles

## 1. Owner

Full platform access.

Permissions: - Workspace Management - User Management - Billing
(Future) - AI Configuration - Integrations - Publishing - Analytics -
Feature Flags - System Settings

------------------------------------------------------------------------

## 2. Administrator

Permissions:

-   Manage Users
-   Manage Projects
-   Manage Knowledge Packs
-   Configure Channels
-   Review Analytics
-   Manage Publishing
-   View Audit Logs

Cannot: - Transfer Ownership

------------------------------------------------------------------------

## 3. Content Manager

Permissions:

-   Create Projects
-   Create Content Plans
-   Approve Content
-   Schedule Publishing
-   Manage Editorial Calendar

------------------------------------------------------------------------

## 4. Content Writer

Permissions:

-   Research Topics
-   Generate Blogs
-   Edit Articles
-   Submit for Review

Cannot: - Publish - Change Workspace Settings

------------------------------------------------------------------------

## 5. SEO Specialist

Permissions:

-   Keyword Research
-   SEO Optimization
-   Internal Linking
-   Metadata
-   Schema
-   SEO Reports

------------------------------------------------------------------------

## 6. Video Editor

Permissions:

-   Generate Scripts
-   Manage Voice
-   Manage Media
-   Render Videos
-   Manage Thumbnails

------------------------------------------------------------------------

## 7. Publisher

Permissions:

-   Connect Channels
-   Schedule Content
-   Publish Content
-   Retry Failed Jobs
-   View Publishing History

------------------------------------------------------------------------

## 8. Analyst

Permissions:

-   View Dashboards
-   Export Reports
-   Review Growth
-   Analyze ROI

Read-only role.

------------------------------------------------------------------------

# Permission Categories

## Workspace

-   WORKSPACE_VIEW
-   WORKSPACE_CREATE
-   WORKSPACE_UPDATE
-   WORKSPACE_DELETE

## Projects

-   PROJECT_VIEW
-   PROJECT_CREATE
-   PROJECT_UPDATE
-   PROJECT_DELETE

## Knowledge Packs

-   KP_VIEW
-   KP_CREATE
-   KP_UPDATE
-   KP_DELETE
-   KP_VALIDATE (ACR-014/ADR-014 — triggers the Draft→Validating→Active/Draft validation and activation workflow; validation and successful activation remain one operation, no separate KP_ACTIVATE)
-   KP_ARCHIVE (ACR-014/ADR-014 — explicit Active→Archived transition, distinct from KP_DELETE, which remains Draft-only soft deletion)

## Research

-   RESEARCH_RUN
-   RESEARCH_APPROVE

## Blog

-   BLOG_CREATE
-   BLOG_EDIT
-   BLOG_REVIEW
-   BLOG_APPROVE
-   BLOG_PUBLISH

## Video

-   VIDEO_CREATE
-   VIDEO_RENDER
-   VIDEO_EDIT
-   VIDEO_APPROVE
-   VIDEO_PUBLISH

## SEO

-   SEO_EDIT
-   SEO_SCORE
-   SEO_APPROVE

## Publishing

-   PUBLISH_CREATE
-   PUBLISH_EXECUTE
-   PUBLISH_CANCEL

## Analytics

-   ANALYTICS_VIEW
-   ANALYTICS_EXPORT

## Administration

-   USER_MANAGE
-   ROLE_MANAGE
-   SETTINGS_MANAGE
-   AUDIT_VIEW

------------------------------------------------------------------------

# Approval Workflow

Content Writer ↓ SEO Review ↓ Content Manager Approval ↓ Publisher ↓
Published

------------------------------------------------------------------------

# Permission Matrix (Summary)

  Role                 Create        Edit      Approve   Publish      Admin
  ----------------- ------------ ------------ --------- ---------- -----------
  Owner                  ✓            ✓           ✓         ✓           ✓
  Administrator          ✓            ✓           ✓         ✓        Partial
  Content Manager        ✓            ✓           ✓      Schedule      No
  Content Writer         ✓            ✓          No         No         No
  SEO Specialist      SEO Only     SEO Only      SEO        No         No
  Video Editor       Video Only   Video Only     No         No         No
  Publisher              No           No         No         ✓          No
  Analyst                No           No         No         No      Read Only

------------------------------------------------------------------------

# Audit Requirements

Log:

-   Login
-   Logout
-   Role Changes
-   Permission Changes
-   Publishing
-   Content Approval
-   Workspace Changes

------------------------------------------------------------------------

# Future Roles

-   Agency Owner
-   Client
-   External Reviewer
-   Marketplace Publisher
-   API Consumer

------------------------------------------------------------------------

# Next Document

`AI_AGENT_FRAMEWORK_V1.0.md`
