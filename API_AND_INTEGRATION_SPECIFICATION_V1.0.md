# API_AND_INTEGRATION_SPECIFICATION

## API & Integration Specification

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN — no further modifications unless an approved Architecture Change Request exists.
**Purpose:** Single source of truth for Frontend↔Backend↔AI Agents↔Queue Workers↔External Providers↔future SDKs. Technology-agnostic — no controller code, no OpenAPI/Swagger, no NestJS specifics.

---

## 1. API Design Principles

**API-First · Connector-Based · Provider-Agnostic · Secure by Default · Versioned · Idempotent · Event-Driven · Observable.** This contract is the same contract for every consumer — no consumer gets a private/undocumented endpoint.

## 2. REST Standards

Resource-oriented URLs, JSON bodies. Verbs: `GET`, `POST` (create/trigger), `PATCH` (partial update — matches PRS's autosave pattern), `DELETE` (soft delete only, per Database Design §4). `PUT` is not used.

## 3. Resource Naming

`/api/v1/{resource}`, plural nouns, max 2 levels of nesting (e.g. `/workspaces/{id}/projects`). Resource names match the PRS's user-facing entities (`/blogs`, `/videos`) which are `content_items` filtered by `content_type` under the hood, plus a generic `/content-items` for cross-type operations.

## 4. Versioning Strategy

URI versioning: `/api/v1/*`. A breaking change requires a new version prefix, never an in-place breaking change.

## 5. Authentication Flow

```
POST /auth/login (email/password) → { access_token, refresh_token }
POST /auth/oauth/callback → { access_token, refresh_token }
Authorization: Bearer {access_token}  on every subsequent request
POST /auth/refresh (refresh_token, httpOnly cookie) → { access_token }
POST /auth/logout → revokes refresh_token
```
Implements FR-AUTH-001/002/003. Refresh tokens transported as httpOnly cookies; access tokens in the `Authorization` header.

## 6. Authorization Rules

Every endpoint declares a required permission constant (FR-AUTH-004). Missing/invalid token → `401`. Insufficient permission → `403`. Cross-workspace resource access → `404`, never `403` (FRD §18).

## 7. Workspace Context Handling

The effective `workspace_id` is always taken from the JWT's workspace claim, never from a client-supplied body/query field. A mismatched body value → `400 WORKSPACE_MISMATCH`.

## 8. Standard Headers

| Header | Direction | Purpose |
|---|---|---|
| `Authorization: Bearer {token}` | Request | Auth (§5) |
| `X-Request-ID` | Request/Response | Tracing — feeds Observability |
| `X-Workspace-Id` | Request | Informational only — must match JWT claim or `400` |
| `Idempotency-Key` | Request | Required on state-changing POSTs (§17) |
| `Deprecation` / `Sunset` | Response | On deprecated endpoints only (§30) |

## 9. Request Validation

DTO-level validation per module. Failures return `422 {NAMESPACE}_VALIDATION_FAILED` with an itemized field-level error list.

## 10. Response Standards

```
Success: { "data": {...}, "meta": {...} }
List:    { "data": [...], "meta": { "next_cursor": "...", "total": null } }
```
Every resource includes `public_id`, human `reference_id` (Database Design Appendix E), `status`, `created_at`, `updated_at` — internal UUID `id` is never returned.

## 11. Error Model

Directly implements FRD Appendix B: `{ "error": { "code": "BLOG_VALIDATION_FAILED", "message": "...", "details": [...] } }`. HTTP status follows Appendix B's mapping exactly.

## 12. Pagination

Cursor-based: `?cursor=&limit=` (default 20, max 100, configurable). `next_cursor: null` when exhausted.

## 13. Filtering

Bracket notation: `?filter[status]=REVIEW&filter[content_type]=BLOG`. Values must match FRD Appendix A enum values — invalid value returns `400`.

## 14. Sorting

`?sort=field` / `?sort=-field`. Each resource whitelists sortable fields; non-whitelisted field returns `400`.

## 15. Search

Implements PRS §24: `GET /search?q=&scope=&filter[...]`. Always workspace-scoped (FR-WS-005). Results grouped by entity type per PRS §24's Result Layout.

## 16. Batch Operations

Implements PRS §23: `POST /{resource}/bulk/{action}` with `{ "ids": [public_id, ...] }`. Supports partial success:
```
{ "data": { "succeeded": [...], "failed": [{ "id": "...", "error": {...} }] } }
```

## 17. Idempotency

`Idempotency-Key` required on state-changing POSTs triggering jobs or real-world side effects. A repeated key within 24 hours returns the original response.

## 18. Rate Limiting

Standard endpoints: baseline rate limit per user/workspace, `429` + `Retry-After`. AI-generation endpoints: capped by FRD §21.1's concurrency limits (10/workspace, 2 renders global) — breach returns `429 QUEUE_CONCURRENCY_LIMIT`.

## 19. Webhooks

Events: Publish Completed, Render Completed, AI Job Finished, Content Approved, Analytics Updated. HMAC-signed payload, retry matches FRD §21.1 (3 attempts, exponential backoff).

## 20. Long-running Job Pattern

```
POST /blogs/{id}/generate-outline → 202 Accepted, { "job": { "public_id", "status": "QUEUED" } }
GET /ai-jobs/{job_id} → poll for status
(or) webhook AI_JOB_FINISHED fires on completion
```

## 21. File Upload APIs

```
POST /media/upload-url { "asset_type", "file_size" } → { "upload_url", "storage_path" }
[client uploads directly to R2/MinIO]
POST /media { "storage_path", "content_item_id" } → confirms, creates media_assets row
```
Respects FRD §21.1's max upload sizes.

## 22. AI Job APIs

`POST /ai-jobs` (generic trigger, `agent_name` + `input_payload`). Every content-generation endpoint (`generate-outline`, `generate-draft`, `generate-script`) is a thin wrapper around this primitive, same async contract (§20). `GET /ai-jobs/{id}/steps` exposes `ai_job_steps`.

## 23. Publishing APIs

```
POST /channels (OAuth connect, FR-PUB-001)
POST /content-items/{id}/publishing-jobs (schedule, FR-PUB-002)
GET  /publishing-jobs?filter[status]=
POST /publishing-jobs/{id}/retry   — only valid when status = FAILED, else 409
POST /publishing-jobs/{id}/cancel  — only valid when status = SCHEDULED|QUEUED, else 409
```
Note: `cancel` resolves the target item to `FAILED` with error code `PUBLISH_CANCELLED_BY_USER` (see Queue & Background Job Engine §4 for the full reconciliation against the frozen Publishing Job state machine).

## 24. Analytics APIs

Read-only from the frontend's perspective.
```
GET /analytics/dashboards/{type}   — type ∈ the 6 PRS §11 dashboards
GET /analytics/metrics?content_item_id=&date_range=
```

## 25. Health Check APIs

```
GET /health          — liveness, no auth
GET /health/ready     — readiness: DB/Redis/Queue connectivity
GET /health/detailed  — Administrator-only, Provider/Queue Health
```

## 26. Internal Service APIs

Service-to-service only (Queue Workers → API, AI Provider callbacks), authenticated via service tokens, never user JWTs — structurally distinct from the public surface.

## 27. Provider Adapter Interfaces

Formalizes the AI Provider Abstraction Layer's contract:
**Standard Input:** Workspace ID, Project ID, Agent Name, Prompt, Context, Knowledge Pack, Output Format, Temperature, Max Tokens.
**Standard Output:** Provider, Model, Request ID, Output, Token Usage, Cost Estimate, Execution Time, Confidence (optional).

## 28. API Security

HTTPS only (CloudPanel/nginx edge). JWT validated on every protected route. RBAC per FR-AUTH-004. Input sanitized at DTO layer. CSRF mitigated via `SameSite=Strict` on the refresh-token cookie, not a separate CSRF scheme. Secrets never logged.

## 29. API Observability

Every request carries `X-Request-ID` through to structured logs. Latency tracked against FRD §21.1's p95/p99 targets. Full metrics/tracing/alerting is the Observability & Monitoring specification's responsibility — this section defines what the API must emit.

## 30. API Deprecation Policy

Once `/api/v2/` exists, `/api/v1/` responses carry `Deprecation`/`Sunset` headers. Minimum deprecation window: 90 days — a practical default, flagged as configurable/pending confirmation.

---

## Consistency Review

Error model implements FRD Appendix B with no new codes invented. Long-running Job Pattern matches every async FR exactly. Batch Operations implement PRS §23 including partial-success behavior. Response Standards use the exact three-identifier model from Database Design Appendix E. Publishing cancel behavior (§23) explicitly cross-referenced against Queue Engine §4's frozen-state-machine reconciliation rather than left ambiguous. One open item flagged: 90-day deprecation window (§30) is a new figure pending confirmation.

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN
