# MODULE_ROADMAP_V1.0.md

# MYEV Media / AI Content Operating System (AI-COS)

## Development Module Roadmap

**Version:** 1.0\
**Status:** FINAL\
**Phase:** Post-Phase-0 (Module 1F freeze / Module 2 pre-kickoff)\
**Approved:** YES — Owner decision, 2026-08-22\
**Document State:** FROZEN — future changes to module numbering, sequencing, or the dependency graph require an Architecture Change Request per `ARCHITECTURE_CHANGE_REQUEST_PROCESS_V1.0.md`; routine status updates (marking a module's progress) do not — see §10.

---

# 1. Purpose

This document is the authoritative mapping between product specifications and engineering development module numbering. It exists because no other document in the frozen Phase-0 set ever defined what "Module 2," "Module 3," etc. mean — a gap discovered and reconciled during the Module 1F freeze review (2026-08-22).

---

# 2. Authority Boundary

This document does **not** replace, override, or duplicate any existing authority:

- **FRD (`AI_CONTENT_OPERATING_SYSTEM_FUNCTIONAL_REQUIREMENT_DOCUMENT_V1.0.md`)** remains the sole authority for *functional requirements* — what each capability must do.
- **Product Backlog (`AI_CONTENT_OPERATING_SYSTEM_PRODUCT_BACKLOG_V1.0.md`)** remains the sole authority for *product capabilities and priorities* (P0–P3, Epics).
- **ADRs (`ARCHITECTURE_DECISION_RECORDS_V1.0.md`)** remain the sole authority for *architecture decisions*.
- **Individual engine specifications** (`KNOWLEDGE_PACK_ENGINE_V1.0.md`, `BLOG_AUTOMATION_ENGINE_V1.0.md`, etc.) remain the sole authority for *engine-specific contracts and design*.
- **This document (`MODULE_ROADMAP_V1.0.md`)** is authority for exactly one thing: **development module numbering, dependency order, and implementation sequencing** — the question "what is Module N, and in what order do we build it," which no other document answers.

Where this document assigns a module a name or scope, that name/scope is always sourced from one of the four authorities above — never invented independently. Every module entry in §5 cites its source.

---

# 3. Numbering-Conflict Background

During the Module 1F freeze review, four independent, non-isomorphic sequencing signals were found to coexist in the repository, none referencing the others:

1. **Git/tag delivery-phase convention** — `Module 1` → sub-phases `1A–1F`, with "Module 2" never defined anywhere.
2. **`AI_CONTENT_MODULE_DESIGN_V1.0.md`'s 22-item numbered feature map** — a different axis (Auth=1, Workspace=2, Project=3...), explicitly caveated elsewhere (`PRODUCT_REQUIREMENT_SPECIFICATION_V1.0.md`) as not 1:1 with real build/screen boundaries.
3. **FRD §4–§16** — the functional-requirement section order, cross-referenced by every other spec via `FR-XXX-NNN` IDs.
4. **Product Backlog Epics 1–9** — priority buckets, explicitly *not* a build sequence (proven: Epic 9's "Background Jobs" and "Audit Logs," both P0, were already delivered ahead of Epics 2–8, because they were cross-cutting infrastructure needed early).

This document reconciles all four into one sequence, using FRD section order and Backlog priority as the primary signals (since both are frozen, cross-referenced, and internally consistent), with the git delivery-phase convention adopted going forward as the vocabulary ("Module N") this document assigns meaning to.

---

# 4. Module 1 Historical Reconstruction

**Module 1 — Foundation & Infrastructure. Status: COMPLETE / FROZEN** (tag `v1.9.1-module-1f-frozen`, commit `f3417a26008b1e9a047cf9082d10a4341e74b957`).

| Sub-phase | Delivered | FRD § | Backlog item |
|---|---|---|---|
| 1A | Platform foundation, Docker Compose, CI | — | — |
| 1B1 | Auth & RBAC | §4 | Epic 1 (P0) |
| 1C | Workspace, membership, invitations, Projects | §5 | Epic 1 (P0) |
| 1D | Media assets schema | §23 | Epic 4 (storage only) |
| 1E | Generic content foundation (items/series/versioning) | — (infra) | — |
| 1F (Milestones 1–8.3) | Queue/Scheduler/Retry/Dead-letter/Event bus/Outbox/Event-consumer execution | — (cross-cutting infra) | Epic 9 "Background Jobs" (P0) |

Module 1 delivered **zero AI-generation, zero content-automation, and zero external-AI-integration capability.** It is pure platform substrate. This is a deliberate, correct scope boundary, not a gap.

---

# 5. Complete Future Module Map

| # | Official Name | Classification | Status | Architecture Checkpoint |
|---|---|---|---|---|
| 1 | Foundation & Infrastructure | Foundation | **COMPLETE / FROZEN** | N/A — already frozen |
| 2 | Knowledge Pack Engine | Foundation | **COMPLETE / FROZEN** | Completed — ACR-014 approved & closed 2026-08-22 |
| 3 | AI Provider Abstraction Layer + AI Agent Framework (core) | Platform | **COMPLETE / FROZEN** | Completed — Phases 3.1-3.5 shipped via PRs #31-38, all merged with green CI. No ACR required (§10). |
| 4 | Research Engine + Trend Discovery + Keyword Engine | Core Engine | **COMPLETE / FROZEN (P0)** | Completed — Phases 4.1-4.4 shipped via PRs #40-43, all merged with green CI. FR-RES-003 Competitor Analysis deferred (P1, not P0-blocking). Relational `keywords`/`keyword_clusters` persistence (DB Design §5.8) deferred pending a real downstream consumer. No Module 5 work included. No ACR required (§10). |
| 5 | Content Planner | Core Engine | **FUNCTIONALLY COMPLETE / FROZEN (P0)** | Completed — Phase 5.1 shipped via PR #45, merged with green CI. FR-PLAN-002 Topic Cluster Planning implemented (persisted `keywords`/`keyword_clusters`/`keyword_cluster_members`/`topic_clusters`, promoting Module 4 Research output into durable planning records). FR-PLAN-003 Content Series was already complete (Module 1E). FR-PLAN-001 Editorial Calendar deferred — `content_items` structurally requires a real, validated `body` at creation (DTO/schema/Ownership Matrix all assign real content_item creation to Module 6/7 Blog/Video Automation, not Content Planner); no scheduled-date field or PLANNED/IDEA status exists in frozen schema, and the DB Design's `schedules` entity (§5.7) is an undefined stub with no field list, unlike every other entity in that document. Same deferral pattern as Module 4's own Competitor Analysis/keyword-persistence deferrals (row above). No ACR required (§10, routine status edit). |
| 6 | Blog Automation + Content Scoring Engine (shared foundation) | Content Engine | **FUNCTIONALLY COMPLETE / FROZEN (P0)** | Completed — Phases 6.1–6.5 shipped via PRs #49–57, all merged with green CI. **6.1** shared content-type-agnostic Content Scoring foundation (universal categories SEO/Viral/Content Quality/Engagement/Business + separate Blog dimension not folded into the composite; `content_scores`/`seo_reports` persistence; generic scoring service + API). **6.2** Blog Brief/Outline/Draft/SEO-Metadata agents, `blog_articles` persistence, provider abstraction + durable AI-job integration. **6.3** full Blog orchestration — lifecycle + quality gates, immutable draft versions, SEO persistence, Module 8 internal-linking seam (`engine_not_available`, zero suggestions, non-error), six-check QA, scoring integration, review-gate seal (generic content-item lifecycle route cannot bypass Blog gates), idempotency/read-side (`GET`) correctness. **6.4** Blog navigation/list/create/detail, 8-stage pipeline UI, QA panel, score panel, review controls, responsive UI (Blog-facing score read re-gated `BLOG_VIEW`; generation stays `SEO_SCORE`). **6.5** security request-header log redaction, CI test-isolation hardening, staging preflight, real Postgres backup, staging deployment + the two Module 6 migrations (`content_scoring`, `blog_agents`), plus two auth defects found and fixed en route — auth-recovery frontend (`/forgot-password`, `/reset-password`, `/activate`) and expired-reset-token status persistence — and the global password minimum confirmed at 12 characters (no composition rules). **§11 Content Scoring shared-engine gate: PASSED** — the engine is a content-type-agnostic registry/contract, not Blog-specific, verified by `content-scoring.e2e` + the Blog dimension being a separate registered dimension; Module 7 may now enter its own checkpoint. **Phase 6.5-D staging UAT: PASS WITH CONDITIONS** — infrastructure, authenticated UI, Blog list/create/detail structure, provider-unavailable safe handling (no fake success, polling stops, reload-stable), RBAC and review-gate protection all verified (live where reachable, regression-verified downstream); the successful live AI golden path (Brief→Outline→Draft→SEO) is **`BLOCKED_PROVIDER_CONFIGURATION`** — staging has no AI provider credentials by design, not a product defect. Deferred (genuine downstream dependencies, non-blocking): AI provider staging configuration + a later live golden-path verification once configured; the actual internal-linking engine (Module 8); actual publishing (Module 9, "publish-ready" is display/status only here); optional compact-stepper "Step N of 8" caption below 640px (future UI polish, not a defect). No ACR required (§10, routine status edit). Freeze tag: `v6.0.0-module-6-functionally-complete`. |
| 7 | Video Automation | Content Engine | **HARDENING COMPLETE — GO WITH CONDITIONS, NOT YET TAGGED** | Passed — checkpoint confirmed Module 7 extends Module 6's Content Scoring Engine (Video/Thumbnail dimensions registered alongside Blog, one shared composite, no fork — verified at freeze). Phases 7.1–7.8 delivered on `main` (`52fae7d`): full brief→script→scene→assets→voice→subtitles→render→QA→SEO→review pipeline, dedicated `apps/render-worker` + real Remotion engine, real staging Remotion render + six-check QA both naturally PASS, PG credential rotated, full regression green (578 E2E tests + Remotion smoke). Freeze tag `v7.0.0-module-7-functionally-complete` withheld pending the one remaining item: user-performed MANUAL_BROWSER_UAT acceptance (10-check list, desktop/tablet/390px) — see Phase 7.8 completion report. |
| 8 | SEO Engine + Internal Linking | Content Engine (cross-cutting) | NOT STARTED | Required before start |
| 9 | Publishing Engine | Distribution | NOT STARTED | Required before start |
| 10 | Social Media Automation | Distribution | NOT STARTED | Required before start — see §13 |
| 11 | Content Distribution (earned media) | Distribution | NOT STARTED | Required before start |
| 12 | Analytics & Growth Engine | Growth | NOT STARTED | Required before start |
| 13 | Content Memory Engine | Platform / cross-cutting | NOT STARTED — position flexible | Required before start — see §12 |
| — | Administration / remaining platform surface, Notifications | Platform (ongoing) | Partially covered by Module 1 (RBAC, audit); not a discrete numbered module | N/A |

### Per-module detail

**Module 2 — Knowledge Pack Engine**
- Sources: `KNOWLEDGE_PACK_ENGINE_V1.0.md`, FRD §6, Backlog Epic 1 (P0), ADR-004
- Dependencies: Module 1 (Workspace, RBAC, Audit) only
- Major capabilities: Industry Profile, Trusted Sources, Prompt Library, Brand Rules, SEO Rules, Competitor Library, Content Templates, Publishing Strategy; Draft/Active/Archived lifecycle
- Explicit exclusions: no AI provider calls, no content generation — pure workspace-scoped CRUD
- Reuses: Module 1's SessionGuard/WorkspaceContextGuard/PermissionGuard, audit logging, `KP_VIEW/KP_CREATE/KP_UPDATE/KP_DELETE` permissions (already named in `AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md`)

**Module 3 — AI Provider Abstraction Layer + AI Agent Framework (core)**
- Sources: `AI_PROVIDER_ABSTRACTION_LAYER_V1.0.md`, `AI_AGENT_FRAMEWORK_V1.0.md`, ADR-003
- Dependencies: Module 1 (Queue Engine) only — independent of Module 2 (see §11 of the prior reconciliation report for the independence analysis)
- Major capabilities: Provider adapters (OpenAI/Gemini/Claude), request/response normalization, cost/token tracking, retry/fallback, `ai_usage_logs`; minimal orchestrator + "AI Job" wrapper integrated with Module 1F's Queue Engine (Category A/B execution)
- Explicit exclusions: no concrete agent implementations (Research Agent, Blog Agent, etc.) — those belong to the modules that need them; building the full 15-agent framework here would be premature abstraction with nothing to prove it against
- Reuses: Module 1F's QueueRegistry/EventRegistry pattern, BackgroundJob lifecycle, retry/dead-letter

**Module 4 — Research Engine + Trend Discovery + Keyword Engine**
- Sources: FRD §7–§8, Backlog Epic 2 (P0/P1), `AI_AGENT_FRAMEWORK_V1.0.md` (Research/Trend/Keyword Agents)
- Dependencies: Modules 2, 3
- Major capabilities: trusted-source research collection, trend velocity/opportunity scoring, keyword clustering/intent/competition estimation
- Explicit exclusions: Competitor Analysis is P1, not P0 — may be deferred within this module if it threatens scope; no content drafting yet

**Module 5 — Content Planner**
- Sources: FRD §9, Backlog Epic 2 tail
- Dependencies: Module 4
- Major capabilities: editorial calendar, topic clusters, content series planning, publishing recommendations
- Explicit exclusions: no actual content generation

**Module 6 — Blog Automation + Content Scoring Engine (shared foundation)**
- Sources: `BLOG_AUTOMATION_ENGINE_V1.0.md`, `CONTENT_SCORING_ENGINE_V1.0.md`, FRD §10, Backlog Epic 3 (P0)
- Dependencies: Module 5, Module 1E (generic content foundation)
- Major capabilities: full Blog pipeline (brief→outline→draft→SEO→internal linking→QA→human review→publish-ready); **the shared, content-type-agnostic Content Scoring Engine is established here** — see §11
- Explicit exclusions: video/social-specific scoring dimensions (added by Module 7, not redesigned)

**Module 7 — Video Automation**
- Sources: `VIDEO_AUTOMATION_ENGINE_V1.0.md`, FRD §11, Backlog Epic 3/4 (P0/P1)
- Dependencies: Module 5, Module 6 (must reuse, not reimplement, its Content Scoring Engine — see §11)
- Major capabilities: full Video pipeline (brief→script→scene→assets→voice→subtitles→render→QA→SEO→publish-ready); adds Video Score and Thumbnail Score dimensions to the existing shared scoring engine
- Explicit exclusions: building any parallel/divergent scoring mechanism is out of scope — forbidden by §11

**Module 8 — SEO Engine + Internal Linking**
- Sources: FRD §12–§13, `AI_INTERNAL_LINKING_ENGINE_V1.0.md`, Backlog Epic 5 (P0/P1)
- Dependencies: Modules 6, 7 (needs real published-content-shaped data to link/optimize against)
- Major capabilities: metadata/schema optimization, ranking-probability recommendations, knowledge-graph-driven internal linking, orphan-content detection

**Module 9 — Publishing Engine**
- Sources: FRD §14, Backlog Epic 6 (P0/P1)
- Dependencies: Modules 6, 7, 8, Module 1F (Queue/Scheduler/Retry)
- Major capabilities: multi-account publishing, scheduling, publishing history, retry queue — the shared publishing core other channels build on
- Explicit exclusions: platform-specific social logic (captions, hashtags, engagement monitoring) — that is Module 10's distinct domain, not folded in here (owner decision, see §13)

**Module 10 — Social Media Automation**
- Sources: `SOCIAL_MEDIA_AUTOMATION_ENGINE_V1.0.md`, Backlog Epic 3 tail
- Dependencies: Module 9 (reuses its publishing/scheduling core) — may be implemented in a closely coordinated engineering phase with Module 9, but remains a separately contracted, separately owned domain (see §13)
- Major capabilities: platform optimization, caption/hashtag generation, multi-account management per platform, engagement monitoring, performance dashboard

**Module 11 — Content Distribution (earned media)**
- Sources: `CONTENT_DISTRIBUTION_ENGINE_V1.0.md`, FRD §15, Backlog Epic 7 (P1/P2)
- Dependencies: Module 9
- Major capabilities: guest-post/community/directory opportunity discovery, platform matching, submission tracking, performance tracking

**Module 12 — Analytics & Growth Engine**
- Sources: `ANALYTICS_ENGINE_V1.0.md`, `AI_GROWTH_ENGINE_V1.0.md`, FRD §16, Backlog Epic 8 (P0/P1)
- Dependencies: Modules 9, 10, 11 (needs real publishing/distribution history to analyze)
- Major capabilities: metrics collection/aggregation, dashboards, growth recommendations, ROI/viral scoring, closes the Content Scoring Engine's Learning Loop

**Module 13 — Content Memory Engine** *(position flexible — see §12)*
- Sources: `CONTENT_MEMORY_ENGINE_V1.0.md` — **not present in the P0 Backlog's Epics 1–9**; kept in scope per explicit owner decision, not the Backlog's own prioritization
- Dependencies: Modules 4, 6, 7, 12 (needs real research, content, and performance data to index/retrieve/learn from)
- Major capabilities: research/content/SEO/AI-decision/performance memory layers, knowledge graph, similarity/duplicate detection, retrieval-before-generation

---

# 6. Dependency Graph

```
Module 1 (frozen) ──┬──► Module 2 (Knowledge Pack)  ──┐
                     │                                  │
                     └──► Module 3 (Provider + Agent    │
                          Framework core)  ─────────────┤
                                                          ▼
                                          Module 4 (Research/Trend/Keyword)
                                                          │
                                                          ▼
                                          Module 5 (Content Planner)
                                                          │
                                                          ▼
                                    Module 6 (Blog + shared Content Scoring)
                                                          │
                                                          ▼
                                    Module 7 (Video — reuses Scoring Engine)
                                                          │
                                                          ▼
                                    Module 8 (SEO + Internal Linking)
                                                          │
                                                          ▼
                                    Module 9 (Publishing Engine)
                                                    │
                                          ┌─────────┴─────────┐
                                          ▼                   ▼
                              Module 10 (Social Media)   Module 11 (Distribution)
                                          │                   │
                                          └─────────┬─────────┘
                                                     ▼
                                       Module 12 (Analytics & Growth)
                                                     │
                                                     ▼
                              Module 13 (Content Memory — flexible timing,
                              earliest viable: once 4/6/7/12 have real data)
```

Modules 2 and 3 are independent of each other (parallelizable). Modules 10 and 11 both depend only on Module 9 (parallelizable after Module 9).

---

# 7. FRD ↔ Backlog ↔ Module Mapping

| FRD § | Backlog Epic | Module |
|---|---|---|
| §4 Auth | Epic 1 | 1 (done) |
| §5 Workspace | Epic 1 | 1 (done) |
| §6 Knowledge Pack | Epic 1 | 2 |
| — (ADR-003, Epic 9) | Epic 9 | 3 |
| §7 Research Engine | Epic 2 | 4 |
| §8 Keyword Engine | Epic 2 | 4 |
| §9 Content Planner | Epic 2 | 5 |
| §10 Blog Automation | Epic 3 | 6 |
| §11 Video Automation | Epic 3/4 | 7 |
| §12 SEO Engine | Epic 5 | 8 |
| §13 Internal Linking | Epic 5 | 8 |
| §14 Publishing Engine | Epic 6 | 9 |
| — (own spec, Epic 3 tail) | Epic 3 | 10 |
| §15 Distribution Engine | Epic 7 | 11 |
| §16 Analytics & Growth | Epic 8 | 12 |
| — (own spec, not in Backlog) | none | 13 |

---

# 8. Module Status Matrix

| Module | Status | Depends on status |
|---|---|---|
| 1 | COMPLETE / FROZEN | — |
| 2 | NOT STARTED | Module 1 ✓ |
| 3 | NOT STARTED | Module 1 ✓ |
| 4 | COMPLETE / FROZEN | Modules 2, 3 ✓ |
| 5 | FUNCTIONALLY COMPLETE / FROZEN | Module 4 ✓ |
| 6 | FUNCTIONALLY COMPLETE / FROZEN | Module 5 ✓ |
| 7 | HARDENING COMPLETE — GO WITH CONDITIONS, NOT YET TAGGED (pending manual browser UAT) | Modules 5, 6 ✓ |
| 8 | NOT STARTED | Modules 6 ✓, 7 |
| 9 | NOT STARTED | Module 8 |
| 10 | NOT STARTED | Module 9 |
| 11 | NOT STARTED | Module 9 |
| 12 | NOT STARTED | Modules 9, 10, 11 |
| 13 | NOT STARTED | Modules 4, 6, 7, 12 |

---

# 9. Architecture-Checkpoint Policy

Every module in §5 requires an architecture checkpoint before implementation begins, matching Owner Decision 3 ("subject to an architecture checkpoint before each module begins"). A checkpoint confirms: the module's scope against its cited source documents, its dependency modules are actually complete, no frozen contract from a completed module needs to change, and (for Modules 6/7 specifically) the Content Scoring Engine gate in §11. Checkpoints are lightweight reviews, not ACRs — they don't change any frozen document, they verify readiness to build against what's already frozen.

---

# 10. Module Completion/Freeze Policy

Reuses the precedent already established by Module 1F: each module ends with a real, CI-verified freeze record (an annotated git tag with a full narrative — the pattern used for `v1.6.0` through `v1.9.1`), not a new governance file per module. This document's own **Module Status Matrix (§8)** is updated at that point — a routine status edit, not a structural change, and does **not** require an ACR. A **structural** change to this document — reordering modules, adding/removing/splitting/merging a module, changing the dependency graph — **does** require an ACR, since it changes an architectural decision this document now has authority over (per §2's authority boundary and this document's own `FROZEN` state, consistent with `ARCHITECTURE_CHANGE_REQUEST_PROCESS_V1.0.md`'s scope: "Applies to every document marked `Document State: FROZEN`").

---

# 11. Content Scoring — Shared-Engine Decision

**Decision: Established as a shared foundation phase inside Module 6 (Blog Automation), not as its own standalone module, and not left to emerge independently inside each content engine.**

Reasoning:
- Content Scoring's own specification (`CONTENT_SCORING_ENGINE_V1.0.md`) already defines a single composite architecture (`SEO Score + Viral Score + Quality Score + Engagement Score + Business Score → Overall Content Score`) with content-type-specific *dimensions* (Blog Score, Video Score, Thumbnail Score) plugging into that one shared formula — it was never designed as N separate engines.
- Building it as a fully standalone module *before* any content engine exists would risk designing its Video/Thumbnail dimensions against guesswork, since no Video pipeline data shape would exist yet to validate against — the kind of premature abstraction this codebase's own engineering discipline avoids (Module 1F never built speculative scaffolding ahead of a real consumer).
- Module 6 (Blog, FRD §10) is the first content engine in dependency order, so it is where the shared engine gets its first real, end-to-end proof — matching the project's established pattern of building shared infrastructure (QueueRegistry, EventRegistry) once, generically, against its first real consumer, then reusing it unchanged.

**Enforcement mechanism (guarantees no incompatible reimplementation):** Module 6's architecture checkpoint (§9) includes an explicit internal gate — the Content Scoring Engine sub-phase must be reviewed and frozen as genuinely content-type-agnostic (a shared scoring registry/contract, not Blog-specific code) before Module 6 is considered complete. **Module 7 (Video) may not begin until that specific gate has passed**, and Module 7's own checkpoint requires it to extend the existing engine (adding Video/Thumbnail dimensions) rather than create a new one. This mirrors Module 1F's Category A/B event-consumer pattern: one shared executor, multiple registered manifests — never a forked copy per type.

---

# 12. Content Memory Placement Policy

Kept in scope as **Module 13**, per explicit owner decision — not silently deferred or dropped, despite its absence from the Backlog's own P0–P3 Epics 1–9. Its exact position in the timeline remains deliberately flexible: it depends on Modules 4 (Research), 6/7 (Content), and 12 (Analytics) having produced real research, content, and performance data, since its core function (retrieval-before-generation, duplicate detection, performance-informed recommendations) is meaningless without that data existing. It is not assigned a fixed calendar position beyond "after those four modules have real data flowing" — the architecture checkpoint at the time it's scheduled will confirm sufficient data exists.

---

# 13. Social Media — Architectural Boundary Decision

Kept as **Module 10**, a distinct module from Module 9 (Publishing Engine) — not collapsed into it, per explicit owner decision. Rationale for keeping them separately numbered while allowing coordinated delivery: they already have separate frozen specifications (no dedicated `PUBLISHING_ENGINE_V1.0.md` exists — Publishing's contract lives in FRD §14 only — while `SOCIAL_MEDIA_AUTOMATION_ENGINE_V1.0.md` is its own frozen document with platform-specific concerns Publishing's FRD section never addresses: caption/hashtag generation, per-platform multi-account management, engagement monitoring). Module 10 depends on and reuses Module 9's scheduling/publishing core rather than reimplementing it, and the two **may** be executed as one coordinated engineering phase/sprint if that proves efficient — but they remain separately contracted, separately tested, separately freezable modules, so Social Media's domain boundary is never permanently absorbed into Publishing's.

---

# 14. Change-Control Policy for Future Roadmap Changes

- **Status updates** (marking a module NOT STARTED → IN PROGRESS → COMPLETE, updating §8's matrix): routine, no ACR, recorded via the module's own freeze tag per §10.
- **Structural changes** (reordering, adding, removing, splitting, or merging a module; changing §6's dependency graph; changing the Content Scoring/Content Memory/Social Media boundary decisions in §11–13): require an Architecture Change Request per `ARCHITECTURE_CHANGE_REQUEST_PROCESS_V1.0.md`, exactly as any other `Document State: FROZEN` document. This document's own version increments (`v1.0 → v1.1`) follow that process's existing versioning rules — minor bump for non-breaking additions, major bump for breaking/architectural reordering.
- This policy itself prevents the exact ambiguity this document was created to resolve from recurring at Module 3, 4, and beyond: every future "what comes next" question has one authoritative place to look, and one governed process to change it.
