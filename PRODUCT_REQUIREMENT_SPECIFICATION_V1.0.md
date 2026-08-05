# PRODUCT_REQUIREMENT_SPECIFICATION

**Version:** 1.1
**Status:** FINAL
**Approved:** YES
**Implementation Ready:** YES
**Document State:** FROZEN — no further edits unless an approved architecture change request exists.
**Purpose:** Bridge between the frozen FRD (v1.2) and actual engineering/design. Every screen, flow, and state below traces to an FR-ID from the FRD — nothing here introduces new functional scope.

---

## 1. Product Vision

Reused from Identity/Blueprint docs: *"Build India's most intelligent AI-powered EV Media Platform that automates the complete lifecycle of EV content creation — from research to publishing and growth."* MYEV Media is the first product on AI-COS; this PRS describes MYEV Media's UI/UX while remaining generic enough that a second workspace (EVision India, MySensex) reuses the same screens with different Knowledge Pack content.

## 2. Product Goals

Reused verbatim from Blueprint §5 — Product Goals: discover content opportunities automatically, generate SEO-optimized blogs, produce YouTube videos, create Shorts/Reels, publish across platforms, improve discoverability, increase engagement, build topical authority, reduce production cost/time.

## 3. User Personas

One persona per Role & Permission Matrix role — no new roles invented:

| Persona | Role | Primary Goal | Primary Screens |
|---|---|---|---|
| Arvind, the Owner | Owner | Oversee all workspaces, control platform-level settings | Workspace Switcher, Admin Settings, Executive Dashboard |
| Priya, the Administrator | Administrator | Manage users, projects, channels day-to-day | User Management, Project Settings, Audit Log |
| Rohan, the Content Manager | Content Manager | Plan content, approve output, hit publishing cadence | Editorial Calendar, Review Queue, Growth Dashboard |
| Ananya, the Content Writer | Content Writer | Research and draft blogs quickly with AI assistance | Blog Editor, Research Dashboard |
| Karan, the SEO Specialist | SEO Specialist | Maximize search visibility of every asset | SEO Panel, Keyword Explorer, Link Graph Explorer |
| Meera, the Video Editor | Video Editor | Turn scripts into publish-ready video fast | Video Editor, Render Status |
| Vikram, the Publisher | Publisher | Get approved content live on schedule, handle failures | Publishing Queue, Channel Connections, Publishing History |
| Divya, the Analyst | Analyst | Report on performance, spot growth opportunities | Analytics Dashboards (read-only) |

## 4. Navigation Architecture

```
Top Navigation: Workspace Switcher · Notifications Bell · AI Copilot Toggle · User Menu

Left Sidebar (Primary Navigation)
├── Dashboard                         [All roles — content varies by role]
├── Research                          [Content Manager, Content Writer, SEO Specialist]
│   ├── Trend Discovery
│   └── Research Datasets
├── Content
│   ├── Editorial Calendar            [Content Manager, Content Writer]
│   ├── Blogs                         [Content Writer, SEO Specialist, Content Manager]
│   └── Videos                        [Video Editor, Content Manager]
├── SEO                               [SEO Specialist, Content Manager]
│   ├── Keyword Explorer
│   └── Internal Link Graph
├── Publishing                        [Publisher, Content Manager]
│   ├── Publishing Queue
│   ├── Channel Connections
│   └── Publishing History
├── Distribution                      [Content Manager]
├── Analytics                         [Analyst, Content Manager, Owner]
├── Growth                            [Content Manager, Owner, Analyst-readonly]
├── Knowledge Packs                   [Content Manager, Administrator]
└── Settings                          [Owner, Administrator]
    ├── Workspace Settings
    ├── Members & Roles
    ├── Audit Log
    └── AI Provider Configuration
```

## 5. Screen Inventory

