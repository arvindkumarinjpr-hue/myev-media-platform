# OBSERVABILITY_AND_MONITORING_SPECIFICATION

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN — no further modifications unless an approved Architecture Change Request exists.
**Purpose:** How the platform detects, measures, logs, traces, and alerts every operational event. Technology-agnostic — no Grafana, Prometheus, OpenTelemetry, Docker, or Kubernetes specifics.

---

## 1. Observability Vision
Answers "what is happening, why, and how healthy is it" at any moment — implements what FRD §21.5, API Specification §29, and Queue & Background Job Engine §17 all deferred to this document.

## 2. Logging Strategy
Structured logs only. Three streams: Application logs (per-service), Audit logs (Security & Access Control — boundary noted, not redefined), Access logs (API request/response, CloudPanel/nginx edge layer).

## 3. Structured Log Format
Common schema: `timestamp, level, service, workspace_id (where applicable), request_id, correlation_id, message, context (JSONB)` — matches API Specification §8/§29 and Queue Engine §17 exactly.

## 4. Correlation IDs
Reuses Queue Engine §17 verbatim: propagated request→job→step, enabling full end-to-end trace reconstruction.

## 5. Distributed Tracing
Every cross-service call (API→Queue→Worker→AI Provider) propagates trace context; a single trace reconstructs one user action's full lifecycle. No specific tracing protocol named — an implementation choice.

## 6. Metrics Collection
Three standard types: Counters (jobs completed, API requests), Gauges (queue depth, active workers), Histograms (latency, job duration distributions).

## 7. Queue Metrics
Reuses Queue Engine §10 verbatim — this document owns aggregation/alerting on top of what Queue Engine emits.

## 8. API Metrics
Request rate, latency (p50/p95/p99 against FRD §21.1 targets), error rate by status code/error namespace (API Specification Appendix B), per-endpoint breakdown.

## 9. AI Provider Metrics
Reuses AI Provider Abstraction Layer's existing Monitoring section verbatim: Token Consumption, Cost per Provider, Success Rate, Average Latency, Error Rate, Provider Availability.

## 10. Database Metrics
Connection pool utilization, query latency, replication lag (future, V2+ read replicas), table/index bloat, backup success/failure.

## 11. Redis Metrics
Memory usage, eviction rate, connection count — Redis-as-cache metrics distinct from Redis-as-queue-broker metrics (§7).

## 12. Worker Metrics
Reuses Queue Engine §8/§10: heartbeat status, utilization, per-queue-category breakdown.

## 13. Publishing Metrics
Real-time operational view (live success/failure rate by channel). Distinguished from Analytics Engine §16's historical/business-reporting view of the same underlying `publishing_history` data.

## 14. Health Checks
Reuses API Specification §25 exactly (`/health`, `/health/ready`, `/health/detailed`) — this document defines what each check verifies.

## 15. Liveness
Process running and responsive — matches `/health`.

## 16. Readiness
Dependencies (DB/Redis/Queue) reachable and healthy — matches `/health/ready`.

## 17. Alert Rules
Threshold-based defaults, flagged pending confirmation (no existing document set specific numbers): Queue Depth > N for 5+ minutes, Error Rate > X% over 5 minutes, Worker heartbeat missed, AI Provider success rate below threshold.

## 18. Incident Severity
SEV1 (platform down / data loss risk) · SEV2 (major feature degraded) · SEV3 (minor/single-workspace) · SEV4 (cosmetic) — a new taxonomy, flagged pending confirmation.

## 19. Escalation Rules
Maps to FRD §22's recipients: SEV1/SEV2 → Administrator immediately (Critical priority); SEV3/SEV4 → standard notification queue.

## 20. Monitoring Dashboard
Consolidates Queue/Worker/Provider Health (Queue Engine §18) + API + DB/Redis health into one Administrator-facing view. PRS §25's widgets are the UI surface; this section is the backing data model.

## 21. Error Budget
Derived from FRD §21.3's 99% V1 availability target: ~7.3 hours allowed downtime/month.

## 22. SLA Monitoring
Tracks actual uptime against FRD §21.3's 99% target, reported monthly.

## 23. SLO Monitoring
Finer-grained internal objectives feeding the SLA — e.g. API p95 latency SLO (FRD §21.1), Queue job success rate SLO.

## 24. Audit Monitoring
Distinct from Audit Logging (Security doc): anomaly detection **on** the existing immutable `audit_logs` table — an analysis layer, not a new logging mechanism.

## 25. Security Monitoring
Reuses Security & Access Control's existing section verbatim (Failed Login Detection, Suspicious Activity Alerts, API Error Monitoring, Token Usage Monitoring, Access Log Review) — this document defines the alerting/escalation wiring (§17–19).

## 26. Capacity Planning
Tracks resource utilization trends (Queue Engine §15, DB size growth) against the shared-VPS reality (Phase-0 §5) to forecast when V2 scaling becomes necessary.

## 27. Performance Baselines
Establishes normal-range values per metric during a stable period, so §17's alerts fire on deviation from baseline.

## 28. Disaster Monitoring
Detects conditions matching Deployment Architecture's existing DR scenarios (backup failure, replication failure) — a monitoring layer over that plan.

## 29. Recovery Monitoring
Tracks in-progress recovery actions (a DLQ replay per Queue Engine §20, a DB restore) to confirm successful completion.

## 30. Future Distributed Monitoring
Flagged future: multi-region monitoring aggregation, once Deployment Architecture's V4 multi-region step is reached.

---

## Consistency Review

Every metric/log/trace section explicitly cites which prior document it reuses (Queue Engine, API Specification, AI Provider Abstraction Layer, Security & Access Control) rather than redefining them — this document's unique contribution is aggregation, alerting, and escalation (§17-20), not new data collection. Two new taxonomies (Alert thresholds §17, Incident Severity §18) flagged pending confirmation rather than presented as settled.

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN
