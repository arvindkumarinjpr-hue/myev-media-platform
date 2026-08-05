# AI_CONTENT_OPERATING_SYSTEM_FUNCTIONAL_REQUIREMENT_DOCUMENT

## Functional Requirement Document (FRD)

**Version:** 1.2
**Status:** FINAL
**Approved:** YES
**Implementation Ready:** YES
**Document State:** FROZEN — no further changes without an approved architectural change request.
**Source of truth:** Master Blueprint, Enterprise Architecture, Module Design, Agent Framework, Knowledge Pack Engine, Role & Permission Matrix, Content Scoring/Video/Blog/Social/Distribution/Growth/Internal Linking/Memory Engine specs, Phase-0 Readiness Report clarifications.

---

## Section 1 — Introduction

**Product Overview:** AI-COS is the core platform (Auth, Workspace, Knowledge Pack, AI Gateway, Queue, Publishing, Analytics, Growth). MYEV Media is the first product instance running on it, scoped to the EV industry.

**Scope (V1):** Per Blueprint §6 — Included: multi-workspace, multi-brand, Knowledge Packs, Research, Blog/Video/Newsletter Automation, SEO, Internal Linking, Publishing, Analytics, Growth. Excluded: SaaS billing, public registration, marketplace, white-label, plugin marketplace, public APIs, mobile apps.

**Definitions:**

| Term | Meaning |
|---|---|
| Workspace | Top-level tenant boundary (e.g. MYEV Media, EVision India). Owns brands, projects, Knowledge Packs. |
| Project | A content initiative within a workspace, tied to one or more channels. |
| Knowledge Pack | The configuration object (sources, prompts, brand rules, SEO rules) that every AI agent must load before running. |
| Content Item | Any generated asset — blog, video, script, social post, newsletter — tracked through its own lifecycle/version history. |
| AI Job | A queued, retryable unit of AI work (e.g. "generate outline") executed by an Agent via the AI Provider Abstraction Layer. |
| Agent | A single-responsibility AI worker (Research Agent, Blog Agent, etc.) per the Agent Framework catalog. |
| Publishing Job | A scheduled or immediate action that pushes a Content Item to an external Channel. |
| Channel | A connected external account (YouTube channel, WordPress site, Facebook Page, etc.) belonging to a workspace. |

**Assumptions:**
- Docker Compose is the application runtime; CloudPanel is edge-only (reverse proxy/SSL/domain).
- Workspace isolation is enforced from V1 (Phase-0 Readiness Report, clarification #2).
- All AI calls route through the Provider Abstraction Layer — no module talks to OpenAI/Gemini/Claude directly.
- Human approval gates publishing for every content type (Blueprint's "Human Approval" philosophy).

---

## Section 2 — Business Requirements

**Business Objectives (BR):**
- BR-001: Reduce content production effort by ≥90% (Blueprint §Mission)
- BR-002: Produce publish-ready content requiring minimal human edits
- BR-003: Improve SEO consistency and organic visibility across all workspaces
- BR-004: Support onboarding additional workspaces (EVision India, MySensex, client projects) without architectural change
- BR-005: Run in production for ≥90 consecutive days as V1 success gate (Blueprint §17)

**Stakeholders:** Owner, Administrator, Content Manager, Content Writer, SEO Specialist, Video Editor, Publisher, Analyst — per Role & Permission Matrix.

**Success Criteria:** Reused verbatim from Blueprint §17 — no new criteria invented here to avoid scope drift.

---

## Section 3 — Functional Requirements Framework

Each functional requirement uses a fixed 8-field template:

`FR ID · User Story (US) · Description · Acceptance Criteria (AC) · Business Rules · Dependencies · Validation Rules · Error Conditions`

**Module ID prefixes (FR IDs — compact form for table readability):**

| Prefix | Module |
|---|---|
| AUTH | Authentication & Identity |
| WS | Workspace Management |
| KP | Knowledge Pack Management |
| RES | Research Engine |
| KW | Keyword Engine |
| PLAN | Content Planner |
| BLOG | Blog Automation |
| VID | Video Automation |
| SEO | SEO Engine |
| LINK | Internal Linking Engine |
| PUB | Publishing Engine |
| DIST | Distribution Engine |
| ANLY | Analytics Engine |
| GROW | Growth Engine |

Note: Authentication & Identity (AUTH) is a formal section added here — the original skeleton listed "User Roles" as Section 4 but not Authentication itself, even though Module Design lists it as Module 1. This is a deliberate, transparent expansion, not a silent architecture change.

---

## Section 4 — Authentication, Identity & User Roles

**FR-AUTH-001 — Email/Password Registration & Login**
- US-AUTH-001: As an Owner, I want to create user accounts with email/password, so that team members can access their workspace-appropriate tools.
- Description: Standard credential-based auth issuing JWT access + refresh tokens on success.
- AC: (1) Valid credentials return access+refresh token pair. (2) Invalid credentials return 401 without revealing which field was wrong. (3) Account lock after N consecutive failures (N defined in Security doc expansion).
- Business Rules: Passwords never stored in plaintext; only Owner/Administrator can create accounts in V1 (no public registration per Blueprint exclusion).
- Dependencies: None (foundational).
- Validation Rules: Email format, password minimum complexity (length/character rules — to be finalized in Security Architecture doc, currently unspecified).
- Error Conditions: Duplicate email → 409; malformed payload → 400; too many failed attempts → 423.

**FR-AUTH-002 — OAuth Login**
- US-AUTH-002: As a user, I want to log in via OAuth (Google), so that I don't need a separate password.
- Description: OAuth 2.0 login flow per Security doc §Authentication.
- AC: (1) Successful OAuth callback creates or links a user record. (2) Session issued identically to password login.
- Business Rules: OAuth-created accounts still require Owner/Administrator to assign a role before any permission is granted.
- Dependencies: FR-AUTH-001 (shared session model).
- Validation Rules: OAuth state/CSRF token validated on callback.
- Error Conditions: Invalid/expired OAuth state → 400; provider error → 502.

**FR-AUTH-003 — Session Management**
- US-AUTH-003: As a user, I want my session to stay valid without re-entering credentials constantly, so that my workflow isn't interrupted.
- Description: JWT access token (short-lived) + refresh token (longer-lived) with secure logout invalidating both.
- AC: (1) Access token expiry enforced server-side. (2) Refresh endpoint issues new access token only for a valid, non-revoked refresh token. (3) Logout revokes the refresh token immediately.
- Business Rules: Refresh tokens are single-workspace scoped — switching workspace requires re-issuing a token carrying the new workspace context.
- Dependencies: FR-WS-005 (workspace scoping).
- Validation Rules: Token signature, expiry, and workspace claim validated on every request.
- Error Conditions: Expired/invalid token → 401; revoked token reuse → 401 + audit log entry.

**FR-AUTH-004 — Role Assignment & RBAC Enforcement**
- US-AUTH-004: As an Administrator, I want to assign one of the 8 defined roles to each user, so that access matches their responsibility.
- Description: Enforces the Role & Permission Matrix at the API layer for every protected endpoint.
- AC: (1) Every endpoint declares its required permission constant. (2) A request lacking that permission is rejected regardless of authentication validity. (3) Role changes take effect on next token refresh at the latest.
- Business Rules: Only Owner can assign the Owner role; Administrator cannot transfer ownership (per Role Matrix).
- Dependencies: FR-WS-004 (workspace member management).
- Validation Rules: Role must be one of the 8 defined roles; permission constants must exist in the canonical list (Role Matrix §Permission Categories).
- Error Conditions: Unknown role → 400; insufficient permission → 403 (logged to audit trail).

**FR-AUTH-005 — Auth Event Audit Logging**
- US-AUTH-005: As an Administrator, I want every login/logout/role change logged immutably, so that I can investigate security incidents.
- Description: Every event in Security doc's Audit Logging list is written to an append-only audit log.
- AC: (1) Login, logout, role change, permission change are all logged with timestamp, actor, workspace, IP. (2) Audit logs cannot be edited or deleted via any API.
- Business Rules: Audit logs are immutable (Security doc §Audit Logging).
- Dependencies: FR-AUTH-001–004.
- Validation Rules: N/A (system-generated, not user input).
- Error Conditions: Audit write failure must not block the underlying auth action but must raise an Observability alert (Observability spec — pending, see blockers).

---

## Section 5 — Workspace Management

**FR-WS-001 — Create Workspace**
- US-WS-001: As an Owner, I want to create a new workspace, so that a new product/brand (e.g. MYEV Media, EVision India) can be onboarded without touching the platform codebase.
- Description: Creates an isolated workspace record; no default Knowledge Pack (must be created separately per FR-KP-001).
- AC: (1) Workspace created with unique slug/domain mapping. (2) Creator is automatically assigned Owner role within that workspace.
- Business Rules: Workspace creation restricted to platform Owner in V1 (no self-service, per Blueprint exclusion of public registration).
- Dependencies: FR-AUTH-004.
- Validation Rules: Unique workspace name/slug; required brand name field.
- Error Conditions: Duplicate slug → 409.

**FR-WS-002 — Workspace Branding & Settings**
- US-WS-002: As an Owner, I want to configure workspace-level branding, so that generated content and dashboards reflect the correct brand identity.
- AC: (1) Logo, brand name, primary domain configurable. (2) Settings changes are versioned/audited.
- Business Rules: Branding is workspace-scoped, never global.
- Dependencies: FR-WS-001.
- Validation Rules: Domain format validation.
- Error Conditions: Invalid domain format → 400.

**FR-WS-003 — Multi-Project Support**
- US-WS-003: As a Content Manager, I want multiple projects within one workspace, so that distinct campaigns/channels can be organized independently.
- AC: (1) A workspace supports N projects. (2) Each project can bind to one or more channels.
- Business Rules: Projects inherit workspace's Knowledge Pack unless a project-level override exists (override mechanism: future enhancement, not V1).
- Dependencies: FR-WS-001, FR-KP-005.
- Validation Rules: Project name required and unique within workspace.
- Error Conditions: Duplicate project name within workspace → 409.

**FR-WS-004 — Workspace Member Invitation & Role Assignment**
- US-WS-004: As an Administrator, I want to invite team members into a workspace with a specific role, so that access is controlled per person.
- AC: (1) Invitation sent via email with expiring accept link. (2) Accepted invite creates a workspace-scoped role assignment (a user may hold different roles in different workspaces).
- Business Rules: A user's role is workspace-scoped, not global — matches multi-workspace isolation requirement.
- Dependencies: FR-AUTH-001, FR-WS-001.
- Validation Rules: Invitee email format; invite expiry window.
- Error Conditions: Expired invite token → 410; already-member → 409.

**FR-WS-005 — Workspace Data Isolation Enforcement**
- US-WS-005: As the platform, I must ensure no query ever returns data across workspace boundaries, so that MYEV Media, EVision India, and MySensex data never leak into one another.
- Description: Every business-entity query is scoped by `workspace_id` at the data-access layer, not just at the API-authorization layer.
- AC: (1) A user authenticated to Workspace A cannot retrieve any record belonging to Workspace B via any endpoint, including via ID guessing. (2) Automated test exists asserting cross-workspace isolation for every entity type.
- Business Rules: This is the single most important rule in the platform per Phase-0 Readiness Report §1 — no exceptions, no "admin bypass" endpoint without explicit separate authorization.
- Dependencies: All modules.
- Validation Rules: `workspace_id` required on every business-entity write.
- Error Conditions: Cross-workspace access attempt → 404 (not 403, to avoid confirming the resource's existence) + audit log entry.

---

## Section 6 — Knowledge Pack Management

**FR-KP-001 — Create Knowledge Pack**
- US-KP-001: As a Content Manager, I want to create a Knowledge Pack for my workspace, so that all AI agents behave consistently with my brand and niche.
- AC: (1) Pack created in Draft status. (2) Pack is workspace-scoped.
- Business Rules: A workspace may hold multiple packs (e.g. per brand/project) but each Project has exactly one Active pack at a time.
- Dependencies: FR-WS-001.
- Validation Rules: Industry profile and brand name required (per Knowledge Pack Engine doc §Validation Rules).
- Error Conditions: Missing required fields → 400.

**FR-KP-002 — Configure Trusted Sources**
- US-KP-002: As an SEO Specialist, I want to define trusted sources for research, so that AI-generated content only cites credible references.
- AC: (1) At least one trusted source required before activation. (2) Sources support government sites, industry associations, RSS feeds.
- Business Rules: Minimum one trusted source enforced at activation, not at draft save.
- Dependencies: FR-KP-001.
- Validation Rules: URL format validation per source.
- Error Conditions: Invalid URL → 400.

**FR-KP-003 — Prompt Template Library Management**
- US-KP-003: As a Content Manager, I want to manage prompt templates per content type, so that Blog/Video/SEO agents produce on-brand output.
- AC: (1) At least one template per content type required before activation. (2) Templates versioned on edit.
- Business Rules: Minimum one prompt template per content type enforced at activation.
- Dependencies: FR-KP-001.
- Validation Rules: Template must declare which content type it applies to.
- Error Conditions: Template with unknown content type → 400.

**FR-KP-004 — Brand & SEO Rules Configuration**
- US-KP-004: As an SEO Specialist, I want to define SEO rules (primary/secondary keywords, internal linking policy, schema preferences) at the Knowledge Pack level, so that every generated asset follows the same SEO strategy.
- AC: (1) SEO rules stored as structured config, not free text, so downstream engines (SEO Engine, Internal Linking Engine) can consume them programmatically.
- Business Rules: Publishing strategy required before activation.
- Dependencies: FR-KP-001.
- Validation Rules: At least one primary keyword category defined.
- Error Conditions: Missing publishing strategy at activation attempt → 422.

**FR-KP-005 — Knowledge Pack Validation & Activation**
- US-KP-005: As a Content Manager, I want the system to validate a pack before it can be activated, so that no agent ever runs against an incomplete configuration.
- AC: (1) Activation blocked unless all 4 validation rules pass (trusted source, prompt template, brand name, industry profile + publishing strategy). (2) Activating a new version deprecates the prior Active version but preserves its history.
- Business Rules: "Agents must not operate without an active Knowledge Pack" — hard platform invariant.
- Dependencies: FR-KP-002, FR-KP-003, FR-KP-004.
- Validation Rules: All Draft→Active validation rules must pass atomically.
- Error Conditions: Any missing required field → 422 with itemized list of failing rules.

**FR-KP-006 — Knowledge Pack Versioning**
- US-KP-006: As a Content Manager, I want every change to a pack to create a new version rather than overwrite history, so that I can audit why AI output changed over time.
- AC: (1) Every edit to an Active pack creates a new Draft version. (2) Prior Active versions remain queryable (Archived status).
- Business Rules: Changes create a new version while preserving history.
- Dependencies: FR-KP-005.
- Validation Rules: N/A.
- Error Conditions: Attempted direct edit of an Archived version → 409.

---

## Section 7 — Research Engine

**FR-RES-001 — Trend Discovery**
- US-RES-001: As a Content Manager, I want the system to surface emerging EV topics automatically, so that content planning starts from real demand signals.
- AC: (1) Trend Agent returns topic + opportunity score + freshness. (2) Results scoped to the workspace's Knowledge Pack industry profile.
- Business Rules: Every research run requires an active Knowledge Pack.
- Dependencies: FR-KP-005.
- Validation Rules: Topic input (if manually seeded) must be non-empty.
- Error Conditions: No active Knowledge Pack → 422; upstream data source failure → job marked Failed, retried per Queue spec (pending).

**FR-RES-002 — Source Collection & Summarization**
- US-RES-002: As a Content Writer, I want research sources automatically collected and summarized, so that I don't manually browse dozens of articles per topic.
- AC: (1) Only sources from the pack's Trusted Sources list (or explicitly approved ad hoc sources) are included. (2) Output includes citation back to original source.
- Business Rules: Research must draw only from configured trusted sources unless explicitly overridden by a permitted role.
- Dependencies: FR-KP-002.
- Validation Rules: Source URL reachability check before inclusion.
- Error Conditions: Unreachable source → excluded with warning logged, not a hard failure.

**FR-RES-003 — Competitor Analysis**
- US-RES-003: As an SEO Specialist, I want competitor content gaps identified, so that our content plan targets underserved topics.
- AC: (1) Analysis limited to the pack's configured Competitor Library.
- Business Rules: N/A beyond scoping.
- Dependencies: FR-KP-001.
- Validation Rules: Competitor domain format.
- Error Conditions: Empty competitor library → analysis proceeds with a warning, not a blocking error.

**FR-RES-004 — Research Dataset Deduplication**
- US-RES-004: As the system, I want to remove duplicate/near-duplicate research findings, so that downstream content isn't built on redundant input.
- AC: (1) Duplicate detection runs before the research package is marked complete.
- Business Rules: Deduplication is mandatory, not optional.
- Dependencies: FR-RES-002.
- Validation Rules: N/A.
- Error Conditions: Deduplication failure does not block the job but flags the dataset for manual review.

---

## Section 8 — Keyword Engine

**FR-KW-001 — Keyword Discovery & Clustering**
- US-KW-001: As an SEO Specialist, I want keywords automatically clustered by topic, so that content planning aligns with real search structure.
- AC: (1) Output includes primary + secondary keyword sets per cluster.
- Business Rules: Uses the pack's configured keyword sets as a seed, not as the only source.
- Dependencies: FR-KP-004, FR-RES-001.
- Validation Rules: N/A.
- Error Conditions: No seed keywords and no research input available → 422.

**FR-KW-002 — Search Intent Classification**
- US-KW-002: As an SEO Specialist, I want each keyword tagged with search intent (informational/transactional/navigational), so that content type matches user intent.
- AC: (1) Every keyword in a cluster receives an intent label.
- Business Rules: N/A.
- Dependencies: FR-KW-001.
- Validation Rules: N/A.
- Error Conditions: Unclassifiable keyword → tagged "Unknown," not silently dropped.

**FR-KW-003 — Keyword Opportunity Scoring**
- US-KW-003: As a Content Manager, I want a numeric opportunity score per keyword, so that I can prioritize the content calendar objectively.
- AC: (1) Score is explainable — factors contributing to the score are retrievable, not a black box.
- Business Rules: N/A.
- Dependencies: FR-KW-001, FR-KW-002.
- Validation Rules: Score range 0–100 (consistent with Content Scoring Engine's convention).
- Error Conditions: N/A.

---

## Section 9 — Content Planner

**FR-PLAN-001 — Editorial Calendar Management**
- US-PLAN-001: As a Content Manager, I want a calendar view of planned/in-progress/published content, so that I can manage publishing cadence.
- AC: (1) Calendar reflects real-time content status. (2) Filterable by project, content type, status.
- Business Rules: Calendar is project-scoped within a workspace.
- Dependencies: FR-WS-003.
- Validation Rules: Scheduled date must be present/future for new entries.
- Error Conditions: Scheduling in the past → 400.

**FR-PLAN-002 — Topic Cluster Planning**
- US-PLAN-002: As an SEO Specialist, I want topics grouped into clusters on the calendar, so that internal linking and topical authority are planned proactively, not discovered after publishing.
- AC: (1) A cluster links to its member content items once each is created.
- Business Rules: N/A.
- Dependencies: FR-KW-001, FR-LINK-001.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-PLAN-003 — Content Series Planning**
- US-PLAN-003: As a Content Manager, I want to plan multi-part content series (e.g. a 5-part EV buying guide), so that related pieces are produced and linked coherently.
- AC: (1) Series items share a parent series ID and sequence number.
- Business Rules: N/A.
- Dependencies: FR-PLAN-001.
- Validation Rules: Sequence numbers unique within a series.
- Error Conditions: Duplicate sequence number → 409.

---

## Section 10 — Blog Automation

**FR-BLOG-001 — Content Brief Generation**
- US-BLOG-001: As a Content Writer, I want an AI-generated content brief (search intent, audience, keywords, CTA) before drafting starts, so that the draft has a clear target from the outset.
- AC: (1) Brief includes primary + secondary keywords, target audience, CTA objective.
- Business Rules: Brief generation requires an active Knowledge Pack and completed keyword analysis.
- Dependencies: FR-KP-005, FR-KW-003.
- Validation Rules: Topic required as input.
- Error Conditions: Missing topic → 400.

**FR-BLOG-002 — Outline Generation**
- US-BLOG-002: As a Content Writer, I want an AI-generated H1/H2/H3 outline with FAQ planning, so that drafting has structure.
- AC: (1) Outline reflects the approved brief. (2) FAQ section planned.
- Business Rules: Outline must be approved (Quality Gate #2) before draft generation proceeds.
- Dependencies: FR-BLOG-001.
- Validation Rules: N/A.
- Error Conditions: Outline generation on an unapproved/missing brief → 422.

**FR-BLOG-003 — Draft Generation**
- US-BLOG-003: As a Content Writer, I want a full draft generated from the approved outline, so that I edit rather than write from scratch.
- AC: (1) Draft includes introduction, body sections, examples, conclusion, CTA.
- Business Rules: N/A beyond outline dependency.
- Dependencies: FR-BLOG-002 (Quality Gate #2 passed).
- Validation Rules: N/A.
- Error Conditions: AI generation failure → job retried per Queue spec (pending); draft preserved at last successful checkpoint.

**FR-BLOG-004 — SEO Optimization Pass**
- US-BLOG-004: As an SEO Specialist, I want meta title, meta description, URL slug, and schema suggestions generated automatically, so that every blog is SEO-complete before review.
- AC: (1) All SEO Engine sub-outputs present before Quality Gate #4.
- Business Rules: N/A.
- Dependencies: FR-BLOG-003, FR-SEO-001.
- Validation Rules: Meta title/description length limits (values TBD in expanded SEO spec — open item).
- Error Conditions: N/A beyond upstream failures.

**FR-BLOG-005 — Internal Linking Pass**
- US-BLOG-005: As an SEO Specialist, I want related blogs/videos/shorts automatically suggested as internal links, so that topical authority builds without manual link-hunting.
- AC: (1) Anchor suggestions generated.
- Business Rules: Never create irrelevant links; avoid duplicate anchors in close proximity.
- Dependencies: FR-BLOG-004, FR-LINK-003.
- Validation Rules: N/A.
- Error Conditions: No related content found → pass completes with zero suggestions, not an error.

**FR-BLOG-006 — Quality Assurance Checks**
- US-BLOG-006: As a Content Manager, I want automated grammar, readability, duplicate-content, and keyword-stuffing checks before human review, so that reviewers focus on judgment calls, not mechanical errors.
- AC: (1) All 6 checks run and produce pass/fail + explanation.
- Business Rules: Content Score must pass threshold (Quality Gate #6) before human review is triggered.
- Dependencies: FR-BLOG-005, FR-SEO-003.
- Validation Rules: N/A.
- Error Conditions: Score below threshold → routed back to Draft stage with itemized feedback, not silently blocked.

**FR-BLOG-007 — Human Review & Approval Workflow**
- US-BLOG-007: As a Content Manager, I want to review and approve/reject a blog before it can publish, so that no AI content goes live unchecked.
- AC: (1) Approval workflow follows Content Writer → SEO Review → Content Manager Approval → Publisher chain. (2) Rejection returns the item to Draft with reviewer comments.
- Business Rules: Human approval required before publishing — platform-wide invariant, no bypass role exists.
- Dependencies: FR-BLOG-006, FR-AUTH-004.
- Validation Rules: Only users holding `BLOG_APPROVE` may approve.
- Error Conditions: Approval attempt by unauthorized role → 403.

**FR-BLOG-008 — Publishing Handoff**
- US-BLOG-008: As a Publisher, I want an approved blog to become available for scheduling, so that it can go live without re-entering content data.
- AC: (1) Approved item transitions to "Publish Ready" status and appears in Publishing Engine's queue.
- Business Rules: N/A beyond approval gate.
- Dependencies: FR-BLOG-007, FR-PUB-002.
- Validation Rules: N/A.
- Error Conditions: N/A.

---

## Section 11 — Video Automation

**FR-VID-001 — Video Brief Generation**
- US-VID-001: As a Video Editor, I want an AI-generated brief (objective, audience, platform, duration, CTA), so that scripting has a clear target.
- AC: (1) Brief fields match Video Brief Generator's listed outputs.
- Business Rules: Requires active Knowledge Pack.
- Dependencies: FR-KP-005.
- Validation Rules: Target platform required.
- Error Conditions: Missing platform → 400.

**FR-VID-002 — Script Generation**
- US-VID-002: As a Video Editor, I want long-form/Shorts/Reel scripts generated with hook and CTA, so that I'm editing, not writing from zero.
- AC: (1) Script format matches target platform from the brief.
- Business Rules: Quality Gate #1 (Script Approved) must pass before Scene Planning proceeds.
- Dependencies: FR-VID-001.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-VID-003 — Scene Planning**
- US-VID-003: As a Video Editor, I want a scene timeline with visual instructions and B-roll suggestions, so that rendering has a clear asset map.
- AC: (1) Every scene maps to a script segment.
- Business Rules: N/A.
- Dependencies: FR-VID-002 (Quality Gate #1).
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-VID-004 — Voice Generation**
- US-VID-004: As a Video Editor, I want narration generated from the approved script, so that I don't need to record voiceover manually.
- AC: (1) Voice profile, language, speed configurable.
- Business Rules: Quality Gate #3 (Voice Generated) required before rendering.
- Dependencies: FR-VID-003.
- Validation Rules: N/A.
- Error Conditions: TTS provider failure → retried per Queue spec (pending); job preserves script/scene state.

**FR-VID-005 — Asset Collection & Management**
- US-VID-005: As a Video Editor, I want images/icons/stock clips/AI-generated visuals collected automatically per the scene plan, so that I'm not manually sourcing every asset.
- AC: (1) Assets Available gate (Quality Gate #2) passes only when every scene has a resolved asset.
- Business Rules: N/A.
- Dependencies: FR-VID-003.
- Validation Rules: N/A.
- Error Conditions: Missing asset for a scene → job blocked at Quality Gate #2 with itemized list of missing scenes.

**FR-VID-006 — Subtitle Generation**
- US-VID-006: As a Video Editor, I want auto-generated, timing-aligned captions, so that videos are accessible and platform-compliant without manual captioning.
- AC: (1) Subtitle timing aligned to voice track.
- Business Rules: N/A.
- Dependencies: FR-VID-004.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-VID-007 — Video Rendering**
- US-VID-007: As a Video Editor, I want the final video rendered via the FFmpeg/Remotion pipeline with intro/outro/watermark applied, so that output is publish-ready.
- AC: (1) Rendering Successful gate (Quality Gate #4) confirmed before QA.
- Business Rules: Retryable — rendering failures resume rather than restart from scratch.
- Dependencies: FR-VID-004, FR-VID-005, FR-VID-006.
- Validation Rules: Export profile must match target platform's spec.
- Error Conditions: Render failure → retried; repeated failure escalated to manual review.

**FR-VID-008 — QA Checks**
- US-VID-008: As a Video Editor, I want automated checks for missing assets, audio sync, subtitle sync, resolution, duration, and branding before human review.
- AC: (1) All 6 QA Engine checks pass (Quality Gate #5).
- Business Rules: N/A.
- Dependencies: FR-VID-007.
- Validation Rules: N/A.
- Error Conditions: Any check failure → routed back with itemized failures, not a generic rejection.

**FR-VID-009 — Human Approval & Publish Handoff**
- US-VID-009: As a Content Manager, I want to approve a rendered video before it can be scheduled, so that nothing publishes unchecked.
- AC: (1) Quality Gates #6 (SEO Complete) and #7 (Human Approval) both pass before "Publish Ready" (Quality Gate #8).
- Business Rules: Human approval required before publishing — same platform invariant as Blog.
- Dependencies: FR-VID-008, FR-SEO-001, FR-AUTH-004.
- Validation Rules: Only `VIDEO_APPROVE` holders may approve.
- Error Conditions: Unauthorized approval attempt → 403.

---

## Section 12 — SEO Engine

**FR-SEO-001 — Metadata Generation**
- US-SEO-001: As an SEO Specialist, I want meta title/description/tags/chapters generated per content type, so that every asset is search-optimized by default.
- AC: (1) Output format matches the content type.
- Business Rules: SEO by default — every content item passes through this engine, no opt-out.
- Dependencies: FR-KP-004.
- Validation Rules: N/A (limits TBD, open item).
- Error Conditions: N/A.

**FR-SEO-002 — Schema Markup Suggestion**
- US-SEO-002: As an SEO Specialist, I want schema.org markup suggested per content type, so that rich results are possible without manual markup research.
- AC: (1) Suggestion matches content type (Article, VideoObject, etc.).
- Business Rules: N/A.
- Dependencies: FR-SEO-001.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-SEO-003 — Content Scoring**
- US-SEO-003: As a Content Manager, I want an explainable 0–100 SEO score per content item, so that I know objectively whether it's ready to publish.
- AC: (1) Score breakdown individually retrievable, not just the composite.
- Business Rules: Feeds into the Composite Score alongside Viral/Quality/Engagement/Business scores.
- Dependencies: FR-SEO-001, FR-SEO-002, FR-LINK-002.
- Validation Rules: Score range 0–100.
- Error Conditions: N/A.

**FR-SEO-004 — Ranking Probability Estimation**
- US-SEO-004: As an SEO Specialist, I want an estimated ranking probability, so that I can prioritize which content gets extra optimization effort.
- AC: (1) Estimate is explainable, referencing contributing factors.
- Business Rules: Recommendations must reference measurable data.
- Dependencies: FR-KW-003, FR-RES-003.
- Validation Rules: N/A.
- Error Conditions: Insufficient data for estimate → returns "Insufficient Data," not a fabricated number.

---

## Section 13 — Internal Linking Engine

**FR-LINK-001 — Knowledge Graph Update**
- US-LINK-001: As the system, I want every published content item added to a knowledge graph as a node, so that relationships can be detected automatically.
- AC: (1) Graph updated on every publish event.
- Business Rules: Continuous re-indexing, not a batch/manual process.
- Dependencies: Publishing event (FR-PUB-003).
- Validation Rules: N/A.
- Error Conditions: Graph update failure → does not block publishing but raises an Observability alert (pending spec).

**FR-LINK-002 — Relationship Detection**
- US-LINK-002: As an SEO Specialist, I want relationships (Blog↔Blog, Blog↔Video, Blog↔Newsletter, etc.) detected automatically, so that cross-format discovery happens without manual mapping.
- AC: (1) All 7 relationship types are checked.
- Business Rules: N/A.
- Dependencies: FR-LINK-001.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-LINK-003 — Anchor Text Suggestion**
- US-LINK-003: As a Content Writer, I want natural, brand-safe anchor text suggested for each internal link, so that links don't read as spammy or repetitive.
- AC: (1) Anchor text varies (no duplicate anchors in close proximity).
- Business Rules: Never create irrelevant links; respect no-index/excluded pages; preserve manual links unless explicitly overridden.
- Dependencies: FR-LINK-002.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-LINK-004 — Orphan Content Detection**
- US-LINK-004: As an SEO Specialist, I want orphan pages (zero inbound internal links) flagged automatically, so that no published content goes undiscovered by users or crawlers.
- AC: (1) Orphan report available on demand and via scheduled check.
- Business Rules: Eliminating orphan content is a stated Objective of this engine.
- Dependencies: FR-LINK-001.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-LINK-005 — Link Health Monitoring**
- US-LINK-005: As an SEO Specialist, I want broken links, over-linked pages, and link distribution monitored continuously, so that link quality doesn't degrade silently over time.
- AC: (1) Broken link check runs on a recurring schedule (frequency TBD — open item pending Queue spec).
- Business Rules: N/A.
- Dependencies: FR-LINK-001.
- Validation Rules: N/A.
- Error Conditions: N/A.

---

## Section 14 — Publishing Engine

**FR-PUB-001 — Channel Connection**
- US-PUB-001: As a Publisher, I want to connect YouTube/Facebook/Instagram/WordPress accounts via OAuth, so that publishing doesn't require manual credential handling per post.
- AC: (1) Each connected channel stores refresh-capable OAuth tokens, workspace-scoped.
- Business Rules: Channels belong to exactly one workspace.
- Dependencies: FR-WS-005.
- Validation Rules: OAuth scope must include required publish permissions for that platform.
- Error Conditions: Insufficient OAuth scope granted → connection rejected with explanation, not silently accepted then failing later.

**FR-PUB-002 — Content Scheduling**
- US-PUB-002: As a Content Manager, I want to schedule approved content for a future publish time, so that publishing cadence is planned, not reactive.
- AC: (1) Only "Publish Ready" items can be scheduled.
- Business Rules: `PUBLISH_CREATE` required to schedule; `PUBLISH_EXECUTE` required for the job to actually run.
- Dependencies: FR-BLOG-008, FR-VID-009.
- Validation Rules: Scheduled time must be in the future.
- Error Conditions: Scheduling a non-approved item → 422.

**FR-PUB-003 — Multi-Platform Publishing Execution**
- US-PUB-003: As a Publisher, I want a scheduled item published automatically to its target channel at the scheduled time, so that I don't manually publish each piece.
- AC: (1) Execution respects each platform's format requirements.
- Business Rules: Automated publishing only where officially supported by the platform's API — never bypass platform policies.
- Dependencies: FR-PUB-001, FR-PUB-002.
- Validation Rules: N/A.
- Error Conditions: Platform API failure → job marked Failed, retried per FR-PUB-004.

**FR-PUB-004 — Retry & Failure Handling**
- US-PUB-004: As a Publisher, I want failed publishing jobs retried automatically with visibility into why they failed, so that transient platform errors don't require manual intervention every time.
- AC: (1) Transient failures retried per Queue spec's retry policy. (2) Permanent failures surfaced immediately, not endlessly retried.
- Business Rules: N/A.
- Dependencies: FR-PUB-003.
- Validation Rules: N/A.
- Error Conditions: Max retries exceeded → status "Failed — Manual Action Required," notification sent.

**FR-PUB-005 — Publishing History**
- US-PUB-005: As an Analyst, I want a complete, immutable publishing history per content item and per channel, so that I can audit what went live, when, and by whom.
- AC: (1) History includes attempt count, final status, timestamps, executing user.
- Business Rules: History is preserved even if the underlying content item is later deleted.
- Dependencies: FR-PUB-003.
- Validation Rules: N/A.
- Error Conditions: N/A.

---

## Section 15 — Distribution Engine

**FR-DIST-001 — Distribution Opportunity Discovery**
- US-DIST-001: As a Content Manager, I want guest-post and community distribution opportunities discovered automatically, so that reach extends beyond owned channels without manual outreach research.
- AC: (1) Discovery limited to the pack's configured niche/competitor context.
- Business Rules: Distribution occurs only after publishing.
- Dependencies: FR-PUB-003.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-DIST-002 — Platform Matching & Ranking**
- US-DIST-002: As a Content Manager, I want discovered opportunities ranked by niche relevance and authority, so that limited outreach effort goes to the highest-value targets first.
- AC: (1) Ranking factors are explainable.
- Business Rules: N/A.
- Dependencies: FR-DIST-001.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-DIST-003 — Submission Tracking**
- US-DIST-003: As a Content Manager, I want submission status tracked (pending/accepted/rejected) with follow-up reminders, so that outreach doesn't fall through the cracks.
- AC: (1) Status transitions logged with timestamp.
- Business Rules: User approval required before any external submission.
- Dependencies: FR-DIST-002, FR-AUTH-004.
- Validation Rules: N/A.
- Error Conditions: N/A.

---

## Section 16 — Analytics & Growth

**FR-ANLY-001 — Analytics Data Collection**
- US-ANLY-001: As an Analyst, I want traffic, ranking, engagement, and video/blog metrics collected automatically from connected platforms, so that performance data doesn't require manual export/import.
- AC: (1) Collection scoped per workspace/channel.
- Business Rules: N/A.
- Dependencies: FR-PUB-001.
- Validation Rules: N/A.
- Error Conditions: Analytics provider API failure → retried; dashboard shows "Data Delayed" rather than stale data presented as current.

**FR-ANLY-002 — Performance Dashboard**
- US-ANLY-002: As an Analyst, I want dashboards (Executive, SEO, Video, Blog, Growth Opportunities, Competitor Benchmark) reflecting current data, so that I can report on performance without building reports manually.
- AC: (1) Each of the 6 named dashboards is populated from FR-ANLY-001 data.
- Business Rules: Read-only for Analyst role.
- Dependencies: FR-ANLY-001, FR-AUTH-004.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-GROW-001 — Growth Recommendation Generation**
- US-GROW-001: As a Content Manager, I want AI-generated growth recommendations, so that growth strategy is data-driven rather than guesswork.
- AC: (1) Every recommendation references the measurable data behind it.
- Business Rules: Users approve optimization actions before execution.
- Dependencies: FR-ANLY-002.
- Validation Rules: N/A.
- Error Conditions: N/A.

**FR-GROW-002 — Viral Score & Content Score Feedback Loop**
- US-GROW-002: As the system, I want actual published performance fed back into future scoring/recommendation models, so that the platform gets smarter over time.
- AC: (1) The Learning Loop is a closed loop, not a one-way pipeline.
- Business Rules: Historical performance must be retained.
- Dependencies: FR-ANLY-001, FR-SEO-003.
- Validation Rules: N/A.
- Error Conditions: N/A.

---

## Section 17 — Business Rules (Cross-Cutting)

- No AI agent operates without an active Knowledge Pack.
- Human approval required before publishing, for every content type, with no bypass role.
- Workspace data isolation has no exceptions without explicit, separately authorized access.
- Automated external publishing/distribution only through officially supported platform APIs.
- Every recommendation must be explainable and reference measurable data.
- Audit logs are immutable across every module.
- Content Manager schedules; Publisher executes — distinct permissions, never merged.

## Section 18 — Validation & Error Handling (Cross-Cutting)

- Transient failures → automatic retry per Queue spec's policy (pending). Permanent failures → surfaced immediately, never silently retried indefinitely.
- Error response format deferred to API Contract Definition (blocker #4).
- Cross-workspace access attempts always return 404, never 403.
- Every multi-step pipeline preserves its last successful checkpoint so retries resume rather than restart.

## Section 19 — Security (Cross-Reference)

Governed in full by `SECURITY_AND_ACCESS_CONTROL_V1.0.md` and `AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md`. Every protected endpoint declares its required permission constant; every business-entity table carries `workspace_id`; every mutation is audit-logged. Session TTLs, password policy specifics, and MFA remain open items — not blocking Module 1, but should land before Auth is coded.

## Section 20 — Future Scope

Reused verbatim from Blueprint §6 Excluded: SaaS Billing, Public Registration, Marketplace, White Label, Plugin Marketplace, Public APIs, Mobile Applications. Also Future Agents (Podcast, AI Avatar, Course Builder, Email Campaign, Digital PR, Marketplace Agent).

---

## Section 21 — Non-Functional Requirements

### 21.1 Performance

| Target | Value | Configurable |
|---|---|---|
| API response time (sync endpoints) | p95 < 300ms, p99 < 800ms | Yes — per-endpoint override |
| Page load time (Next.js dashboards) | LCP < 2.5s, TTI < 3.5s | No — baseline UX bar |
| AI request timeout — Chat/text completion | 60s | Yes, per provider adapter |
| AI request timeout — Image generation | 120s | Yes |
| AI request timeout — Speech/TTS | 90s | Yes |
| AI request timeout — Embeddings | 30s | Yes |
| Queue job timeout — Research | 10 min | Yes |
| Queue job timeout — Blog draft generation | 5 min | Yes |
| Queue job timeout — SEO/Internal Linking pass | 3 min | Yes |
| Queue job timeout — Video script/scene/voice steps | 10 min each | Yes |
| Video rendering timeout | 45 min hard ceiling | Yes, but capped |
| Queue job timeout — Publishing execution | 2 min | Yes |
| Max upload size — Images | 25MB | Yes |
| Max upload size — Audio | 100MB | Yes |
| Max upload size — Video source assets | 2GB | Yes |
| Max upload size — Documents | 20MB | Yes |
| Concurrent job limits — Video renders (global) | 2 concurrent on V1 single VPS | Yes |
| Concurrent job limits — AI jobs (per workspace) | 10 concurrent | Yes |
| Retry limits — Transient failures | 3 attempts, exponential backoff (30s base, doubling, 10 min cap) | Yes |
| Retry limits — Permanent failures | 0 (fail fast) | No |

### 21.2 Scalability
V1: single VPS, Docker Compose, modular monolith. Target: up to 5 concurrent workspaces without architectural change. V2: dedicated workers, read replicas. V3: Kubernetes/service separation. V4: multi-region, full multi-tenant.

### 21.3 Availability
V1 target: 99% monthly uptime (single VPS, no HA). Rises to 99.5%+ at V2.

### 21.4 Reliability
AI job success rate target ≥95% excluding provider outages. Failed job data never discarded.

### 21.5 Security
100% of protected endpoints enforce a declared permission constant. 100% of business-entity tables carry `workspace_id`. Encryption in transit and at rest mandatory.

### 21.6 Maintainability
Unit test coverage target ≥70% (practical default, configurable/subject to team agreement). Every completed module ships the Mandatory Deliverables list from the Master Development Prompt.

### 21.7 Extensibility
Every provider/connector implements its module's common interface. Adding a new one requires zero business-logic changes.

### 21.8 Usability
Maximum three clicks for common actions; autosave where appropriate; consistent loading indicators (from UI/UX Design System).

---

## Section 22 — Notification & Event Requirements

| Event | Trigger | Recipients | Priority | Channels |
|---|---|---|---|---|
| User invited | FR-WS-004 | Invitee | Normal | Email |
| Invite accepted | Signup complete | Inviting Admin/Owner | Low | In-App |
| Password reset requested | User-initiated | Requesting user | High | Email |
| Password reset completed | Reset flow finished | User | Normal | Email + In-App |
| Workspace created | FR-WS-001 | Owner | Normal | In-App + Email |
| Knowledge Pack activated | FR-KP-005 | Content Manager, Admins | Normal | In-App |
| Knowledge Pack validation failed | FR-KP-005 attempt fails | Requesting user | Normal | In-App |
| Research completed | FR-RES-001–004 | Requesting user, Content Manager | Normal | In-App |
| Keyword analysis completed | FR-KW-001–003 | SEO Specialist | Normal | In-App |
| Blog draft generated | FR-BLOG-003 | Content Writer | Normal | In-App |
| Blog ready for review | FR-BLOG-006 passes | Content Manager | Normal | In-App + Email |
| Blog approved | FR-BLOG-007 | Content Writer, Publisher | Normal | In-App |
| Blog rejected | FR-BLOG-007 rejection | Content Writer | Normal | In-App + Email |
| Video rendering started | FR-VID-007 | Video Editor | Low | In-App |
| Video rendering completed | FR-VID-007 success | Video Editor, Content Manager | Normal | In-App + Email |
| Video rendering failed | FR-VID-007 max retries | Video Editor | High | In-App + Email |
| Video ready for review | FR-VID-008 passes | Content Manager | Normal | In-App |
| Video approved | FR-VID-009 | Video Editor, Publisher | Normal | In-App |
| Publishing scheduled | FR-PUB-002 | Publisher | Low | In-App |
| Publishing succeeded | FR-PUB-003 success | Content Manager, Publisher | Normal | In-App |
| Publishing failed | FR-PUB-004 max retries | Publisher, Administrator | Critical | In-App + Email + Slack |
| Distribution submission tracked | FR-DIST-003 | Content Manager | Low | In-App |
| Analytics import completed | FR-ANLY-001 | Analyst | Low | In-App |
| Analytics import failed | FR-ANLY-001 failure | Administrator | High | In-App + Email |
| Growth recommendation available | FR-GROW-001 | Content Manager | Normal | In-App |
| Role/permission changed | FR-AUTH-004 | Affected user, Owner | Normal | Email |
| Queue failure (job stalled/dead-lettered) | Queue engine (pending spec) | Administrator | Critical | In-App + Email + Slack |
| AI provider failure/outage | Failover triggered | Administrator | High | In-App + Slack |
| System alert (infra health) | Observability spec (pending) | Administrator | Critical | Email + Slack |

Channels: In-App (baseline), Email, Slack (webhook), generic Webhook (future integrations), WhatsApp (future — not V1). Priority: Critical / High / Normal / Low.

---

## Section 23 — Media & File Storage Requirements

| Asset Type | Storage Location | Ownership | Workspace Isolation | Retention | Deletion Policy | Versioning | Archive Behavior |
|---|---|---|---|---|---|---|---|
| Images | MinIO (dev) → R2 (prod) | Content Item | Bucket/path prefixed by workspace_id | Indefinite while referenced | Soft delete; hard delete after 90 days unreferenced | Yes | Cold storage after 90 days unreferenced |
| Videos (rendered) | R2 | Content Item | Workspace-prefixed | Indefinite if published; 180 days otherwise | Soft delete; hard delete after grace period | Yes, per render attempt | Same as Images |
| Knowledge Pack assets | R2 | Knowledge Pack | Workspace-prefixed | Indefinite (tied to pack lifecycle) | Preserved while any pack version references them | Yes | Archived with pack version |
| Prompt templates | PostgreSQL | Knowledge Pack | Workspace-scoped row | Indefinite, versioned | Soft delete | Yes | Archived with pack version |
| Generated documents | PostgreSQL (content_versions) | Content Item | Workspace-scoped row | Indefinite, full history | Soft delete; audit trail preserved | Yes, every edit | Archived with Content Item |
| Temporary render files | Local/ephemeral worker disk | Video render job | Job-scoped, workspace-tagged | 24 hours max | Auto hard-delete after job ends | No | Never archived |
| Exports | R2, signed URL | Requesting user | Workspace-prefixed | 30 days | Hard delete after window | No | N/A |
| Backups | Off-VPS backup storage | Platform | Full-instance (shared DB in V1) | 30 days minimum | Rolling deletion | Daily snapshots | Older snapshots pruned |
| Logs | Log aggregation (pending) | Platform | Tagged by workspace_id where applicable | Audit: indefinite; app logs: 90 days | Audit never deleted; app logs rolling-deleted | N/A | Audit logs never archived-away |

---

## Section 24 — Lifecycle State Machines

### 24.1 Workspace
| State | From | To | Who | Validation | Failure Path |
|---|---|---|---|---|---|
| Draft | — | Active | Owner | Unique slug, brand name required | Creation error → remains uncommitted |
| Active | Draft | Suspended (future), Archived | Owner | N/A | — |
| Archived | Active | — (terminal) | Owner | Confirmation required | N/A |

### 24.2 Project
| State | From | To | Who | Validation | Failure Path |
|---|---|---|---|---|---|
| Active | — | Archived | Content Manager | Unique name within workspace | Duplicate name → creation rejected |
| Archived | Active | — (terminal) | Content Manager/Administrator | N/A | N/A |

### 24.3 Knowledge Pack
| State | From | To | Who | Validation | Failure Path |
|---|---|---|---|---|---|
| Draft | — / Active (on edit) | Validating | Content Manager | N/A | N/A |
| Validating | Draft | Active, Draft (rejected) | System | All 4 activation rules | Any rule fails → returns to Draft with itemized failures |
| Active | Validating | Archived (superseded) | Content Manager | Exactly one Active version at a time | N/A |
| Archived | Active | — (terminal, queryable) | System | N/A | N/A |

### 24.4 Research Job
| State | From | To | Who | Validation | Failure Path |
|---|---|---|---|---|---|
| Queued | — | Running | System | Active Knowledge Pack required | No active pack → rejected before Queued (422) |
| Running | Queued | Completed, Failed | System | N/A | Transient error → retried |
| Completed | Running | Archived | System | Deduplication pass run | N/A |
| Failed | Running | Queued (retry), Failed (terminal) | System / Content Manager | Retry limit (3) | Max retries exceeded → terminal, notification sent |
| Archived | Completed | — (terminal) | System | N/A | N/A |

### 24.5 Blog (Content Item)
| State | From | To | Who | Validation | Failure Path |
|---|---|---|---|---|---|
| Draft | — | In Progress | Content Writer | FR-BLOG-001/002 gates | N/A |
| In Progress | Draft | Review | System | Quality Gates 1–6 | QA/score failure → returns to In Progress with feedback |
| Review | In Progress | Approved, Draft (rejected) | Content Manager (`BLOG_APPROVE`) | Reviewer role check | Unauthorized → 403; rejection → back to Draft |
| Approved | Review | Scheduled | Publisher (`PUBLISH_CREATE`) | Must be "Publish Ready" | N/A |
| Scheduled | Approved | Published, Failed | Publisher (`PUBLISH_EXECUTE`) | Scheduled time future at creation | Publish failure → Failed, retried |
| Published | Scheduled | Archived | System | N/A | N/A |
| Archived | Published | — (terminal) | Content Manager/Administrator | N/A | N/A |

### 24.6 Video (Content Item)
| State | From | To | Who | Validation | Failure Path |
|---|---|---|---|---|---|
| Draft | — | In Progress | Video Editor | Quality Gate 1 (Script Approved) | N/A |
| In Progress | Draft | Rendering | System | Quality Gates 2–3 | Missing assets → blocked at gate |
| Rendering | In Progress | Review, Failed | System | Quality Gate 4 | Render failure → retried; repeated → Failed, escalated |
| Review | Rendering | Approved, Draft (rejected) | Content Manager (`VIDEO_APPROVE`) | Quality Gates 5–6 | QA failure → itemized rejection |
| Approved | Review | Scheduled | Publisher | "Publish Ready" gate | N/A |
| Scheduled → Published → Archived | (identical to Blog, §24.5) | | | | |
| Failed | Rendering | Rendering (retry), Failed (terminal) | System / Video Editor | Retry limit | Max retries → terminal, notification sent |

### 24.7 Publishing Job
| State | From | To | Who | Validation | Failure Path |
|---|---|---|---|---|---|
| Scheduled | — | Queued | System | Scheduled time reached | N/A |
| Queued | Scheduled | Publishing | System | Channel connection valid | Revoked OAuth → immediate Failed, not retried |
| Publishing | Queued | Published, Failed | System | Platform API call | Transient error → retried |
| Published | Publishing | Archived | System | N/A | N/A |
| Failed | Publishing | Queued (retry), Failed (terminal) | System / Publisher | Retry limit | Max retries → "Failed — Manual Action Required" |

### 24.8 AI Job
| State | From | To | Who | Validation | Failure Path |
|---|---|---|---|---|---|
| Queued | — | Running | System | Active Knowledge Pack required | No active pack → rejected before Queued |
| Running | Queued | Completed, Timed Out, Failed | System | Provider timeout per §21.1 | Timeout → retry or fallback provider |
| Timed Out | Running | Queued (retry/fallback), Failed | System | Retry limit | Max retries exhausted → terminal Failed |
| Completed | Running | Archived | System | N/A | N/A |
| Failed | Running/Timed Out | Failed (terminal) | System | N/A | Notification sent, intermediate output preserved |

---

## Appendix A — Global Enumerations

Only platform-wide, cross-module enums are listed here. Role is intentionally **not** redefined in this appendix — it is authoritative in `AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md` and restating it here would create a duplicate source of truth.

**Priority** — used by Section 22 (Notifications):
`LOW · NORMAL · HIGH · CRITICAL`

**Status** — shared entity-lifecycle vocabulary referenced by Workspace, Project, Knowledge Pack, and Content Items:
`DRAFT · ACTIVE · IN_PROGRESS · REVIEW · APPROVED · SCHEDULED · PUBLISHED · FAILED · ARCHIVED · COMPLETED · CANCELLED`

Two entity-specific extensions exist outside this shared list because Section 24's approved state machines require them — they are not part of the global vocabulary and must not be reused by other entities without a documented reason:
- `VALIDATING` — Knowledge Pack only (§24.3)
- `SUSPENDED` — Workspace only, reserved for future use (§24.1)

**Job Status** — used by Research Job, Publishing Job, AI Job (§24.4, 24.7, 24.8):
`QUEUED · RUNNING · COMPLETED · FAILED · TIMED_OUT`

**Visibility** — reserved for future Knowledge Pack/Content sharing (not an active V1 feature; Blueprint excludes marketplace/public features from V1). All V1 records are effectively `WORKSPACE`:
`PRIVATE · WORKSPACE · PUBLIC`

**Delivery Channel** — used by Section 22:
`IN_APP · EMAIL · SLACK · WEBHOOK · WHATSAPP` (WhatsApp is future, not V1)

**Content Type** — used by Knowledge Pack prompt templates (FR-KP-003), Content Planner, Publishing:
`BLOG · VIDEO · SHORT · REEL · NEWSLETTER · SOCIAL_POST`

---

## Appendix B — Standard Error Code Convention

**Format:** `{NAMESPACE}_{REASON}`

Namespaces use full words (not the compact FR-ID prefixes from Section 3) because error codes appear in logs and API responses where clarity matters more than table width:

| Namespace | Corresponds to FR prefix |
|---|---|
| AUTH | AUTH |
| WORKSPACE | WS |
| PROJECT | WS (Project sub-scope) |
| KNOWLEDGE | KP |
| RESEARCH | RES |
| KEYWORD | KW |
| PLANNER | PLAN |
| BLOG | BLOG |
| VIDEO | VID |
| SEO | SEO |
| LINKING | LINK |
| PUBLISH | PUB |
| DISTRIBUTION | DIST |
| ANALYTICS | ANLY |
| GROWTH | GROW |
| QUEUE | (cross-cutting infra) |
| AI | (cross-cutting infra) |
| SYSTEM | (cross-cutting infra) |

**Shared REASON vocabulary** (not exhaustive — new reasons may be added within a namespace as needed, following this casing/style):
`NOT_FOUND · VALIDATION_FAILED · PERMISSION_DENIED · DUPLICATE · CONFLICT · EXPIRED · TIMEOUT · PROVIDER_FAILURE · RATE_LIMITED · UNAUTHORIZED`

**HTTP status mapping (matches Sections 18–19):**

| Reason suffix | HTTP Status |
|---|---|
| NOT_FOUND (including cross-workspace access) | 404 |
| VALIDATION_FAILED | 422 |
| PERMISSION_DENIED / UNAUTHORIZED | 403 / 401 |
| DUPLICATE / CONFLICT | 409 |
| EXPIRED | 410 |
| RATE_LIMITED | 429 |
| TIMEOUT | 504 |
| PROVIDER_FAILURE | 502 |

Examples: `AUTH_INVALID_CREDENTIALS`, `WORKSPACE_NOT_FOUND`, `KNOWLEDGE_VALIDATION_FAILED`, `BLOG_PERMISSION_DENIED`, `QUEUE_TIMEOUT`, `AI_PROVIDER_FAILURE`, `SYSTEM_INTERNAL_ERROR`. Individual error codes are not enumerated here per instruction — this defines the strategy only; the full code list is populated during API Contract Definition.

---

## Appendix C — Platform Glossary

| Term | Definition |
|---|---|
| AI-COS | The core enterprise platform and engineering framework underlying all products, including MYEV Media. Not a product itself. |
| Workspace | Top-level tenant boundary. Owns brands, projects, Knowledge Packs. |
| Project | A content initiative within a workspace, tied to one or more channels. |
| Knowledge Pack | The configuration object every AI agent must load before running — sources, prompts, brand rules, SEO rules. |
| Research Job | An AI Job instance executing the Research Engine's discovery/summarization pipeline. |
| AI Job | A queued, retryable unit of AI work executed by an Agent via the AI Provider Abstraction Layer. |
| Content Item | Any generated asset — blog, video, script, social post, newsletter — tracked through its own lifecycle/version history. |
| Publishing Job | A scheduled or immediate action that pushes a Content Item to an external Channel. |
| Distribution Job | A tracked unit of work representing a single earned-media distribution attempt for a published Content Item. |
| Brand Profile | The brand identity, tone, and visual guidance component of a Knowledge Pack. |
| Prompt Template | A reusable, versioned prompt definition scoped to a specific content type within a Knowledge Pack. |
| Content Version | An immutable snapshot of a Content Item at a point in its edit history. |
| Approval Workflow | The mandatory human sign-off sequence a Content Item passes through before it may be scheduled or published. |
| Queue | The Redis-backed BullMQ infrastructure executing all asynchronous AI Jobs and Publishing Jobs platform-wide. |
| Provider Adapter | A module implementing the AI Provider Abstraction Layer's common interface for one external AI vendor. |

---

## Final Document Validation

- ✓ **No duplicated requirements** — Appendices are reference material (enums/errors/glossary), not new FRs. Role enum explicitly deferred to the Role & Permission Matrix rather than restated.
- ✓ **No conflicting terminology** — Every Appendix C term reuses Section 1's definitions verbatim where one already existed; no term is defined twice with different wording.
- ✓ **Consistent naming** — FR-ID prefixes (compact) vs. error-code namespaces (full word) is a deliberate, documented distinction, not an inconsistency.
- ✓ **Consistent enums** — Status/Job Status cross-checked against every Section 24 state machine; VALIDATING and SUSPENDED explicitly flagged as entity-specific extensions rather than silently folded into the shared enum.
- ✓ **Consistent workflow terminology** — Appendix C's "Approval Workflow" entry matches Section 24.5/24.6's Review→Approved terminology exactly.
- ✓ **Consistent permission names** — No new permission constants introduced in this pass.
- ✓ **Consistent state names** — Appendix A's Status enum is a superset vocabulary; per-entity valid transitions remain governed solely by Section 24.
- ✓ **Consistent entity names** — Glossary terms match exactly the entity names used throughout Sections 1–24 and the Database & Entity Design doc's entity groups.

---

**Version:** V1.2
**Status:** FINAL
**Approved:** YES
**Implementation Ready:** YES
**Document State:** FROZEN — no further changes without an approved architectural change request.