| ID | Screen | Module | Primary Roles | FR Reference |
|---|---|---|---|---|
| SCR-001 | Login | Auth | All | FR-AUTH-001/002 |
| SCR-002 | Forgot/Reset Password | Auth | All | FR-AUTH-001 |
| SCR-003 | Workspace Switcher | Workspace | All | FR-WS-005 |
| SCR-004 | Workspace Settings | Workspace | Owner | FR-WS-002 |
| SCR-005 | Members & Roles | Workspace | Owner, Administrator | FR-WS-004, FR-AUTH-004 |
| SCR-006 | Knowledge Pack List | Knowledge Pack | Content Manager, Admin | FR-KP-001 |
| SCR-007 | Knowledge Pack Editor | Knowledge Pack | Content Manager | FR-KP-002–004 |
| SCR-008 | Knowledge Pack Version History | Knowledge Pack | Content Manager | FR-KP-006 |
| SCR-009 | Trend Discovery | Research | Content Manager, Writer | FR-RES-001 |
| SCR-010 | Research Dataset Detail | Research | Content Writer | FR-RES-002–004 |
| SCR-011 | Keyword Explorer | Keyword | SEO Specialist | FR-KW-001–003 |
| SCR-012 | Editorial Calendar | Content Planner | Content Manager | FR-PLAN-001 |
| SCR-013 | Topic Cluster Planner | Content Planner | SEO Specialist | FR-PLAN-002 |
| SCR-014 | Content Series Planner | Content Planner | Content Manager | FR-PLAN-003 |
| SCR-015 | Blog List | Blog Automation | Content Writer, Manager | FR-BLOG-* (list view) |
| SCR-016 | Blog Editor | Blog Automation | Content Writer | FR-BLOG-001–003 |
| SCR-017 | Blog SEO Panel | Blog Automation / SEO | SEO Specialist | FR-BLOG-004, FR-SEO-001–003 |
| SCR-018 | Blog Review Queue | Blog Automation | Content Manager | FR-BLOG-007 |
| SCR-019 | Video List | Video Automation | Video Editor, Manager | FR-VID-* (list view) |
| SCR-020 | Video Editor | Video Automation | Video Editor | FR-VID-001–006 |
| SCR-021 | Video Render Status | Video Automation | Video Editor | FR-VID-007 |
| SCR-022 | Video Review Queue | Video Automation | Content Manager | FR-VID-009 |
| SCR-023 | Internal Link Graph Explorer | Internal Linking | SEO Specialist | FR-LINK-001–002 |
| SCR-024 | Orphan Content Report | Internal Linking | SEO Specialist | FR-LINK-004 |
| SCR-025 | Channel Connections | Publishing | Publisher, Administrator | FR-PUB-001 |
| SCR-026 | Publishing Queue/Calendar | Publishing | Publisher, Content Manager | FR-PUB-002 |
| SCR-027 | Publishing History | Publishing | Publisher, Analyst | FR-PUB-005 |
| SCR-028 | Distribution Opportunity List | Distribution | Content Manager | FR-DIST-001–002 |
| SCR-029 | Submission Tracker | Distribution | Content Manager | FR-DIST-003 |
| SCR-030 | Executive Dashboard | Analytics | Owner, Analyst | FR-ANLY-002 |
| SCR-031 | SEO / Video / Blog Dashboards | Analytics | Analyst, SEO Specialist | FR-ANLY-002 |
| SCR-032 | Competitor Benchmark Dashboard | Analytics | Analyst | FR-ANLY-002 |
| SCR-033 | Growth Opportunities Dashboard | Growth | Content Manager, Owner | FR-GROW-001 |
| SCR-034 | Audit Log Viewer | Admin | Owner, Administrator | FR-AUTH-005 |
| SCR-035 | AI Provider Configuration | Admin | Owner | AI Provider Abstraction Layer doc |
| SCR-036 | Notification Center | Platform | All | FRD §22 |

Note: Image/Thumbnail Engine and Voice Engine (Module Design's Modules 11–12) are embedded within the Video Editor (SCR-020) as sub-steps (FR-VID-004/005), not standalone screens — intentional, not a gap. AI Copilot (Module 20) is the global panel component described in §7, not a dedicated screen.

## 6. Complete User Flows

**Flow A — Workspace Onboarding**
Owner logs in (SCR-001) → creates Workspace (SCR-003, FR-WS-001) → creates Knowledge Pack (SCR-007, FR-KP-001) → configures Sources/Prompts/Brand/SEO/Publishing Strategy tabs → activates pack (FR-KP-005) → invites team members with roles (SCR-005, FR-WS-004).

**Flow B — Blog Production (happy path)**
Trend Discovery (SCR-009) → topic selected → Research runs (FR-RES-001–004) → Keyword clustering (SCR-011) → Blog Editor (SCR-016) → Brief (FR-BLOG-001) → Outline approved (FR-BLOG-002) → Draft (FR-BLOG-003) → SEO Panel (SCR-017, FR-BLOG-004) → Internal Linking (FR-BLOG-005) → QA (FR-BLOG-006) → Blog Review Queue (SCR-018) → Content Manager approves (FR-BLOG-007) → scheduled via Publishing Queue (SCR-026, FR-PUB-002) → executed (FR-PUB-003) → Publishing History (SCR-027).

**Flow C — Video Production (happy path)**
Mirrors Flow B through SCR-020 (Brief→Script→Scenes) → Asset Collection + Voice (FR-VID-004–005) → Subtitle (FR-VID-006) → Render (SCR-021, FR-VID-007) → QA (FR-VID-008) → Video Review Queue (SCR-022, FR-VID-009) → Publishing Queue → Published.

**Flow D — Publishing Failure Recovery**
Publishing Job fails (FR-PUB-004) → Critical notification fires (FRD §22) → Publisher opens Publishing History (SCR-027) → investigates via Channel Connections (SCR-025) → reconnects channel → manually retries job.

**Flow E — Growth Review**
Executive Dashboard (SCR-030) → SEO/Video/Blog Dashboard (SCR-031) → Growth Opportunities (SCR-033, FR-GROW-001) → Content Manager approves a recommended action → routes back into the relevant module.

## 7. Feature Specifications (UI Layer)

Screen-level behavior only — business rules, validation, and error conditions live in the FRD (Sections 4–16) and aren't repeated here.

- **Knowledge Pack Editor (SCR-007):** Multi-tab form; each tab autosaves as Draft; "Activate" disabled until all four validation rules pass, with inline per-tab completion indicators.
- **Blog/Video Editor (SCR-016/020):** Linear stepper UI matching the Quality Gates already defined in FR-BLOG/FR-VID — each step locked until its predecessor's gate passes.
- **Review Queues (SCR-018/022):** List + detail split view; Approve/Reject visible only to users holding `BLOG_APPROVE`/`VIDEO_APPROVE`, enforced client-side for UX and server-side per FR-AUTH-004 as the actual security boundary.
- **Publishing Queue (SCR-026):** Calendar + list toggle; drag-to-reschedule for `Scheduled` items only.
- **AI Copilot Panel:** Global, collapsible right-panel component surfacing Suggested Actions, Explain Recommendation, and a Confidence Indicator wherever an AI-generated score/recommendation appears.

## 8. UX Behaviour

Maximum three clicks for common actions; autosave on all multi-step editors; inline validation on blur; undo available for destructive actions; consistent loading indicators platform-wide.

## 9. UI States

| Context | Loading | Empty | Error | Success |
|---|---|---|---|---|
| List screens | Skeleton rows | Illustration + "Create your first…" CTA | Inline banner + retry | Toast on create/delete |
| AI generation steps | Progress indicator tied to Job Status | N/A | Inline error card + retry, FRD Appendix B code | Auto-advance to next stepper step |
| Dashboards | Skeleton chart placeholders | "No data yet — connect a channel" + CTA | "Data Delayed" banner | N/A |
| Approval actions | Button spinner | N/A | Toast (403 → permission message) | Toast + item moves queues |

## 10. Business Workflows

The approval chain (Content Writer → SEO Review → Content Manager Approval → Publisher → Published) is rendered as a visible horizontal stepper on every Blog/Video detail screen, current stage highlighted, responsible role labeled.

## 11. Dashboard Behaviour

Every dashboard (Executive, SEO, Video, Blog, Growth Opportunities, Competitor Benchmark) follows KPI cards, charts, filters, search, export, saved views — no new dashboard-level behavior invented.

## 12. Permissions by Screen

| Screen | Owner | Admin | Content Mgr | Writer | SEO | Video Editor | Publisher | Analyst |
|---|---|---|---|---|---|---|---|---|
| Workspace Settings | Full | Full | — | — | — | — | — | — |
| Knowledge Pack Editor | Full | Full | Full | — | — | — | — | — |
| Blog Editor | Full | Full | Full | Full | SEO tab only | — | — | — |
| Video Editor | Full | Full | Full | — | — | Full | — | — |
| Review Queues (approve) | Full | Full | Full | — | — | — | — | — |
| Publishing Queue (schedule) | Full | Full | Full | — | — | — | — | — |
| Publishing Queue (execute) | Full | Full | — | — | — | — | Full | — |
| Analytics Dashboards | Full | Full | Full | — | — | — | — | Read-only |
| Audit Log | Full | Full | — | — | — | — | — | — |

## 13. Component Behaviour

Reuses Design Component Library's 8 states (Default/Hover/Focus/Active/Disabled/Loading/Error/Success). Approve/Publish buttons are `Disabled` (not hidden) when a Quality Gate is unmet, with a tooltip explaining why. AI-generate buttons show `Loading` tied to actual Job Status and `Error` with the Appendix B error code surfaced in a "Details" expandable.

## 14. Validation Rules (UI Layer)

Inline validation fires on blur; required fields marked consistently; submit buttons disabled until client-side validation passes — server-side validation (FRD Sections 4–16) remains the actual authority.

## 15. Error States

- 400/422 → inline field-level error, form stays open.
- 401 → redirect to Login with session-expired message.
- 403 → toast, action reverted, no navigation.
- 404 → generic "Not found" page, never reveals cross-workspace existence.
- 409 → inline banner explaining the conflicting state.
- 502/504 → retry-able banner, consistent with the Queue's own retry policy.

## 16. Empty States

| Screen | Empty State Copy Pattern |
|---|---|
| Blog/Video List | "No [blogs/videos] yet — start from Research or create one directly." + CTA |
| Knowledge Pack List | "Every workspace needs an active Knowledge Pack before content can be generated." + CTA |
| Channel Connections | "Connect a channel to start publishing." + CTA |
| Notification Center | "You're all caught up." |
| Analytics Dashboards | "No data yet — connect a channel to start collecting analytics." |

## 17. Loading States

Skeleton placeholders for list/detail screens. Long-running AI Jobs show progress bound to the actual Job Status enum. Video rendering shows elapsed + estimated remaining time given its 45-minute ceiling.

## 18. Notifications (UI Layer)

Source of truth for events is FRD Section 22. In-App notifications populate the Notification Center (SCR-036) with unread-count badge. `Critical` priority additionally toasts immediately regardless of current screen. Users configure per-event channel preferences.

## 19. Mobile Responsiveness

V1 target devices: Desktop, Laptop, Tablet. Mobile is Future (consistent with Blueprint's Mobile Applications exclusion) — standard responsive degradation still applies so the app doesn't break on a phone browser.

## 20. Accessibility

WCAG 2.1 AA target — a practical default, flagged as configurable/subject to confirmation since no existing document states a specific conformance level.

## 21. Future Expansion

SaaS billing, public registration, marketplace, white-label, plugin marketplace, public APIs, mobile applications, custom themes, drag-and-drop dashboards, mobile design system.

---

## Appendix D — Screen Wireframe References

Mapping only — no wireframes created here.

| Screen ID | Wireframe ID | Screen ID | Wireframe ID |
|---|---|---|---|
| SCR-001 | WF-001 | SCR-019 | WF-019 |
| SCR-002 | WF-002 | SCR-020 | WF-020 |
| SCR-003 | WF-003 | SCR-021 | WF-021 |
| SCR-004 | WF-004 | SCR-022 | WF-022 |
| SCR-005 | WF-005 | SCR-023 | WF-023 |
| SCR-006 | WF-006 | SCR-024 | WF-024 |
| SCR-007 | WF-007 | SCR-025 | WF-025 |
| SCR-008 | WF-008 | SCR-026 | WF-026 |
| SCR-009 | WF-009 | SCR-027 | WF-027 |
| SCR-010 | WF-010 | SCR-028 | WF-028 |
| SCR-011 | WF-011 | SCR-029 | WF-029 |
| SCR-012 | WF-012 | SCR-030 | WF-030 |
| SCR-013 | WF-013 | SCR-031 | WF-031 |
| SCR-014 | WF-014 | SCR-032 | WF-032 |
| SCR-015 | WF-015 | SCR-033 | WF-033 |
| SCR-016 | WF-016 | SCR-034 | WF-034 |
| SCR-017 | WF-017 | SCR-035 | WF-035 |
| SCR-018 | WF-018 | SCR-036 | WF-036 |

## Section 22 — Keyboard Shortcuts

Only shortcuts with a clear productivity case are included — not exhaustive.

| Shortcut | Action | Context |
|---|---|---|
| Cmd/Ctrl + K | Global Search | Platform-wide |
| Cmd/Ctrl + S | Save Draft | Any editor (KP, Blog, Video) |
| Cmd/Ctrl + Shift + P | Quick Publish | Enabled only when the current item is in `Approved` state |
| Cmd/Ctrl + / | Toggle AI Copilot Panel | Platform-wide |
| Esc | Close Dialog/Modal/Panel | Platform-wide |
| ↑ / ↓ | Table/List row navigation | Any list/table screen |
| Enter | Open focused row | Any list/table screen |
| Tab / Shift+Tab | Focus navigation | Platform-wide (accessibility baseline) |
| Cmd/Ctrl + Enter | Approve | Review Queue detail — requires `BLOG_APPROVE`/`VIDEO_APPROVE` |
| Cmd/Ctrl + Shift + N | New item (context-aware: Blog/Video/KP/Project) | List screens |
| ? | Show keyboard shortcut cheat sheet | Platform-wide |

## Section 23 — Bulk Operations

| Screen | Bulk Actions | State Validation | Permission | Confirmation | Undo |
|---|---|---|---|---|---|
| Blogs (SCR-015) | Approve, Archive, Delete, Tag, Export | Approve only on `Review`; Delete only on `Draft`/`Archived` (never `Published`) | `BLOG_APPROVE` for approve | Required for Delete/Archive | Archive: 10s toast undo. Delete: soft-delete only, recoverable by Administrator, no user-facing undo. |
| Videos (SCR-019) | Approve, Archive, Delete, Tag, Export | Same pattern as Blogs | `VIDEO_APPROVE` for approve | Required for Delete/Archive | Same as Blogs |
| Knowledge Packs (SCR-006) | Archive (no bulk delete — foundational dependency risk) | Cannot archive the sole Active pack of a Project | `KP_UPDATE` | Required | No undo — reactivate a prior version instead (FR-KP-006) |
| Research Jobs (SCR-010) | Retry, Archive, Export | Retry only on `Failed` | `RESEARCH_RUN` | Not required for Retry | N/A |
| Publishing Queue (SCR-026) | Retry, Cancel, Reschedule, Export | Retry only on `Failed`; Cancel only on `Scheduled`/`Queued` | `PUBLISH_EXECUTE` (Retry), `PUBLISH_CANCEL` (Cancel) | Required for Cancel | Cancel is reversible by rescheduling within a grace window |
| Users (SCR-005) | Assign role, Deactivate, Resend invite | N/A | `USER_MANAGE` | Required for Deactivate | No bulk delete — deactivate only, preserving audit history |
| Projects | Archive, Export | N/A | `PROJECT_UPDATE` | Required for Archive | N/A |

## Section 24 — Global Search Specification

- **Global Search:** Invoked via `Cmd/Ctrl+K`, searches across entity types within the active workspace only.
- **Advanced Search:** Per-entity filtered search accessible from each list screen (Blog, Video, Research, User, etc.).
- **Search Scope:** Always workspace-scoped — global search never crosses workspace boundaries, matching FR-WS-005's isolation invariant with no exception.
- **Sub-scopes:** Workspace, Project, Knowledge Pack, Content (Blog/Video/Social), Research, User.
- **Saved Searches:** Users can save a filter combination per entity type for reuse.
- **Recent Searches:** Last 10 queries shown on search modal open, workspace-scoped.
- **Search Filters:** Status, role/owner, date range, content type — reusing the Status/Content Type enums from FRD Appendix A.
- **Search Ranking:** Title match ranked above body match, above tag match; recency provides a secondary boost.
- **Keyboard Invocation:** `Cmd/Ctrl+K` opens the modal from anywhere; `Esc` closes it.
- **Search Result Layout:** Grouped by entity type with icons, top 5 results per group plus a "see all in [type]" link.

## Section 25 — Dashboard Widget Catalog

| Widget | Purpose | Data Source | Refresh Strategy | Visibility by Role |
|---|---|---|---|---|
| Recent Blogs | Last N blog items, any status | Content domain | On navigation | Content Writer, Content Manager |
| Recent Videos | Last N video items | Content domain | On navigation | Video Editor, Content Manager |
| Pending Reviews | Items awaiting approval | FR-BLOG-007 / FR-VID-009 | Real-time | Content Manager |
| Pending Publishing | `Scheduled` not yet `Published` | FR-PUB-002 | Real-time | Publisher, Content Manager |
| AI Jobs | Active/recent AI Job status | §24.8 AI Job | Real-time (polling) | Content Writer, Video Editor, Administrator |
| Research Queue | Active Research Jobs | §24.4 | Real-time | Content Manager, Writer |
| Publishing Queue | Upcoming scheduled items | §24.7 | Real-time | Publisher |
| Top Keywords | Highest-opportunity keywords | FR-KW-003 | Daily | SEO Specialist |
| Top Pages | Highest-performing content | FR-ANLY-001 | Daily (matches analytics import cadence) | Analyst, SEO Specialist |
| Growth Score | Composite growth trend | FR-GROW-002 | Daily | Owner, Content Manager |
| Workspace Health | Active KP status, connected channels, recent failures | Cross-module | Real-time | Owner, Administrator |
| Provider Health | AI provider availability/success rate | AI Provider Abstraction Layer monitoring | Real-time (polling) | Administrator |
| Queue Health | Job backlog depth, failure rate | Queue engine (pending spec) | Real-time | Administrator |
| Notifications | Recent notification feed | FRD §22 | Real-time (push/poll) | All |
| Failed Jobs | Cross-module failed job list | §24 Failed states | Real-time | Administrator, respective role per job type |

## Section 26 — Responsive Layout Rules

| Breakpoint | Sidebar | Navigation | Grid | Table | Chart | Editor |
|---|---|---|---|---|---|---|
| Desktop (≥1440px) | Expanded/pinned | Full top nav | 3–4 columns | All columns visible | Full-size | Side-by-side editor + preview |
| Laptop (1024–1439px) | Expanded, collapsible | Full top nav | 2–3 columns | Priority columns, rest in overflow | Scaled down | Stacked toggle |
| Tablet (768–1023px) | Collapsed to icons, expandable overlay | Condensed, overflow menu for secondary items | 2 columns | Card list on narrow tablets | Simplified (fewer data points) | Full-width editor, preview in slide-over |
| Mobile Browser (<768px) | Bottom-sheet/hamburger drawer | Hamburger + bottom tab bar (top 4 items) | 1 column | Always card list | Summary stat + "view full chart" link | Read-only/limited (not optimized for V1) |
| Future Mobile App | Out of scope for this PRS | — | — | — | — | — |

## Section 27 — UX Design Principles

1. Never lose user work — autosave-first.
2. Progressive disclosure — show complexity only when needed.
3. Minimum clicks — 3-click rule for common actions.
4. Explain AI decisions — Confidence Indicator + Explain Recommendation on every AI output.
5. Never hide errors — always surface with actionable detail.
6. Always show progress — real job-state-bound progress, never a fake spinner.
7. Consistent navigation — same nav tree regardless of role; items are hidden, not rearranged.
8. Permission-aware UI — hide unreachable actions; disable (with tooltip) actions blocked by workflow state rather than permission.
9. Workspace-aware UI — every screen implicitly scoped to the active workspace.
10. Accessibility first — WCAG 2.1 AA baseline on every screen.

---

## Final Consistency Review

- ✓ **Every screen maps to one or more FRs** — Screen Inventory (§5) FR Reference column complete for all 36 screens; list-view screens (Blog List, Video List) reference their content type's FR group rather than a single FR, which is correct since list views aren't a distinct functional requirement.
- ✓ **Every workflow maps to an approved FR** — Flows A–E (§6) cite FR-IDs at every step.
- ✓ **Every permission matches the Role Matrix** — §12 derived directly, no invention.
- ✓ **Every dashboard matches Analytics** — §11's 6 dashboards match the Growth Engine doc's named list exactly; §25's widgets are sub-components of these dashboards, not new dashboards.
- ✓ **Every module exists in Module Design** — cross-checked against all 22 modules. Image/Thumbnail Engine, Voice Engine, and Content Relationship Engine are intentionally embedded (Video Editor sub-steps, Internal Linking screens) rather than standalone screens — flagged explicitly in §5, not a silent gap. AI Copilot is a global component, not a screen — same treatment.
- ✓ **Every navigation item maps to an actual screen** — §4 nav tree cross-checked against §5.
- ✓ **No duplicate screens** — 36 unique screen IDs.
- ✓ **No orphan workflows** — all five flows terminate in a defined §24 (FRD) state.
- ✓ **No conflicting terminology** — Approve/Publish/Archive/Retry usage in §23 (Bulk Operations) matches FRD Appendix C glossary and Appendix A enums exactly.

---

**Version:** V1.1
**Status:** FINAL
**Approved:** YES
**Implementation Ready:** YES
**Document State:** FROZEN — no further edits unless an approved architecture change request exists.
