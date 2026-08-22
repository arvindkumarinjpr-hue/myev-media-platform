# ACR_014_KNOWLEDGE_PACK_LINEAGE_AND_CONCURRENCY_V1.0.md

# Architecture Change Request — ACR-014

## Knowledge Pack Version Lineage, Activation Atomicity, and Concurrency Control

**Version:** 1.1
**Status:** APPROVED / CLOSED
**Phase:** Post-Phase-0 (Module 2 pre-implementation)
**Requester:** Claude (session governance execution, per Owner-directed architecture checkpoint sequence, 2026-08-22)
**Technical Reviewer:** Arvind, fulfilling the "Knowledge Engine" Technical Owner role per `AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md` Appendix G's Data Ownership Matrix. No document in this repository names a distinct individual for "Knowledge Engine," and no separate staffed team exists — Arvind is the sole Owner role across every ADR and ACR in this repository's history. Recorded transparently: the same person fulfills both required approval roles in this solo-ownership project, which the Approval Matrix does not prohibit.
**Architecture Owner:** Owner role (Arvind), per `ARCHITECTURE_CHANGE_REQUEST_PROCESS_V1.0.md`'s own Roles table
**Document State:** APPROVED / CLOSED — this ACR record itself is not a frozen Phase-0 document; it does not require its own ACR to create or edit, per `ARCHITECTURE_CHANGE_REQUEST_PROCESS_V1.0.md`'s Scope ("Applies to every document marked `Document State: FROZEN`")

---

## 1. Summary

Module 2 (Knowledge Pack Engine) architecture design — conducted across a multi-pass checkpoint, adversarial review, and owner-decision correction sequence — surfaced that the frozen Database Design's `knowledge_packs` entity (§5.3) and the frozen Role & Permission Matrix's Knowledge Packs permission category are each missing elements a correct implementation genuinely requires. This ACR proposes the minimum additive extension to both, plus the corresponding ADR entry recording why.

## 2. Change Type (per Approval Matrix)

**New entity/field addition (non-breaking).** Both changes are purely additive: two new columns on an as-yet-unimplemented table (`knowledge_packs` does not exist in the shipped schema today — Module 2 has not started), and two new permission constants alongside four already-existing ones. Nothing existing is removed, redefined, or made incompatible. Per the Approval Matrix this requires **Technical Reviewer + Architecture Owner** approval, and an ADR is required because both changes reflect real design choices (documented in ADR-014's own Alternatives Considered).

## 3. Impact Analysis

**Frozen documents touched (exactly three, per `ARCHITECTURE_CHANGE_REQUEST_PROCESS_V1.0.md`'s own Scope, which names itself and the Architecture Decision Records as in-scope for any document edit):**
1. `AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md` — §5.3 (`knowledge_packs` entity: adds `lineage_root_id`, `lock_version`, the partial unique index) and §6 (Index Strategy: adds the new index to the existing bullet list).
2. `AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md` — Knowledge Packs permission category (adds `KP_VALIDATE`, `KP_ARCHIVE`).
3. `ARCHITECTURE_DECISION_RECORDS_V1.0.md` — new ADR-014 entry (this document's own edit is itself in-scope for this ACR, since the ADR document is itself frozen).

**Database entities/relationships changed:** `knowledge_packs` gains two columns and one partial unique index. No other entity's schema changes. `projects.knowledge_pack_id` (already frozen in Database Design §5.2) is unaffected by this ACR — its eventual implementation is Module 2 integration work building against an already-approved relationship, not a new decision this ACR governs.

**API endpoints changed:** none exist yet (Module 2 unimplemented) — no live contract is broken or altered.

**Queue job types/workflows changed:** none. Confirmed during Module 2's architecture checkpoint that Knowledge Pack validation is fully synchronous — no interaction with the Queue & Background Job Engine.

**Additive or breaking:** additive. Confirmed non-breaking against every currently-shipped entity, API, and workflow.

## 4. Risk Analysis

**Backward compatibility:** no risk — nothing existing changes meaning or behavior; `knowledge_packs` doesn't exist in any deployed environment yet.
**Data migration risk:** none — net-new table, no existing rows to migrate.
**Timeline risk:** none identified — Module 2 has not started implementation; no in-progress work depends on the prior (unextended) schema shape.
**Module 1 freeze impact:** **none — Module 1 remains COMPLETE/FROZEN** (tag `v1.9.1-module-1f-frozen`). This ACR does not reopen, modify, or depend on reopening any Module 1 deliverable. The one adjacent fact worth naming explicitly: `projects.knowledge_pack_id` was always part of Database Design §5.2's frozen design for the `projects` table (a Module 1C deliverable) but was never implementable until `knowledge_packs` exists — this ACR does not change that column's already-frozen definition and does not require reopening Module 1's freeze to eventually implement it during Module 2's own Phase 2.1.
**Module 3+ dependency impact:** clarifying, not constraining — any future module reading an active Knowledge Pack version must snapshot the exact version row `id` it used (already required by the existing immutable-historical-reference rule in the Cascade Strategy), never assume "the current Active row" remains stable indefinitely. This is a clarification of an already-implied requirement, not a new burden.
**Rollback considerations:** if this ACR were reverted before Phase 2.1 implementation begins, no data exists to migrate back — pure documentation rollback. If reverted after Phase 2.1 ships, the two new columns and two new permissions would need a real migration to drop, which is why the Technical Reviewer/Architecture Owner approval gate exists before implementation.
**Audit implications:** none beyond what Module 2's own architecture already specifies — every state transition (including a blocked/RESTRICT outcome) is audited within its own transaction, per the already-designed audit model.
**Testing implications:** Module 2's own test plan (not part of this ACR) must prove the partial unique index actually rejects a concurrent two-Active-rows attempt against real Postgres, matching this platform's established evidence standard (Module 1F's own precedent) — noted here as a dependency on this ACR's approval, not executed by it.

## 5. Alternatives Considered

See ADR-014's own Alternatives Considered section (`ARCHITECTURE_DECISION_RECORDS_V1.0.md`) for the full architectural reasoning — not duplicated here per the Approval Matrix's expectation that the ACR references the ADR rather than restating it.

## 6. Proposed Document Version Bumps

| Document | Current | Proposed | Rule applied |
|---|---|---|---|
| `AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md` | 1.1 | 1.2 | Minor bump — non-breaking addition |
| `AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md` | 1.0 | 1.1 | Minor bump — non-breaking addition |
| `ARCHITECTURE_DECISION_RECORDS_V1.0.md` | 1.0 | 1.1 | Minor bump — additive ADR entry, no existing ADR edited |

## 7. Governance Note — Worked-Example Identifier Collision

`ARCHITECTURE_CHANGE_REQUEST_PROCESS_V1.0.md`'s own "Worked Examples" section illustratively uses "ADR-014" and "Database Design v1.2" as hypothetical outcomes for a *different*, never-executed change (the Distribution Engine missing-entity-group gap flagged in Database Design Appendix G). No real ACR has ever been filed in this repository's history (confirmed: zero `acr-`-referenced commits). Since this is the first real ACR executed, it legitimately claims the next-available real identifiers (ADR-014, Database Design v1.2). **Flagged for the record:** whoever later files the Distribution Engine ACR must use ADR-015 and Database Design v1.3, not the process document's own illustrative numbers, which will be stale once this ACR closes.

## 8. Approval

- [x] Technical Reviewer (Arvind, fulfilling the Knowledge Engine role — see header) sign-off
- [x] Architecture Owner (Arvind) sign-off
- [x] ADR-014 written (`ARCHITECTURE_DECISION_RECORDS_V1.0.md`)
- [x] Frozen documents version-bumped (§6)
- [x] ACR marked Approved/Closed

**Architecture Owner approval statement, recorded verbatim:**

> "As Architecture Owner, I approve ACR-014: the Knowledge Pack `lineage_root_id` lineage-identity column and its partial unique index (at most one non-deleted ACTIVE row per lineage), root-only `knowledge_packs.lock_version` for aggregate-scoped optimistic concurrency, archive-before-activate atomic supersession, synchronous VALIDATING resolution with the Project-reference RESTRICT check integrated as an equal-weight precondition, no automatic Project reassignment, and the `KP_VALIDATE`/`KP_ARCHIVE` permissions (no separate `KP_ACTIVATE`) — as recorded in ADR-014 and applied to `AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md` (v1.2), `AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md` (v1.1), and `ARCHITECTURE_DECISION_RECORDS_V1.0.md` (v1.1). This approval authorizes the architecture. Phase 2.1 implementation is separately authorized by execution instruction."

**Status: APPROVED / CLOSED, 2026-08-22.**
