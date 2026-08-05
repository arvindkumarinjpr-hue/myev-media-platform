# ARCHITECTURE_DECISION_RECORDS

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN — new ADRs may be appended via an approved Architecture Change Request; existing ADRs are never edited, only superseded by a new ADR.
**Purpose:** The permanent record of every major architectural decision taken during Phase-0. This is the "why" behind the frozen documentation set — future contributors read this before questioning an existing decision.

---

## ADR-001 — Workspace-First Architecture

- **Decision:** Workspace isolation (`workspace_id` scoping on every business entity) is mandatory from V1, not deferred to a later multi-tenancy phase.
- **Context:** The platform must support additional workspaces (EVision India, MySensex, future client projects) without major architectural change.
- **Alternatives Considered:** (a) Single-workspace V1 with isolation retrofitted later. (b) Full SaaS multi-tenancy (separate database per tenant) from V1.
- **Reason:** (a) rejected — retrofitting isolation into an existing schema after data exists is high-risk and expensive. (b) rejected — over-engineered for V1's actual need (a handful of known workspaces, not public SaaS tenants).
- **Consequences:** Every business entity carries `workspace_id`; every query structurally scoped at the repository layer; V4 multi-tenancy becomes a data-migration exercise, not a redesign.
- **Affected Documents:** FRD, PRS, Database Design, API Specification, Queue & Background Job Engine.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-002 — AI-COS as Core Platform, MYEV Media as First Product

- **Decision:** AI-COS is the internal engineering platform; MYEV Media is a product/workspace instance running on it, not a competing identity.
- **Context:** The original 25-document set contained a contradiction — the Project Identity document framed an EV-only product, while 24 other documents described a generic, multi-workspace "AI-COS."
- **Alternatives Considered:** (a) Treat MYEV Media as the only product, drop the AI-COS framing entirely. (b) Treat AI-COS and MYEV Media as two separate, unrelated projects.
- **Reason:** (a) rejected — would block future EVision India/MySensex onboarding without a rewrite. (b) rejected — the majority of existing documents already assumed a shared generic engine.
- **Consequences:** All engine specs (Blog, Video, SEO, etc.) are platform-level and reused across future workspaces; MYEV Media's specific identity lives only in its Knowledge Pack configuration.
- **Affected Documents:** Project Identity, Master Blueprint, all engine specifications, Phase-0 Readiness Report.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-003 — AI Provider Abstraction Layer

- **Decision:** All AI calls route through a common abstraction layer; no business module calls OpenAI/Gemini/Claude directly.
- **Context:** The Blueprint commits to three AI providers at launch for redundancy and cost optimization.
- **Alternatives Considered:** (a) Direct vendor SDK integration per module. (b) Single hardcoded provider for V1, abstraction deferred.
- **Reason:** (a) rejected — couples every content-generation module to vendor-specific SDKs. (b) rejected — the Blueprint already commits to 3 providers at launch.
- **Consequences:** Every agent's request/response passes through the Common Request/Response Model (API Specification §27); adding a new provider requires zero business-logic changes.
- **Affected Documents:** Enterprise Architecture, AI Agent Framework, AI Provider Abstraction Layer, API Specification, Queue & Background Job Engine.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-004 — Knowledge Pack as Mandatory Agent Dependency

- **Decision:** No AI agent may execute without an active, validated Knowledge Pack.
- **Context:** Ensures brand/niche consistency across all generated content in a multi-workspace platform.
- **Alternatives Considered:** (a) Optional Knowledge Pack with system defaults. (b) Required only for publish-facing content, not research.
- **Reason:** (a) rejected — defeats the premise of a platform serving different niches per workspace. (b) rejected — research quality also depends on the pack's trusted sources and terminology, not just final content.
- **Consequences:** Every AI Job gates on active-Knowledge-Pack existence at Queued-state entry; onboarding a new workspace requires Knowledge Pack setup before any content module is usable.
- **Affected Documents:** Knowledge Pack Engine, FRD, Queue & Background Job Engine.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-005 — Queue Engine as Universal Async Execution Layer

