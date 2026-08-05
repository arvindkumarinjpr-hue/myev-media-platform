# QUEUE_AND_BACKGROUND_JOB_ENGINE

## Queue & Background Job Engine Specification

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN — no further modifications unless an approved Architecture Change Request exists.
**Purpose:** The enterprise execution architecture coordinating every asynchronous unit of work in AI-COS. This is the physical implementation of the async contract already established by FRD §20 (Long-running Job Pattern) and the FR-*/§24 state machines — not a BullMQ tutorial, not an implementation.

---

## 1. Queue Engine Vision

No business module executes long-running work synchronously. Every unit of async work — a single AI call, a 45-minute video render, a nightly analytics import — routes through this engine, which owns dispatch, retry, prioritization, dependency ordering, and completion signaling uniformly across all of it.

## 2. Queue Architecture

```
Business Module (API layer, per API Spec §20/22)
      ↓ enqueue
Queue Broker (Redis-backed)
      ↓ dispatch
Worker Pool (per Queue Category, §3)
      ↓ execute
Job Status Store (Postgres — ai_jobs / publishing_jobs / background_jobs, DB Design §5.5/5.7/5.12)
      ↓ on completion
Webhook / Notification Dispatch (API Spec §19, FRD §22)
```
Postgres is always the source of truth for a job's business status; Redis is the dispatch mechanism, not the system of record (formalized in §11, ADR-007).

## 3. Queue Categories

| Queue | Job Types | Default Priority | Concurrency Reference |
|---|---|---|---|
| Critical | Publishing failures, system alerts | CRITICAL | Per FRD §22 |
| Realtime | Single AI Copilot calls, low-latency user-triggered requests | HIGH | Isolated from bulk generation so users aren't stuck behind a render |
| AI | Research/Blog/Video content-generation steps (Brief/Outline/Draft/Script) | NORMAL | 10 concurrent/workspace (FRD §21.1) |
| Media | Image/Voice generation, Video Rendering | NORMAL | 2 concurrent renders, global (FRD §21.1) |
| Publishing | Scheduled/immediate publishing execution | HIGH | Per channel/platform limits |
| Analytics | Scheduled analytics import | LOW | Daily cadence (FRD §21.1) |
| Maintenance | Retention cleanup, link-health re-indexing | BACKGROUND | No user-facing urgency |
| Notification | Outbound delivery (Email/Slack/Webhook) | Matches source event's priority | Per FRD §22 |
| System | Health checks, backup triggers | BACKGROUND | Platform-level |

Media Queue is deliberately isolated with dedicated workers (§8) — this is the direct mitigation for the shared-VPS resource contention risk flagged in the Phase-0 Readiness Report §5.

## 4. Job Lifecycle

**This section defines the Queue Engine's internal execution lifecycle — a finer-grained decomposition of, not a replacement for, the frozen FRD §24 state machines and Appendix A Job Status enum (`QUEUED`/`RUNNING`/`COMPLETED`/`FAILED`/`TIMED_OUT`).**

```
QUEUED → RESERVED → RUNNING → [RETRYING | WAITING_DEPENDENCY] → COMPLETED | FAILED | EXPIRED
                                                                        ↓
                                                                    ARCHIVED
```

| Engine-internal state | Externally-visible FRD status | Notes |
|---|---|---|
| QUEUED | `QUEUED` | Waiting for a worker |
| RESERVED | `QUEUED` | A worker has claimed the job but not yet started — internal bookkeeping only |
| RUNNING | `RUNNING` | Executing |
| RETRYING | `RUNNING` | Mid-backoff after a transient failure |
| WAITING_DEPENDENCY | `RUNNING` | Blocked on §6's dependency chain |
| COMPLETED | `COMPLETED` | Terminal, success |
| FAILED | `FAILED` | Terminal, exhausted retries or permanent error |
| EXPIRED | `TIMED_OUT` | Exceeds FRD §21.1's timeout — maps directly to the already-approved `TIMED_OUT` status |
| ARCHIVED | `ARCHIVED` | Retention-driven follow-on after `COMPLETED` |

**Flagged, not silently resolved:** `CANCELLED` is a useful engine-level capability but has no approved business-entity status to transition into — absent from FRD §24.4/24.7/24.8. Until an Architecture Change Request adds it, a cancelled job is recorded at the engine level, but the owning business entity is set to `FAILED` with error code `PUBLISH_CANCELLED_BY_USER` (API Spec Appendix B convention) rather than a new status value. This is how `POST /publishing-jobs/{id}/cancel` (API Spec §23) resolves against the frozen state machine.

## 5. Job Priority Model

`CRITICAL`/`HIGH`/`NORMAL`/`LOW` map directly onto FRD Appendix A's frozen Priority enum. **`BACKGROUND` is a Queue-Engine-internal fifth tier**, not added to that frozen shared enum — used only for Maintenance/System queue jobs with zero user-facing urgency.

- **Starvation prevention:** a job aging beyond a configurable threshold receives an automatic priority boost.
- **Priority inheritance:** a dependency (§6) of a CRITICAL job temporarily inherits CRITICAL priority, preventing priority inversion.

## 6. Queue Dependency Model

```
Research → Keyword → Brief → Outline → Draft → SEO → Internal Linking → QA → Approval → Publishing
```
Matches FRD Section 10 (Blog Automation) exactly. Video Automation follows an analogous chain per FRD Section 11: `Research → Keyword → Brief → Script → Scene → Asset → Voice → Subtitle → Render → QA → Approval → Publishing`. A job with unmet dependencies enters `WAITING_DEPENDENCY` (§4) — tracked but not dispatch-eligible until its dependency reaches `COMPLETED`.

## 7. Retry Strategy

Formalizes FRD §21.1, invents no new numbers:
- **Retry Count:** max 3 (configurable per job type).
- **Exponential Backoff:** `delay = min(30s × 2^attempt, 10min)`.
- **Permanent vs. transient:** `PERMISSION_DENIED`/`VALIDATION_FAILED`/`NOT_FOUND` = permanent (0 retries); `TIMEOUT`/`PROVIDER_FAILURE`/`RATE_LIMITED` = transient (retried) — per FRD Appendix B's vocabulary.
- **Manual Retry:** valid only when business status is `FAILED` (PRS §23 / API Spec §23).
- **Auto Retry:** system-triggered per the backoff schedule.
- **Circuit Breaker:** a provider/platform failing above a threshold rate pauses new dispatches temporarily (§14).
- **Dead Letter Queue:** jobs exhausting all retries land in a DLQ for manual inspection — data source for PRS §25's "Failed Jobs" widget.

## 8. Worker Architecture

- **Dedicated Workers:** Media Queue isolated, protecting other queues from shared-VPS resource risk (Phase-0 §5).
- **Shared Workers:** Realtime/AI/Publishing/Analytics/Notification/System share a pool.
- **Horizontal Scaling:** additional workers per queue category, independently — makes Deployment Architecture's V2 step a scaling operation, not a redesign.
- **Worker Health:** heartbeat-based; a non-heartbeating worker's in-flight jobs are requeued.
- **Worker Registration:** workers declare their queue-category capability on startup.
- **Worker Shutdown:** graceful, drains in-flight jobs to a safe checkpoint before terminating.

## 9. Scheduling Engine

`Immediate` · `Delayed` (future `run_at`, FR-PUB-002) · `Recurring`/`Cron` (Analytics import, retention cleanup, link-health re-indexing) · `Dependency Trigger` (§6) · `Manual Trigger` (user-initiated retry/re-run).

## 10. Queue Monitoring

Per-queue: Pending, Running, Success Rate, Failure Rate, Average Execution Time, Longest Running, Worker Utilization, Queue Depth — the data source behind PRS §25's "Queue Health" and "AI Jobs" widgets.

## 11. Failure Recovery

Worker Crash → requeue via heartbeat timeout (§8). Provider Timeout → FRD §21.1 timeouts + retry (§7) + circuit breaker (§7/§14). Queue Corruption → Postgres authoritative over Redis, rebuilt from Postgres on disagreement (ADR-007). Duplicate Jobs → prevented via Idempotency (§12). Partial Success → completed steps preserved on failure, retry resumes from the failed step. Rollback Strategy → most outputs are additive, so "rollback" is simply not advancing status. Recovery Strategy (Publishing) → ambiguous failures trigger a platform-state check before retrying, avoiding duplicate live publishes.

## 12. Idempotency

Job fingerprint = hash of `workspace_id` + job type + input payload + optional `Idempotency-Key` (API Spec §17). Duplicate fingerprint within a time window is deduplicated at enqueue time. Safe retries reuse the same fingerprint. Execution lock (Redis-based distributed lock) prevents two workers claiming the same job in a horizontally-scaled setup.

## 13. Concurrency Strategy

| Dimension | Limit | Source |
|---|---|---|
| Per Workspace | 10 concurrent AI jobs | FRD §21.1, exact |
| Per User | Not previously specified — new, practical addition, pending confirmation | New |
| Per Provider | Dynamic, per that provider's actual rate limit | AI Provider Abstraction Layer |
| Per Worker | Sized per queue category's resource profile | Derived |
| Per Queue | 2 concurrent video renders, global | FRD §21.1, exact |

## 14. Provider Failover

Formalizes AI Provider Abstraction Layer's Fallback rule: configurable fallback order per workspace/Knowledge Pack; provider-level failure triggers immediate failover (distinct from §7's same-provider retry); provider cooldown implements the Circuit Breaker (§7) specifically for AI providers.

## 15. Resource Management

CPU/Memory sized per queue category (Docker Compose constraints, referenced not defined here). GPU: future, for AI Avatar Video. Disk: Media workers need scratch space for temporary render files (24hr max, FRD §23, auto-purged). Storage/Network: shared platform-level resources, restating the Phase-0 shared-VPS consideration.

## 16. Security

Every job carries `workspace_id` and triggering user (DB Design). Workspace isolation (FR-WS-005) applies identically to job execution. Payload validation reuses API Spec §9's DTO rules. Sensitive payloads encrypted at rest (DB Design Appendix F, `RESTRICTED`). Secrets referenced by ID, never embedded in payloads. Every terminal transition is audit-logged.

## 17. Observability

Job Trace → Request Trace (`X-Request-ID`, API Spec §8/§29) → Correlation ID (shared across `ai_job_steps`) → Execution Timeline → Metrics (§10) → Structured Logs. This section defines what the Queue Engine **emits**; the Observability & Monitoring specification owns aggregation/alerting.

## 18. Dashboard Specification

Queue Health → §10 · Worker Health → §8 · Provider Health → §14 · Retry Dashboard → §7 · Dead Letter Queue → §7, Administrator-only · Execution Timeline → §17.

## 19. Scaling Strategy

V1 — single VPS, all workers as Docker Compose services. V2 — horizontally scaled worker containers per category. V3 — dedicated worker nodes, per Enterprise Architecture's existing step. V4 — Kubernetes/auto-scaling. No new tiers added.

## 20. Disaster Recovery

Restart resumes from Postgres's authoritative status (§11). Replay: DLQ jobs manually replayed by an Administrator. Recovery matches Database Design's Backup & Recovery Mapping (Incremental, P2 priority). Backup: Recurring job configuration backed up per Deployment Architecture's Configuration Backup. Consistency: Postgres always wins over Redis.

## 21. Future Expansion

Distributed queues, Event Bus, Kafka/RabbitMQ (illustrative, not committed — no existing document names a specific broker beyond Redis/BullMQ for V1), Multi-region execution (Deployment Architecture's existing V4 step).

---

## Consistency Review

Reconciled against the frozen FRD's Job Status/Priority enums explicitly (§4/§5) rather than silently extending them; `CANCELLED` and per-user concurrency flagged as open items for a future Architecture Change Request, not silently resolved. All retry/timeout/concurrency numbers reuse FRD §21.1 verbatim. Dashboard sections are explicit data-source definitions for already-approved PRS widgets, not new UI.

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN
