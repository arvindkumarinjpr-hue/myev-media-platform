# ANALYTICS_ENGINE

## Analytics Engine Specification

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN — no further modifications unless an approved Architecture Change Request exists.
**Purpose:** How business metrics are collected, processed, stored, calculated, and exposed — not a dashboard design document. Every metric reuses entities already approved in Database Design; no new tables invented.

---

## 1. Analytics Vision
The business-intelligence layer turning raw platform activity and external platform data into actionable metrics, closing the Content Scoring Engine's existing Learning Loop (Generated→Scoring→Published→Analytics→Actual Performance→Model Improvement) and feeding the Growth Engine's recommendations (FR-GROW-*).

## 2. Analytics Architecture
```
External Sources (GA, GSC, YouTube Analytics, Meta Insights)  ─┐
Internal Platform Events (content lifecycle, AI jobs, publishing) ─┤
                                                                    ↓
                                            Collection (Analytics Queue, Queue Engine §3)
                                                                    ↓
                                                            Aggregation (§8)
                                                                    ↓
                                            Metrics Store (Database Design §5.9 tables)
                                                                    ↓
                                            Analytics API (API Specification §24, read-only)
                                                                    ↓
                                                Dashboards (PRS §11/§25)
```

## 3. Data Collection Strategy
- **External Pull:** scheduled Analytics Queue jobs (Queue Engine §9 Recurring) pull from GA/GSC/YouTube/Meta per FR-ANLY-001.
- **Internal Push:** platform events (content published, AI job completed, SEO score calculated) emitted directly into the pipeline as they happen — not polled.

## 4. Event Tracking Model
Common internal event shape: `event_type, workspace_id, entity_type, entity_id, timestamp, payload (JSONB)` — a distinct stream from `audit_logs`/`notifications` (different purpose/retention, per Database Design's domain separation). Core event types: `content.created`, `content.published`, `ai_job.completed`, `publishing_job.succeeded`, `publishing_job.failed`, `seo_score.calculated`, `keyword.discovered`, `distribution.submitted` (this event's backing entity inherits the Distribution Engine gap already flagged in Database Design Appendix G — noted, not re-invented here).

## 5. Content Performance Metrics

| Metric | Source | Backing Entity |
|---|---|---|
| Views / Impressions | External pull | `traffic_reports` |
| CTR | External pull | `traffic_reports` / `ranking_history` |
| Watch Time / Retention | YouTube Analytics | `video_metrics` |
| Engagement (likes/comments/shares) | External pull | `engagement_metrics` |
| SEO Performance | Internal (FR-SEO-003) + external | `seo_reports` + `ranking_history` |
| Publishing Success | Internal | `publishing_history` (derived rate) |
| AI Usage | Internal | `ai_usage_logs` |
| Knowledge Pack Usage | Internal — new derived metric, no new entity | `ai_jobs` |
| Provider Cost | Internal | `ai_usage_logs.cost` |
| Growth Score | Internal (FR-GROW-002) | `viral_scores` / `content_scores` |

## 6. Business KPIs
Reuses FRD §2's Business Objectives and Blueprint's Success Metrics — mapped to real queries: Automation Success Rate (`ai_jobs` success rate), Organic Traffic (`traffic_reports`), Rankings (`ranking_history`), Leads/Revenue/ROI (`roi_reports`). **Time Saved** requires a baseline-effort assumption not yet defined — flagged as an open item pending your input on what manual baseline to measure against.

## 7. Dashboard Data Sources
Direct mapping to PRS §11's 6 dashboards: Executive ← aggregate across all metric tables · SEO ← `seo_reports`/`keywords`/`ranking_history` · Video ← `video_metrics` · Blog ← `blog_metrics` · Growth Opportunities ← `recommendations` · Competitor Benchmark ← `competitors` + `ranking_history`.

## 8. Aggregation Strategy
Raw events roll up into hourly/daily pre-aggregated summary rows so dashboards hit FRD §21.1's p95<300ms target by querying rollups, never raw event streams. Daily granularity for most metrics; hourly for Queue/Provider-health-adjacent metrics (shared with Queue Engine §10, not duplicated).

## 9. Historical Data Strategy
Raw events: shorter retention, per Database Design §10's V3 partitioning candidates. Rollups: retained much longer. Historical trend charts always read rollups.

## 10. Data Refresh Strategy
Matches FR-ANLY-001: External Pull on a daily default cadence (configurable); Internal Push near-real-time. PRS §9's "Data Delayed" banner fires whenever the last successful External Pull exceeds its expected cadence.

## 11. Scheduled Analytics Jobs
Reuses Queue Engine §3 (Analytics Queue) + §9 (Recurring/Cron): nightly GA/GSC/YouTube/Meta pulls, hourly internal rollup, daily Growth Score recalculation.

## 12. Growth Analytics
Implements FR-GROW-001/002 exactly. Growth Score composite reuses Content Scoring Engine's existing formula (SEO+Viral+Quality+Engagement+Business → Overall).

## 13. AI Cost Analytics
Per-provider, per-workspace cost tracking from `ai_usage_logs` — extends the existing Provider Health widget (PRS §25) rather than creating a new dashboard.

## 14. Workspace Analytics
Powers the Workspace Health widget (PRS §25), Owner-only. The Owner sees each workspace's data presented separately — never merged or aggregated across workspaces, preserving FR-WS-005 even for the Owner role.

## 15. Team Productivity Analytics
New category, no schema change required — derived from existing timestamps: content items produced per Writer/Editor, average time-to-approval per Content Manager, publishing cadence per Publisher.

## 16. Publishing Analytics
Success/failure rate by channel/platform, average time-to-publish — derived from `publishing_history`. This is the historical/business-reporting view; the Observability specification's §13 covers the real-time operational view of the same underlying data.

## 17. SEO Analytics
Keyword ranking trends, internal link coverage, orphan content count over time — derived from `seo_reports`/`internal_links`/`keywords` + `ranking_history`.

## 18. Trend Analytics
Topic/keyword momentum over time — feeds back into Trend Discovery (FR-RES-001), closing the Content Scoring Engine's Learning Loop.

## 19. Reporting Engine
On-demand report generation combining rollup data into a point-in-time export, backing PRS's existing "Export" dashboard standard.

## 20. Export Strategy
Matches FRD §23's Exports row exactly (R2, signed URL, 30-day retention) — reused, not redefined.

## 21. Data Retention
Matches Database Design §10 + FRD §23; raw-vs-rollup distinction per §9 above.

## 22. Privacy Rules
No individual end-audience PII is collected — external analytics (GA/YouTube/Meta) return aggregate metrics only. Team Productivity Analytics (§15) is visible only to Owner/Administrator/Content Manager, not to an individual's peers — a UX/privacy default, flagged as configurable.

## 23. Security
Analytics classified `INTERNAL` per Database Design Appendix F. Read-only API surface (API Specification §24) — no direct write access from the frontend.

## 24. Future ML Predictions
Flagged future per Growth Engine doc's existing "Predictive growth forecasting" enhancement — not committed to in V1.

## 25. Future Recommendation Engine
Clarified, not duplicated: a rule-based recommendation engine already exists in V1 via FR-GROW-001. "Future Recommendation Engine" here is scoped to what's genuinely not yet covered — ML-model-driven recommendations, and cross-workspace/cross-brand recommendation sharing (excluded from V1 by Blueprint's marketplace exclusion).

---

## Consistency Review

Reuses Database Design's entity catalog exclusively — no new tables. §16 explicitly distinguishes itself from Observability §13 to avoid apparent duplication of the same underlying `publishing_history` data. §25 explicitly distinguishes itself from the already-approved FR-GROW-001 to avoid appearing to duplicate existing scope. Two open items flagged (Time Saved baseline, §6; Team Productivity visibility default, §22) rather than silently resolved.

**Version:** 1.0
**Status:** FINAL
**Phase:** Phase-0
**Approved:** YES
**Document State:** FROZEN