- **Decision:** All asynchronous work routes through one unified Queue Engine with categorized queues, not per-module ad hoc job handling.
- **Context:** An early risk assessment flagged three parallel job-tracking concepts (`ai_jobs`/`background_jobs`/BullMQ itself) with no stated relationship.
- **Alternatives Considered:** (a) Separate queue/worker infrastructure per module. (b) A single undifferentiated queue for all job types.
- **Reason:** (a) rejected — duplicates retry/monitoring/failover logic per module. (b) rejected — Video rendering's resource intensity would starve lighter AI/Publishing jobs without queue-category isolation.
- **Consequences:** `ai_jobs` is authoritative for AI work, `publishing_jobs` for publishing, `background_jobs` reserved only for non-AI/non-publishing maintenance — resolving the earlier ambiguity.
- **Affected Documents:** Queue & Background Job Engine, Database Design, Observability & Monitoring Specification.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-006 — PostgreSQL as Single Relational Store, JSONB for Flexible Config

- **Decision:** PostgreSQL is the sole system-of-record database; flexible/evolving config (Knowledge Pack rules, job payloads, metric data) is stored as JSONB rather than in separate rigid tables.
- **Context:** Database Design needed a strategy for genuinely variable-shaped data (SEO rules, brand guidelines, metric breakdowns) without constant migrations.
- **Alternatives Considered:** (a) A separate document store (MongoDB) alongside Postgres. (b) Fully normalized rigid schema for every config field.
- **Reason:** (a) rejected — introduces a second system-of-record and cross-database consistency risk for no proven scale need. (b) rejected — Knowledge Pack rules and job payloads are genuinely per-use-case variable.
- **Consequences:** JSONB used deliberately for genuinely variable fields; core relational structure (`workspace_id`, FKs, status enums) stays strictly typed.
- **Affected Documents:** Database Design, Enterprise Architecture.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-007 — Postgres as Source of Truth, Redis as Dispatch Layer Only

- **Decision:** A job's business status is always authoritative in Postgres; Redis holds only in-flight dispatch state and is rebuildable from Postgres if lost.
- **Context:** Queue Corruption recovery needed a clear, unambiguous reconciliation direction.
- **Alternatives Considered:** (a) Redis as source of truth with periodic Postgres sync. (b) No reconciliation strategy.
- **Reason:** (a) rejected — Redis persistence is less durable/queryable than Postgres for audit/history purposes. (b) rejected — unacceptable for a platform requiring reliable retry behavior and audit trails.
- **Consequences:** On any Redis/Postgres disagreement, Postgres wins and Redis state is rebuilt — never the reverse.
- **Affected Documents:** Queue & Background Job Engine, Database Design, Observability & Monitoring Specification.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-008 — Docker Compose as V1 Application Runtime

- **Decision:** API, Frontend, Worker, PostgreSQL, Redis, and MinIO all run as Docker Compose services in V1; CloudPanel does not manage the application processes directly.
- **Context:** Initial VPS deployment discovered CloudPanel running the frontend as a bare pm2 Node.js site, conflicting with the documented Docker Compose architecture.
- **Alternatives Considered:** (a) Abandon Docker Compose, run everything as CloudPanel-managed sites. (b) Full Kubernetes from V1.
- **Reason:** (a) rejected — loses the container-parity-between-dev-and-prod principle already established. (b) rejected — Kubernetes is an explicit V3+ concern, premature for a single-VPS V1.
- **Consequences:** `app.myevmedia.com`'s current CloudPanel Node-site setup is a placeholder to be migrated to a CloudPanel reverse-proxy site in front of Docker containers.
- **Affected Documents:** Deployment Architecture, Enterprise Architecture.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-009 — CloudPanel as Edge Layer Only

- **Decision:** CloudPanel's role is strictly nginx reverse proxy, SSL/Let's Encrypt, and domain/site management — never application process management.
- **Context:** The VPS was found to be shared with other live CloudPanel-managed sites (MySensex, EVision India) belonging to the same operator.
- **Alternatives Considered:** (a) CloudPanel manages the app directly (rejected per ADR-008). (b) Move to a dedicated VPS, abandon CloudPanel entirely.
- **Reason:** (b) rejected — no stated need to isolate infrastructure at this stage; `site:add:reverse-proxy` confirmed available on the existing installation.
- **Consequences:** `app.myevmedia.com` and `api.myevmedia.com` become CloudPanel reverse-proxy sites pointing at Docker container ports; shared-VPS resource contention becomes an explicitly tracked risk.
- **Affected Documents:** Deployment Architecture.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-010 — Repository Structure: Documentation-First, Single Repository, Flat Files

- **Decision:** All Phase-0 documentation lives at the repository root as flat markdown files, not nested under a `docs/` folder structure.
- **Context:** An earlier proposal recommended a nested `docs/00-project-identity/` through `docs/14-backlog/` structure; the actual documents were pushed flat instead.
- **Alternatives Considered:** (a) Enforce the originally proposed nested structure retroactively. (b) Split documentation into a separate repository from application code.
- **Reason:** (a) noted as a discrepancy but not corrected mid-Phase-0, to avoid reference churn across already-frozen documents. (b) rejected — single-repository simplicity outweighs the marginal benefit at this project's current scale.
- **Consequences:** A folder reorganization remains open and low-priority — must go through the Architecture Change Request process (its companion document) rather than being done silently.
- **Affected Documents:** All.
- **Approval Status:** Approved, with known deviation noted
- **Date:** 2026-08-05

## ADR-011 — REST API Contract, URI Versioning, Cursor Pagination

- **Decision:** `/api/v1/*` REST resources, cursor-based pagination, JWT Bearer auth with httpOnly-cookie refresh tokens.
- **Context:** The API specification needed to move from strategy-only to implementation-ready.
- **Alternatives Considered:** (a) GraphQL as the primary contract. (b) Offset-based pagination.
- **Reason:** (a) rejected — GraphQL remains a Future Enhancement, not a V1 commitment. (b) rejected — offset pagination degrades on large, frequently-mutated tables at the scale the roadmap anticipates.
- **Consequences:** Every consumer speaks the identical REST contract; breaking changes require a new version prefix, never in-place changes to v1.
- **Affected Documents:** API & Integration Specification.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-012 — Role-Based Access Control with Workspace-Scoped Role Assignment

- **Decision:** 8 fixed platform-level roles; a user's actual role is assigned per-workspace, not globally.
- **Context:** A user may need different permission levels across different workspaces (e.g. Owner of MYEV Media, Analyst-only on a client project).
- **Alternatives Considered:** (a) Global role per user, same across all workspaces. (b) Fully custom per-workspace permission sets (ABAC).
- **Reason:** (a) rejected — doesn't fit the multi-workspace reality confirmed by ADR-001/002. (b) rejected — ABAC's flexibility isn't needed yet; already listed as a Future Enhancement.
- **Consequences:** `roles`/`permissions` stay global/seeded; the workspace-scoped assignment lives in `workspace_members`.
- **Affected Documents:** Role & Permission Matrix, Database Design, API Specification, Security & Access Control.
- **Approval Status:** Approved
- **Date:** 2026-08-05

## ADR-013 — Three-Tier Identifier Model

- **Decision:** Every entity carries an internal UUID (never exposed), a Public ID (API/URL identifier), and a human-readable Reference ID (display/communication only).
- **Context:** ~55 entities needed a consistent identifier strategy before API contract work could proceed cleanly.
- **Alternatives Considered:** (a) Expose the internal UUID directly in APIs. (b) Use only sequential integer IDs.
- **Reason:** (a) rejected — couples the API surface to internal storage details. (b) rejected — sequential integers leak volume information and don't support a clean human-display/lookup separation.
- **Consequences:** API responses never include the internal `id`; Reference IDs are for humans only, never accepted as an API lookup key.
- **Affected Documents:** Database Design (Appendix E), API & Integration Specification.
- **Approval Status:** Approved
- **Date:** 2026-08-05

---

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN
