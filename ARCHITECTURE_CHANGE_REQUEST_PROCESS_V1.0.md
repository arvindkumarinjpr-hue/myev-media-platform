# ARCHITECTURE_CHANGE_REQUEST_PROCESS

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN — this process document itself may only change via the process it defines.
**Purpose:** How future architectural changes to the frozen Phase-0 documentation set are proposed, reviewed, approved, and implemented. No architecture document may change without an approved Architecture Change Request (ACR).

---

## Purpose

Phase-0 froze 32 documents as the engineering baseline. Requirements will still evolve — this process is how they evolve safely, with every change traceable to a decision, not a silent edit.

## Scope

Applies to every document marked `Document State: FROZEN`, including this one and the Architecture Decision Records. Does not apply to application code (governed separately by the coding standards in the Engineering Kickoff Report) or to non-architectural content (e.g. fixing a typo that doesn't change meaning — see the Approval Matrix's lowest tier).

## Roles

| Role | Responsibility |
|---|---|
| Requester | Anyone — identifies the need for a change, drafts the initial ACR |
| Technical Reviewer | The module's owner per Database Design Appendix G's Data Ownership Matrix — assesses technical feasibility and impact |
| Architecture Owner | The Owner role (Arvind) — final approval authority for anything touching frozen architecture |

## ACR Workflow

```
Propose → Impact Analysis → Risk Analysis → Review → Approve/Reject → Implement → Documentation Update → Close
```

1. **Propose:** Requester drafts the ACR using the template below.
2. **Impact Analysis:** which frozen documents, modules, entities, and APIs are affected.
3. **Risk Analysis:** backward compatibility, data migration, timeline risk.
4. **Review:** Technical Reviewer(s) for each affected domain assess feasibility.
5. **Approve/Reject:** per the Approval Matrix below.
6. **Implement:** the actual document/schema/API change is made.
7. **Documentation Update:** affected frozen documents are version-bumped and re-frozen; a new ADR is written if the change is decision-worthy (see ADR criteria).
8. **Close:** ACR marked complete, linked from the affected documents' revision history.

## Impact Analysis

Every ACR must enumerate: which of the 32 frozen documents are touched, which database entities/relationships change, which API endpoints change, which Queue job types or workflows change, and whether the change is additive (safe) or breaking (requires more scrutiny).

## Risk Analysis

Every ACR must assess: backward compatibility risk (does anything currently working break), data migration risk (does existing data need transformation), and timeline risk (does this block or delay a Module currently in progress).

## Backward Compatibility

Backward compatibility is the default requirement, not an option — waived only with explicit Architecture Owner sign-off and a stated reason, following the precedent set by ADR-011 (breaking API changes require a new version prefix, never in-place changes to `v1`).

## Approval Matrix

| Change Type | Required Approval | ADR Required? |
|---|---|---|
| Typo/clarification fix, no meaning change | Technical Reviewer only | No |
| New entity/field addition (non-breaking) | Technical Reviewer + Architecture Owner | If it reflects a real design choice, yes |
| Breaking schema/API change | Architecture Owner + all affected module owners | Yes, mandatory |
| New module/major feature | Architecture Owner only | Yes, mandatory + Product Backlog update |

## Implementation Process

ACR approved → write the ADR entry (if required) → update the affected frozen document(s) with an incremented version number → re-run the consistency review against every dependent document (same rigor as Phase-0's own review passes) → commit with an ACR-referenced message → push.

## Documentation Update Rules

- Never edit a frozen document in place without a corresponding ACR reference in the commit.
- Version numbers always increment (`v1.1` → `v1.2`, following the pattern already used throughout Phase-0) — never silently overwritten in place.
- `Document State: FROZEN` is lifted only for the specific approved edit, then immediately re-set to `FROZEN` once the change lands.
- Existing ADRs are never edited — a changed decision gets a new ADR that explicitly supersedes the old one.

## Git Requirements

Every commit touching a frozen document must reference its ACR number in the commit message (e.g. `docs(acr-014): add Distribution Engine entity group`). No direct pushes to a frozen document without a linked ACR — this is a process rule, not a technical git restriction, and relies on reviewer discipline until/unless a branch-protection mechanism is added.

## Versioning Rules

Documents use a `major.minor` scheme matching the pattern already established in Phase-0 (`v1.0 → v1.1 → v1.2`): **major** bump for breaking/architectural changes, **minor** bump for clarifications or non-breaking additions.

## Worked Examples

**Example 1 — Minor addition:** Adding Distribution Engine's missing entity group (flagged during Phase-0, Database Design Appendix G) is a non-breaking addition. Approval: Technical Reviewer (Database owner) + Architecture Owner. ADR required, since it's a real design choice (how Distribution's entities relate to the existing chain). Result: `AI_CONTENT_DATABASE_AND_ENTITY_DESIGN` bumps to `v1.2`, new ADR-014 written.

**Example 2 — Breaking change:** Replacing PostgreSQL with a different database. This contradicts ADR-006 directly. Approval: Architecture Owner only, mandatory new ADR explicitly superseding ADR-006, full impact analysis across Database Design, API Specification, Queue & Background Job Engine, and Deployment Architecture — all four would need coordinated version bumps in a single ACR, not four independent ones.

---

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN
