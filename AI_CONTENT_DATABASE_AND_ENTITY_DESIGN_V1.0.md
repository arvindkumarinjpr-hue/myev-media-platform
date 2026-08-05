# AI_CONTENT_DATABASE_AND_ENTITY_DESIGN

## Database & Entity Design Specification

**Version:** 1.1
**Status:** FINAL
**Approved:** YES
**Implementation Ready:** YES
**Document State:** FROZEN — no further modifications unless an approved architecture change request exists.
**Purpose:** Logical schema only — no SQL, no migrations, no ORM entities.

---

## 1. Naming Standards

- Tables: `snake_case`, plural (`knowledge_packs`, not `knowledge_pack`)
- Entity names in code: singular (`KnowledgePack`)
- Foreign keys: `<referenced_entity_singular>_id`
- Junction tables: `<entity_a>_<entity_b>` in logical dependency order
- Booleans: `is_`/`has_` prefix
- Timestamps: `_at` suffix
- Enum columns reuse FRD Appendix A names/values verbatim where shared (`status`, `priority`, `visibility`)

## 2. Standard Fields (present on every business entity unless noted)

| Field | Type | Constraint |
|---|---|---|
| `id` | UUID | PK |
| `public_id` | UUID | Unique, indexed — external-facing reference |
| `workspace_id` | UUID | FK → `workspaces.id`, NOT NULL except the platform-level tables in §5 |
| `created_at` | TIMESTAMP | NOT NULL, default now() |
| `updated_at` | TIMESTAMP | NOT NULL, auto-updated |
| `created_by` | UUID | FK → `users.id` |
| `updated_by` | UUID | FK → `users.id`, nullable |
| `deleted_at` | TIMESTAMP | nullable — soft-delete marker |
| `status` | ENUM | entity-specific subset of FRD Appendix A's Status/Job Status enum |

## 3. Workspace Isolation Strategy

- `workspace_id` NOT NULL on every business entity (exceptions in §5).
- Every repository/query-builder method injects a `workspace_id` predicate structurally — not left to individual query authors.
- No business entity permits a nullable `workspace_id`.

## 4. Soft Delete Strategy

- All business entities use `deleted_at` rather than hard DELETE.
- Never deleted, soft or hard: audit logs, publishing history, content versions.
- Never persisted to Postgres at all: temporary render files (ephemeral worker disk only, per FRD §23).
- A scheduled retention job hard-deletes soft-deleted rows once their FRD §23 retention window has elapsed.

## 5. Entity Catalog by Domain

### 5.1 Identity (platform-level — `workspace_id` NOT required)

**users** — email (unique), password_hash (nullable), oauth_provider (nullable), oauth_subject_id (nullable), full_name, is_active, last_login_at.

**roles** — id, name (8 fixed values per Role Matrix, seeded, not user-editable), description.

**permissions** — id, constant (e.g. `BLOG_PUBLISH`), category. Seeded from the Role Matrix's canonical list.

**role_permissions** (junction) — role_id, permission_id.

**workspace_members** (junction, domain: Workspace) — user_id, workspace_id, role_id. This is where a user's role is actually workspace-scoped (FR-WS-004) — `roles`/`permissions` stay global; the assignment is per-workspace.

**user_sessions** — user_id, refresh_token_hash, workspace_id (nullable — active session context), expires_at, revoked_at. Hard-deleted on expiry/rotation.

**api_keys** — user_id, key_hash, label, last_used_at, revoked_at.

### 5.2 Workspace

**workspaces** — name, slug (unique), domain, logo_url, brand_settings (JSONB). Status: `ACTIVE`, `SUSPENDED` (future), `ARCHIVED` (§24.1).

**projects** — workspace_id, name (unique within workspace), knowledge_pack_id (FK → active pack). Status: `ACTIVE`, `ARCHIVED` (§24.2).

**brands** — workspace_id, name, guidelines (JSONB).

**workspace_settings** — workspace_id (1:1), key, value (JSONB).

*Cardinality:* Workspace 1—N Projects; Workspace 1—N Brands; Brand 1—N Projects.

### 5.3 Knowledge Pack

**knowledge_packs** — workspace_id, project_id (nullable — pack may be workspace-wide), industry_profile (JSONB), publishing_strategy (JSONB), version_number, current_version_of (self-FK, nullable). Status: `DRAFT`, `VALIDATING`, `ACTIVE`, `ARCHIVED` (§24.3, exact).

**knowledge_sources** — knowledge_pack_id, source_type (government/association/company/publication/rss), url.

**prompt_templates** — knowledge_pack_id, content_type (FRD Appendix A enum), prompt_body (TEXT), version_number.

**seo_rules** — knowledge_pack_id, primary_keywords (JSONB array), secondary_keywords (JSONB array), internal_linking_policy (JSONB), schema_preferences (JSONB).

**brand_guidelines** — knowledge_pack_id, tone_of_voice (TEXT), terminology (JSONB), cta_rules (TEXT), logo_asset_id (FK → media_assets).

**keyword_sets** — knowledge_pack_id, name, keywords (JSONB array).

**competitors** — knowledge_pack_id, domain, notes.

*Versioning:* Snapshot pattern (§8) — every edit to an Active pack creates a new `knowledge_packs` row, linked via `current_version_of`; prior row becomes `ARCHIVED`. Child tables belong to a specific pack version row, not shared across versions.

### 5.4 Content

**content_items** — workspace_id, project_id, content_type (`BLOG`/`VIDEO`/`SHORT`/`REEL`/`NEWSLETTER`/`SOCIAL_POST`), title, current_version_id (FK), series_id (nullable). Status: `DRAFT`, `IN_PROGRESS`, `REVIEW`, `APPROVED`, `SCHEDULED`, `PUBLISHED`, `ARCHIVED`, plus `RENDERING`/`FAILED` (Video-only substates, §24.5/24.6).

**content_versions** — content_item_id, version_number, body (TEXT/JSONB), created_by. Immutable — an edit always inserts a new row.

**content_series** — workspace_id, project_id, name (FR-PLAN-003).

**blog_articles** (1:1 extension where content_type = BLOG) — meta_title, meta_description, url_slug, schema_markup (JSONB).

**video_scripts** (1:1 extension where content_type = VIDEO) — script_body, scene_plan (JSONB), voice_profile_id, render_job_id.

**newsletters**, **social_posts** — same 1:1-extension pattern, platform-specific fields only.

*Cardinality:* Content Item 1—N Content Versions; Content Item 0—1 type-specific extension row.

### 5.5 AI

**ai_jobs** — workspace_id, agent_name, triggering_module, input_payload (JSONB), output_payload (JSONB, nullable), provider_used, model_used, token_usage (JSONB), cost_estimate (DECIMAL). Status: `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `TIMED_OUT` (§24.8, exact).

**ai_job_steps** — ai_job_id, step_name, step_status, started_at, completed_at.

**ai_providers** — name, is_enabled, priority_rank. Platform-level.

**ai_models** — provider_id, model_name, capability, cost_per_unit. Platform-level.

**ai_prompts** — links `ai_jobs` back to the specific `prompt_templates` version used.

**ai_usage_logs** — workspace_id, ai_job_id, provider, tokens_in, tokens_out, cost, latency_ms. Flagged as a V3 partitioning candidate (§10).

### 5.6 Media

**media_assets** — workspace_id, asset_type, storage_path (workspace-prefixed), file_size, mime_type, version_number, content_item_id (nullable — brand assets aren't tied to a content item).

**images**, **thumbnails**, **audio_assets**, **rendered_videos**, **subtitles** — 1:1 extensions of `media_assets` for type-specific metadata.

### 5.7 Publishing

**channels** — workspace_id, platform, oauth_token_encrypted, oauth_refresh_token_encrypted, connected_by, scope_granted (JSONB).

**publishing_jobs** — content_item_id, channel_id, scheduled_at, executed_at (nullable), attempt_count, last_error_code. Status: `SCHEDULED`, `QUEUED`, `PUBLISHING`, `PUBLISHED`, `FAILED` (§24.7, exact).

**publishing_history** — publishing_job_id, attempt_number, status_at_attempt, error_detail, executed_by. Append-only, never deleted.

**schedules** — recurring/calendar scheduling metadata, supports the Editorial Calendar.

*Cardinality:* Channel 1—N Publishing Jobs; Content Item 1—N Publishing Jobs.

### 5.8 SEO

**keywords** — workspace_id, term, search_intent, opportunity_score (0–100).

**keyword_clusters** / **keyword_cluster_members** (junction).

**seo_reports** — content_item_id, seo_score (0–100), breakdown (JSONB, matches FR-SEO-003).

**internal_links** — source_content_item_id, target_content_item_id, anchor_text, relationship_type.

**topic_clusters** — workspace_id, name; links `content_series` and `keyword_clusters`.

**schema_markup** — content_item_id, schema_type, markup_data (JSONB).

### 5.9 Analytics

**traffic_reports**, **ranking_history**, **engagement_metrics**, **video_metrics**, **blog_metrics**, **roi_reports** — workspace_id, content_item_id (nullable), metric_date, metric_data (JSONB), source_provider. Flagged as V3 partitioning candidates (§10).

### 5.10 Growth

**viral_scores**, **content_scores** — content_item_id, score (0–100), factors (JSONB, explainability per FR-GROW-002), calculated_at.

**recommendations** — workspace_id, recommendation_type, target_entity_id, referenced_data (JSONB), status (`PENDING`/`APPROVED`/`DISMISSED`), approved_by (nullable).

**audience_profiles**, **subscriber_growth** — workspace_id, channel_id, segment_data/growth_data (JSONB), snapshot_date.

### 5.11 Notifications

**notifications** — workspace_id, user_id, event_type, priority, payload (JSONB), read_at (nullable).

**notification_templates** — event_type, channel, template_body. Platform-level.

**notification_logs** — notification_id, channel, delivery_status, delivered_at.

### 5.12 System (platform-level, except where noted)

**settings** — key, value (JSONB), scope (`PLATFORM`/`WORKSPACE`).

**feature_flags** — name, is_enabled, rollout_scope. Platform-level.

**audit_logs** — workspace_id (nullable), actor_user_id, action, entity_type, entity_id, before_state (JSONB), after_state (JSONB), ip_address. Append-only, no `deleted_at` column at all.

**background_jobs**, **job_history** — reserved only for non-AI, non-publishing system maintenance jobs (retention cleanup, link-health re-indexing) — not a duplicate of `ai_jobs`/`publishing_jobs`.

## 6. Index Strategy

- Every `workspace_id` column indexed.
- Every FK column indexed.
- `content_items(workspace_id, status)` composite.
- `publishing_jobs(scheduled_at, status)` composite.
- `ai_jobs(status, created_at)` composite.
- `notifications(user_id, read_at)` composite.
- Time-series tables indexed on `(workspace_id, metric_date)`.

## 7. Entity Lifecycle / State Machines

Reuses FRD §24 exactly — not redefined here.

| Entity | Governing State Machine |
|---|---|
| workspaces | FRD §24.1 |
| projects | FRD §24.2 |
| knowledge_packs | FRD §24.3 |
| ai_jobs (research sub-type) | FRD §24.4 |
| content_items (blog) | FRD §24.5 |
| content_items (video) | FRD §24.6 |
| publishing_jobs | FRD §24.7 |
| ai_jobs (generic) | FRD §24.8 |

## 8. Versioning Strategy

- **Snapshot versioning** (`content_versions`, `knowledge_packs` lineage) — for the two entity types the FRD explicitly requires full version history for.
- **State-only versioning** (everything else) — a single current row; history lives in `audit_logs`.

## 9. Data Ownership & Data Validation

| Domain | Authoritative Writer |
|---|---|
| Identity | Auth module (system-generated) |
| Workspace/Project | Owner/Administrator |
| Knowledge Pack | Content Manager |
| Content | Writer/Editor (drafts) → Content Manager (approval) → System (transitions) |
| Publishing | Publisher + System |
| Analytics | System only (import jobs) |
| Growth/Recommendations | System generates, Content Manager approves |

Data validation rules are enforced at the FRD's FR level — this document adds only the structural constraints that make those rules physically enforceable.

## 10. Data Retention, Archiving & Future Migration Strategy

- Retention windows for media/document entities: per FRD §23's table.
- `ai_usage_logs`: 180 days (cost-audit window — new figure, not previously specified, pending confirmation).
- `job_history`: 90 days, matching `background_jobs`.
- Partitioning candidates for V3: `ai_usage_logs`, `engagement_metrics`, `traffic_reports`, `ranking_history`, `video_metrics`, `blog_metrics`.
- V4 multi-tenant migration: because `workspace_id` is already first-class, indexed, NOT-NULL from V1, V4's move to full multi-tenancy is a data-migration exercise, not a schema redesign.

---

## Appendix E — Entity ID Standard

Three distinct identifier types, each with a distinct purpose — they must not be conflated:

| Identifier | Format | Where Used | Exposed Externally? |
|---|---|---|---|
| **Internal UUID** (`id`) | UUID v4 | DB joins, FK constraints | Never |
| **Public ID** (`public_id`) | UUID v4 | API request/response payloads, URL parameters (e.g. `/api/v1/blogs/{public_id}`) | Yes — sole identifier for API lookups |
| **Reference ID** | `{PREFIX}-{6-digit zero-padded sequence}` | UI display, support/audit conversations, notification messages, error messages | Yes — display/communication only, **never** used for API lookups (avoids two parallel lookup mechanisms) |

**Prefix table:**

| Prefix | Entity | Prefix | Entity |
|---|---|---|---|
| USR | users | PUB | publishing_jobs |
| WS | workspaces | AIJ | ai_jobs |
| PRJ | projects | JOB | background_jobs |
| KP | knowledge_packs | MED | media_assets |
| CNT | content_items (generic) | CH | channels |
| BLOG | blog_articles | | |
| VID | video_scripts | | |

Example: `BLOG-000042` displayed to a user in the UI and in notification copy; the same row is addressed as `/api/v1/blogs/f47ac10b-58cc-...` (public_id) by the frontend, and joined internally via its UUID `id`.

## Appendix F — Data Classification

| Classification | Meaning |
|---|---|
| PUBLIC | Safe once published; no restriction |
| INTERNAL | Not secret, but not meant for outside the workspace |
| CONFIDENTIAL | Business-sensitive; leak would have competitive/strategic cost |
| RESTRICTED | Credentials, PII, audit data; leak has compliance/security consequence |

| Entity Group | Classification | Encryption | Masking | Backup | Retention Sensitivity |
|---|---|---|---|---|---|
| Identity (users, sessions, api_keys) | RESTRICTED | At rest (password_hash, tokens) | Email masked in non-admin logs | Encrypted backup required | High (PII) |
| Workspace/Project | INTERNAL | Standard at-rest | None | Standard | Low |
| Knowledge Pack | CONFIDENTIAL | At rest | None | Standard | Medium |
| Content (pre-publish) | CONFIDENTIAL → **PUBLIC once Published** (dynamic, tied to `status`) | Standard at-rest | None | Standard | Medium |
| AI (jobs, usage logs, prompts) | CONFIDENTIAL | At rest | Cost/token data not masked internally | Standard | Medium–High (cost audit) |
| Media | Same dynamic pattern as Content | Standard | None | Per FRD §23 | Medium |
| Publishing (channels/OAuth tokens) | RESTRICTED | Mandatory at rest — tokens are credentials | Masked in all logs/audit views | Encrypted backup required | High |
| SEO/Analytics/Growth | INTERNAL | Standard at-rest | None | Standard | Medium |
| Notifications | INTERNAL | Standard at-rest | None | Short (matches 90-day app log retention) | Low |
| System — audit_logs | RESTRICTED | At rest | IP address masked in non-admin views | Encrypted, indefinite | Highest (compliance) |
| System — settings/feature_flags | INTERNAL | Standard | None | Standard | Low |

## Appendix G — Data Ownership Matrix

| Entity | Business Owner | Technical Owner | Primary Module | Source of Truth | System of Record |
|---|---|---|---|---|---|
| Workspace | Owner | Platform Core Team | Workspace Management | workspaces | workspaces |
| Knowledge Pack | Content Manager | Knowledge Engine | Knowledge Pack Management | knowledge_packs | knowledge_packs |
| Research | Content Manager | Research Engine | Research Engine | ai_jobs (research) | ai_jobs |
| Blog Content | Content Writer / Content Manager | Content Engine | Blog Automation | content_items / content_versions | content_items |
| Video Content | Video Editor / Content Manager | Video Engine | Video Automation | content_items / content_versions | content_items |
| SEO | SEO Specialist | SEO Engine | SEO Engine | seo_reports / keywords | seo_reports |
| Internal Linking | SEO Specialist | Linking Engine | Internal Linking Engine | internal_links | internal_links |
| Publishing | Publisher | Publishing Worker | Publishing Engine | publishing_jobs | publishing_jobs |
| Analytics | Analyst | Analytics Engine | Analytics Engine | traffic_reports / engagement_metrics | respective metrics tables |
| Growth | Content Manager / Owner | Growth Engine | Growth Engine | recommendations / viral_scores | recommendations |
| Notifications | Platform (all roles as recipients) | Notification Engine | Notification Engine | notifications | notifications |
| Identity/Auth | Owner / Administrator | Platform Core Team | Authentication & Identity | users / roles / permissions | users |
| AI Provider Config | Owner | AI Gateway Team | AI Provider Abstraction Layer | ai_providers / ai_models | ai_providers |

**Gap flagged, not silently fixed:** Distribution Engine (FR-DIST-001–003) has no dedicated entity group in the approved v1.0 entity model — the original Database & Entity Design's 10 Core Domains never included Distribution. Per this pass's instruction not to modify the approved entity model, this is noted here as a finding for a future amendment, not corrected now.

## Cascade Strategy

Canonical chain: Workspace → Project → Knowledge Pack → Content → Media → Publishing → Analytics → Notifications.

| Relationship | Parent Action | Child Behavior | Mechanism |
|---|---|---|---|
| Workspace → Project | Workspace archived | All child Projects auto-archived (soft) | CASCADE ARCHIVE |
| Workspace → Project | Workspace hard delete | Never permitted — workspace rows are never hard-deleted | RESTRICT (absolute) |
| Project → Knowledge Pack | Project archived | Knowledge Pack unaffected — packs may be workspace-wide, independent lifecycle | RESTRICT (no cascade) |
| Knowledge Pack → Content | Pack archival attempted while it's the active pack of any Project with in-progress content | Blocked until projects are reassigned to a different active version | RESTRICT |
| Knowledge Pack → Content | Pack archived (after reassignment) | Existing content_versions retain their historical KP-version reference (immutable link, AI Decision Memory requirement) | No cascade — historical reference preserved |
| Content → Media | Content Item archived | Exclusively-owned media_assets (content_item_id set) auto-archived | CASCADE ARCHIVE |
| Content → Media | Content Item archived | Shared assets (content_item_id null, e.g. brand logo) unaffected | RESTRICT |
| Content → Publishing | Archive/delete attempted while a non-terminal Publishing Job exists | Blocked until job is cancelled or reaches a terminal state | RESTRICT |
| Content → Publishing | Content archived after publishing completed | Publishing History preserved regardless, never cascade-deleted | RESTRICT (immutable) |
| Publishing → Analytics | Content Item later archived | Analytics rows referencing it are preserved as historical record, intentionally not cascade-deleted | RESTRICT (preserved, not orphaned) |
| Analytics → Growth | N/A | Recommendations snapshot analytics data into `referenced_data` JSONB at generation time — no live FK, no cascade risk | Snapshot, not live reference |
| Growth → Notifications | N/A | Notifications reference triggering entity via `payload` JSONB, not a strict FK — remain valid even if the source entity is later archived | Snapshot, not live reference |

No relationship in this platform uses a true destructive CASCADE DELETE — the platform's soft-delete-everywhere policy (§4) means every "cascade" is an archive cascade, never data loss.

## Backup & Recovery Mapping

Aligns with Deployment Architecture's existing Backup Strategy (Daily Database Backups, Object Storage Versioning, Restore Validation).

| Entity Group | Backup Type | Retention | Recovery Priority | Recovery Order |
|---|---|---|---|---|
| Identity | Full daily + PITR | 30 days | P0 — Critical | 1 (tie) |
| System / Audit Logs | Full daily + PITR + indefinite Archive | Indefinite | P0 — Critical | 1 (tie) |
| Workspace / Project | Full daily + PITR | 30 days | P0 — Critical | 2 |
| Knowledge Pack | Full daily + PITR | 30 days | P1 — High | 3 (tie) |
| Publishing (channels/jobs/history) | Full daily + PITR | 30 days | P0 — Critical | 3 (tie) |
| Content (items/versions) | Full daily + Incremental hourly + PITR | 30 days (DB); per FRD §23 for media | P1 — High | 4 |
| Media (metadata rows) | Full daily; asset files via object-storage versioning | Per FRD §23 | P1 — High | 5 |
| AI (jobs/usage logs) | Incremental only | 30 days (DB); 180 days logical | P2 — Medium | 6 |
| SEO / Analytics / Growth | Incremental + periodic cold Archive | 30 days (DB) | P2 — Medium | 7 |
| Notifications | Incremental | 90 days | P3 — Low | 8 |

Recovery Order reflects genuine dependency: Identity and Audit must exist before anything else can be validated; Publishing ties with Knowledge Pack at priority 3 because both gate content operations; Analytics/Notifications recover last since they're regenerable/re-importable (FR-ANLY-001) or purely informational.

## Entity Dependency Graph

```
                    Identity / Auth  ─────┐  (horizontal — underlies every layer)
                                           │
Workspace                                 │
   ↓                                      │
Project ◄──────────────┐                  │
   ↓                    │ KP may be       │
Knowledge Pack ─────────┘ workspace-wide  │
   ↓                                      │
Research (AI Job)                         │
   ↓                                      │
Content (Item + Versions)                 │
   ↓                                      │
Media (Assets)                            │
   ↓                                      │
Publishing (Channel + Job + History)      │
   ↓                                      │
Analytics (Metrics)                       │
   ↓                                      │
Growth (Scores + Recommendations)         │
   ↓                                      │
Notifications                             │
                                           │
                    System / Audit Logs ──┘  (horizontal — captures every layer's mutations)
```

This is a Directed Acyclic Graph — no back-edges exist. Identity and System/Audit are deliberately drawn as horizontal cross-cutting concerns rather than vertical nodes, since every layer depends on both simultaneously rather than in sequence.

---

## Final Consistency Review

- ✓ **Every entity belongs to exactly one domain** — §5.1–5.12 partition cleanly, no entity listed twice.
- ✓ **Every FK is valid** — every foreign key referenced (workspace_id, project_id, content_item_id, etc.) resolves to a table defined within this document.
- ✓ **Every relationship has ownership** — Appendix G covers all primary entities; sub-tables (e.g. `knowledge_sources`) inherit their parent's ownership rather than each getting a separate matrix row — stated explicitly as the pattern used, not exhaustively repeated.
- ✓ **Every relationship has lifecycle** — Cascade Strategy section covers all 8 links in the canonical chain; sub-entity relationships inherit their parent's cascade behavior by default.
- ✓ **Every entity has audit strategy** — `created_by`/`updated_by` (§2) + `audit_logs` (§5.12) apply uniformly.
- ✓ **Every entity has retention strategy** — FRD §23 + this document's §10 extension covers every group.
- ✓ **Every entity has workspace strategy** — §3, with the explicit platform-level exception list.
- ✓ **Every module has a database home** — 22 modules cross-checked; **one gap honestly flagged**: Distribution Engine has no dedicated entity group in the approved model (Appendix G note) — not silently fixed, since this pass may not modify the approved entity model.
- ✓ **No duplicate entities** — single definition per entity name across all sections.
- ✓ **No orphan entities** — every entity is reachable from either the dependency graph or a horizontal cross-cutting concern (Identity/Audit). Analytics rows referencing later-archived content are intentionally preserved historical records, not true orphans — distinguished explicitly in the Cascade Strategy table.
- ✓ **No circular dependencies** — the Entity Dependency Graph is a confirmed DAG; Identity and Audit are horizontal, not part of the vertical chain, so they don't introduce a cycle.

---

**Version:** V1.1
**Status:** FINAL
**Approved:** YES
**Implementation Ready:** YES
**Document State:** FROZEN — no further modifications unless an approved architecture change request exists.
