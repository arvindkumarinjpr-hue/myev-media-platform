# MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md

# MYEV Media / AI Content Operating System (AI-COS)

## Module 2 — Knowledge Pack Engine — Architecture Record

**Version:** 1.0
**Status:** FROZEN pending ACR-014 approval
**Phase:** Module 2 pre-implementation
**Approved:** Architecture decisions approved by Owner (Arvind), 2026-08-22 — subject to ACR-014's formal approval before the schema/permission portions may be implemented
**Document State:** This is a new, standalone record — not a Phase-0 frozen document, and does not itself require an ACR to create or edit. It consolidates already-approved decisions; it does not introduce new architecture.

---

## 1. Purpose / Scope

The durable architecture reference for Module 2 (Knowledge Pack Engine), consolidating the outcome of a multi-pass architecture checkpoint, adversarial review, and owner-decision correction sequence conducted 2026-08-22. In scope: Knowledge Pack CRUD, lifecycle, versioning, validation, RBAC, and the 6 child configuration areas. Out of scope: AI Provider Abstraction Layer (Module 3), source crawling/RAG, prompt execution, content generation.

## 2. Authoritative Source Hierarchy

`AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md` (entity/schema authority) > FRD §6/§24.3 (functional requirements/lifecycle authority) > `AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md` (permission authority) > `ARCHITECTURE_DECISION_RECORDS_V1.0.md` ADR-004/ADR-013/ADR-014 (architecture-decision authority) > `KNOWLEDGE_PACK_ENGINE_V1.0.md` (product-narrative authority) > this document (Module 2 implementation reference) > `MODULE_ROADMAP_V1.0.md` (sequencing authority only).

## 3. Aggregate Model

`knowledge_packs` is the aggregate root (one version row per version). Six true child entities live inside the aggregate boundary, never shared across versions: `knowledge_sources`, `prompt_templates`, `seo_rules`, `brand_guidelines`, `keyword_sets`, `competitors`. Two root-level JSONB columns (`industry_profile`, `publishing_strategy`) hold genuinely unstructured configuration. Not a single JSON blob — six normalized tables plus two scoped JSONB columns, per Database Design §5.3.

## 4. Entity/Table Model

Per Database Design §5.3 (as amended by ACR-014):

**`knowledge_packs`** — `workspace_id`, `project_id` (nullable, workspace-wide if null), `industry_profile` (JSONB), `publishing_strategy` (JSONB), `version_number`, `current_version_of` (self-FK, immediate predecessor), **`lineage_root_id`** (UUID, NOT NULL, indexed — permanent lineage identity), **`lock_version`** (INTEGER, NOT NULL, default 1 — aggregate-root optimistic-concurrency token), `status` (`DRAFT`/`VALIDATING`/`ACTIVE`/`ARCHIVED`), plus Database Design §2's standard fields.

**`knowledge_sources`** — `knowledge_pack_id`, `source_type` (government/association/company/publication/rss), `url`.
**`prompt_templates`** — `knowledge_pack_id`, `content_type` (FRD Appendix A enum), `prompt_body`, `version_number` (own independent revision counter — see §6).
**`seo_rules`** — `knowledge_pack_id`, `primary_keywords`/`secondary_keywords` (JSONB arrays), `internal_linking_policy`/`schema_preferences` (JSONB).
**`brand_guidelines`** — `knowledge_pack_id`, `tone_of_voice`, `terminology` (JSONB), `cta_rules`, `logo_asset_id` (FK → `media_assets`).
**`keyword_sets`** — `knowledge_pack_id`, `name`, `keywords` (JSONB array).
**`competitors`** — `knowledge_pack_id`, `domain`, `notes`.

No child table carries `lock_version` in V1 (§9).

## 5. Version Lineage

`current_version_of` = immediate-predecessor pointer (linked-list). `lineage_root_id` = permanent lineage identity, equal to the root version's own `id`, copied forward unchanged on every successor, never recomputed. These are never conflated (ADR-014).

**Invariant:** at most one non-deleted `ACTIVE` row per `lineage_root_id`.

**Enforcement:**
```sql
CREATE UNIQUE INDEX knowledge_packs_one_active_per_lineage
  ON knowledge_packs (lineage_root_id)
  WHERE status = 'ACTIVE' AND deleted_at IS NULL;
```
A real PostgreSQL partial unique index — the database rejects a second concurrent `ACTIVE` row in the same lineage. Application-level pre-checks may supplement this for a cleaner error message but never substitute for it.

**Scope of the invariant:** per-lineage only. A workspace may hold multiple independent lineages (FR-KP-001: "a workspace may hold multiple packs"), each with its own simultaneously-Active version — there is no "one Active pack per workspace" rule anywhere in the authoritative sources.

## 6. Lifecycle/State Machine

Exactly FRD §24.3:
```
(new) ──create──► DRAFT
DRAFT ──[Content Manager: trigger validate]──► VALIDATING
VALIDATING ──[System: all 5 checks pass, §7]──► ACTIVE
VALIDATING ──[System: any check fails]──► DRAFT (itemized, same transaction)
ACTIVE ──[Content Manager: edit]──► new DRAFT row created (current_version_of → this row,
           lineage_root_id copied forward), full child-content cloned (§8)
ACTIVE ──[Content Manager: explicit archive]──► ARCHIVED (terminal, queryable)
ARCHIVED ──► (terminal — no legal outbound transition)
```
`VALIDATING` is never durably observable outside the single transaction that resolves it (§7) — this is a corrected finding from the architecture review, not the original design.

**Prompt Template versioning (two independent layers, coexisting — Owner Decision 6):** `knowledge_packs.version_number` is the pack-level snapshot version; `prompt_templates.version_number` is template-level revision history, free to advance while the parent pack is still Draft. The instant the parent pack becomes Active, the entire snapshot — including whichever template revisions were current — becomes immutable as a unit; further template edits require a new Knowledge Pack Draft version (§8).

## 7. Validation Rules and Transaction

All validation is **synchronous** — no queue, no background job (§13). Five checks, evaluated together as one atomic gate, not staged:

```
BEGIN
  SELECT V2 FOR UPDATE                    -- status must be DRAFT
  SELECT V1 FOR UPDATE                    -- V2.current_version_of, status must be ACTIVE
  UPDATE knowledge_packs SET status='VALIDATING' WHERE id=V2.id AND status='DRAFT'

  evaluate (same transaction's read view):
    1. >=1 trusted source                          -- FR-KP-002
    2. >=1 prompt template per content type          -- FR-KP-003
    3. brand name present                            -- FR-KP-001/004
    4. industry profile + publishing strategy present -- FR-KP-004
    5. no Project has knowledge_pack_id = V1.id       -- Owner Decision 7, RESTRICT,
                                                          equal-weight precondition,
                                                          never a separate later step

  IF any of the 5 fail:
    UPDATE knowledge_packs SET status='DRAFT' WHERE id=V2.id AND status='VALIDATING'
    write itemized rejected-validation audit record (which of the 5 failed)
    COMMIT
    return 422 KNOWLEDGE_VALIDATION_FAILED (itemized)

  ELSE (all 5 pass):
    UPDATE knowledge_packs SET status='ARCHIVED' WHERE id=V1.id AND status='ACTIVE'
      -- guarded; 0 rows affected -> ROLLBACK, V1 changed underneath us, retry
    UPDATE knowledge_packs SET status='ACTIVE'   WHERE id=V2.id AND status='VALIDATING'
      -- guarded; 0 rows affected -> ROLLBACK
    write transition audit records (both)
    COMMIT
COMMIT
```

Archive-before-activate ordering is mandatory — the partial unique index (§5) rejects the reverse order at the statement level, since both rows would momentarily satisfy `(lineage_root_id, status='ACTIVE')` simultaneously.

**Rollback behavior:** any guarded `UPDATE` affecting 0 rows rolls back the entire transaction; V1 remains exactly as it was pre-transaction; V2's only reachable durable post-transaction state is `DRAFT` (on any failure) or `ACTIVE` (on full success) — never a lingering `VALIDATING`.

## 8. Project-Reference RESTRICT Semantics

**No automatic Project reassignment, ever (Owner Decision 7).** A version may not be archived — whether via direct `KP_ARCHIVE` or via supersession — while any Project's `knowledge_pack_id` still references it, matching Database Design's Cascade Strategy literally ("Blocked until projects are reassigned... RESTRICT"). Reassignment is a separate, explicitly authorized operation, never a side effect of Knowledge Pack activation. **Dependency, not yet designed:** the current `Project` Prisma model has no `knowledge_pack_id` column and no mutation path for it — Database Design §5.2 already licenses this column (frozen, pre-existing design, not a new decision), but it was never implementable until `knowledge_packs` exists. Implementing this column is legitimate Module 2 integration work (not a Module 1 reopening), belongs in Phase 2.1 alongside the new `knowledge_packs` table, and should get its own clearly-labeled migration step citing Database Design §5.2 directly (distinguishing it from the ACR-014-gated additions). The reassignment capability's own permission/endpoint design remains undesigned and out of this record's scope.

## 9. Version Cloning

Editing an Active pack creates a new Draft row (mandatory — Active cannot be edited in place). The new Draft clones the *complete* current configuration: both root JSONB columns and all 6 child tables in full, each child receiving its own new row identity, exclusively owned by the new version. No child row is ever shared between versions. The predecessor and all its child rows remain fully immutable throughout (Owner Decision 5).

## 10. Optimistic Concurrency

`lock_version` (INTEGER) on `knowledge_packs` **only**. Every aggregate-level mutation — including edits to child rows performed through aggregate-level operations — checks and increments the root's `lock_version`. A stale expected value returns `409 KNOWLEDGE_CONFLICT`. No child table carries an independent `lock_version` in V1; recorded as a possible future extension only if a real requirement for independent child-level concurrent mutation ever emerges (Owner Decision 4, corrected scope).

## 11. RBAC

| Permission | Scope | Status |
|---|---|---|
| `KP_VIEW` | Read | Existing |
| `KP_CREATE` | Create Draft | Existing |
| `KP_UPDATE` | Draft configuration mutation only | Existing |
| `KP_DELETE` | Soft-delete a Draft (never a non-Draft — see §12) | Existing |
| `KP_VALIDATE` | Trigger Draft→Validating→Active/Draft (§7) | New, ACR-014 |
| `KP_ARCHIVE` | Explicit Active→Archived | New, ACR-014 |

No `KP_ACTIVATE` — validation and successful activation remain one Content-Manager-triggered operation. All six assigned to Owner, Administrator, Content Manager, consistent with the existing four's assignment.

## 12. Delete/Archive Semantics

`KP_DELETE` = soft delete only (`deleted_at`), Draft-only — per Database Design §4's absolute soft-delete rule (no stated Knowledge Pack exception) and justified by the Cascade Strategy's immutable-historical-reference requirement for any version that has ever been Active (a Draft carries no external reference yet, so it's the only state where deletion is unambiguously safe — this restriction is a documented implementation rule grounded in an adjacent frozen requirement, not itself a directly-stated source rule). `ARCHIVED` = a `status` transition, remains fully queryable per FRD's "terminal, queryable" language — never a deletion.

## 13. Domain Event Decision

**No Knowledge Pack domain event in Module 2 V1.** No current module consumes any candidate event, no frozen requirement requires one, Module 2's own correctness needs none (all consistency happens within its own transactions). Deferred in full to whichever future module first has a genuine consumption requirement, defined at that module's own checkpoint — not built speculatively here.

## 14. Background-Job Decision

**None required.** Every Module 2 operation is synchronous CRUD/validation against already-persisted Postgres data — no external I/O, no AI call, nothing warranting Module 1F's Queue Engine.

## 15. API Capability Boundaries

Create/list/get/update-draft/validate/archive/delete/list-versions, all synchronous, all requiring the appropriate permission (§11) and `lock_version` where mutating. **No** `GET /knowledge-packs/active?project_id=` with inferred fallback semantics — a Project's active pack is read via the Project resource's own `knowledge_pack_id` field directly, once §8's dependency is built; no resolution/fallback algorithm exists or is needed.

## 16. Audit Requirements

Every state-changing action — create, edit, validate (both outcomes, including the RESTRICT-blocked outcome), activate, archive, delete — audited within the same transaction as the change, via the existing `AuditService.recordWithinTransaction` pattern the Projects module already establishes. New `AuditAction` values follow the existing `WORKSPACE_*`/`JOB_*` naming convention.

## 17. Phase Plan

| Phase | Objective | Depends on |
|---|---|---|
| 2.1 | Schema — `knowledge_packs` (with `lineage_root_id`/`lock_version`/index), 6 child tables, `projects.knowledge_pack_id` (§8), new permission constants | ACR-014 approved and closed |
| 2.2 | Core CRUD (Draft only) | 2.1 |
| 2.3 | Validation + Activation (§7's 5-check transaction) | 2.2 |
| 2.4 | Versioning (cloning, §9) | 2.3 |
| 2.5 | Archive + RESTRICT enforcement (§8) | 2.4 |
| 2.6 | RBAC + audit closeout | 2.5 |
| 2.7 | Module closeout (freeze tag, roadmap status update) | 2.6 |

## 18. Testing Requirements

Real Postgres, no mocking, matching Module 1F's established evidence standard: full lifecycle happy path; each of the 5 gate-rule failure paths individually (itemized); simultaneous-activation race proven against the real partial unique index, not application logic alone; simultaneous Draft edits proven against `lock_version`; RESTRICT path (activation attempted while a Project references the predecessor) proven to leave both rows untouched and return the itemized conflict; full cloning-correctness across all 9 cloned areas; tenancy isolation (cross-workspace access → 404); RBAC coverage across every role.

## 19. Dependencies

Module 1 (frozen) — Workspace/RBAC/Audit infrastructure only. No dependency on Module 3 (AI Provider Layer) — confirmed zero coupling either direction.

## 20. Deferred Items

Domain events (§13), the Project-reassignment capability's own design (§8), retention window for Knowledge Pack versions (undefined in any source, non-blocking), duplicate-source handling (non-blocking), field/payload size caps (non-blocking, reuse platform defaults).

## 21. Architecture Freeze Matrix

| Decision | Status |
|---|---|
| Aggregate boundary, 6 child tables | FROZEN |
| Lineage model (`lineage_root_id` vs `current_version_of`) | FROZEN, pending ACR-014 |
| One-Active-per-lineage enforcement (partial unique index) | FROZEN, pending ACR-014 |
| Archive-before-activate transaction ordering | FROZEN |
| Project-reference RESTRICT, no auto-reassignment | FROZEN (Owner Decision 7) |
| `lock_version` on aggregate root only | FROZEN, pending ACR-014 |
| `KP_VALIDATE`/`KP_ARCHIVE`, no `KP_ACTIVATE` | FROZEN, pending ACR-014 |
| VALIDATING synchronous, never durable | FROZEN |
| No domain events in V1 | FROZEN |
| No background jobs | FROZEN |
| Version cloning (full, all 9 areas) | FROZEN |
| Two independent template-versioning layers | FROZEN |
| `KP_DELETE` = soft delete, Draft-only | FROZEN |
| Project-reassignment capability's own design | NOT YET DESIGNED — dependency only |
| Retention window, duplicate-source handling, size caps | OPEN, non-blocking |

## 22. Phase 2.1 Entry Gate

ACR-014 approved and closed (Technical Reviewer + Architecture Owner sign-off), ADR-014 written and committed, all three affected frozen documents version-bumped and committed referencing ACR-014. Not gated on the Project-reassignment capability's own design (§8/§20) — that affects Phase 2.3's application logic, not Phase 2.1's schema.
