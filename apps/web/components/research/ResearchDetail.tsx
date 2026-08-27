"use client";

import { useEffect, useRef, useState } from "react";
import { researchApi } from "../../lib/api/research";
import { friendlyMessage } from "../../lib/errors";
import type { KeywordClusterMember, Research } from "../../lib/types";
import { ErrorBanner, LoadingState } from "../ui/Feedback";
import { ResearchStatusBadge } from "./ResearchStatusBadge";
import styles from "./ResearchDetail.module.css";

const POLL_INTERVAL_MS = 1_500;

function KeywordTable({ keywords }: { keywords: KeywordClusterMember[] }) {
  return (
    <table className={styles.keywordTable}>
      <thead>
        <tr>
          <th>Keyword</th>
          <th>Intent</th>
          <th>Opportunity</th>
          <th>Rationale</th>
        </tr>
      </thead>
      <tbody>
        {keywords.map((kw, i) => (
          <tr key={i}>
            <td>{kw.keyword}</td>
            <td>{kw.intent}</td>
            <td>{kw.opportunityScore}</td>
            <td>{kw.rationale}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResearchDetail({ workspaceId, researchId }: { workspaceId: string; researchId: string }) {
  const [research, setResearch] = useState<Research | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const r = await researchApi.get(workspaceId, researchId);
        if (cancelled) return;
        setResearch(r);
        setError(null);
        // QUEUED/RUNNING — durable, async work: the user never has to keep
        // this tab open for it, but while they're here, poll for the
        // terminal state rather than making them manually refresh.
        if (r.status === "QUEUED" || r.status === "RUNNING") {
          timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(friendlyMessage(err));
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [workspaceId, researchId]);

  if (error) return <ErrorBanner message={error} />;
  if (!research) return <LoadingState label="Loading research…" />;

  return (
    <div>
      <div className={styles.header}>
        <h1>{research.topic ?? "Research"}</h1>
        <ResearchStatusBadge status={research.status} />
      </div>

      {(research.status === "QUEUED" || research.status === "RUNNING") && <p className={styles.pending}>Research is in progress — this page will update automatically once it completes.</p>}

      {(research.status === "FAILED" || research.status === "TIMED_OUT") && (
        <ErrorBanner message={research.errorMessageSafe ?? "Research did not complete successfully."} />
      )}

      {research.status === "COMPLETED" && research.result && (() => {
        // Module 4 Phase 4.3 — findings only ever carry source IDs
        // (RESEARCH_AGENT_V1's own structural citation enforcement);
        // resolve each ID back to its real url via the backend-computed
        // sources[] list for display.
        const sourceById = new Map(research.result.sources.map((s) => [s.sourceId, s]));
        return (
        <div className={styles.sections}>
          <section className={styles.section}>
            <h2>Summary</h2>
            <p>{research.result.executiveSummary}</p>
          </section>

          {research.result.findings.length > 0 && (
            <section className={styles.section}>
              <h2>Key Findings</h2>
              <ul className={styles.findingsList}>
                {research.result.findings.map((finding, i) => (
                  <li key={i}>
                    <div className={styles.findingHeader}>
                      <p>{finding.summary}</p>
                      <span className={finding.provenance === "source_backed" ? styles.provenanceSourceBacked : styles.provenanceAiInference}>
                        {finding.provenance === "source_backed" ? "Source-backed" : "AI inference"}
                      </span>
                    </div>
                    {finding.evidence && <p className={styles.evidence}>{finding.evidence}</p>}
                    {finding.sourceIds.length > 0 && (
                      <p className={styles.citations}>
                        {finding.sourceIds.map((id) => {
                          const source = sourceById.get(id);
                          return source ? (
                            <a key={id} href={source.url} target="_blank" rel="noreferrer" className={styles.citationLink}>
                              {source.url}
                            </a>
                          ) : null;
                        })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {research.result.deduplication?.requiresManualReview && (
            <p className={styles.dedupWarning} role="status">
              Automated duplicate detection could not be completed for this research — findings and sources below may include duplicates. Please review manually.
            </p>
          )}
          {research.result.deduplication && !research.result.deduplication.requiresManualReview && (research.result.deduplication.duplicateFindingsRemoved > 0 || research.result.deduplication.duplicateSourcesRemoved > 0) && (
            <p className={styles.dedupNote}>
              {research.result.deduplication.duplicateFindingsRemoved} duplicate finding(s) and {research.result.deduplication.duplicateSourcesRemoved} duplicate source(s) were automatically removed.
            </p>
          )}

          <section className={styles.section}>
            <h2>Sources &amp; Evidence</h2>
            {research.result.sources.length > 0 ? (
              <ul className={styles.sourcesList}>
                {research.result.sources.map((source) => (
                  <li key={source.url}>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {source.title ?? source.url}
                    </a>
                    <span className={styles.sourceType}>{source.sourceType}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.emptyNote}>No verified sources were reachable at research time.</p>
            )}
          </section>

          {research.result.trendSignals.length > 0 && (
            <section className={styles.section}>
              <h2>Trend Signals</h2>
              <ul className={styles.trendList}>
                {research.result.trendSignals.map((signal, i) => (
                  <li key={i}>
                    <span className={`${styles.direction} ${styles[signal.direction]}`}>{signal.direction}</span>
                    <strong>{signal.topic}</strong>
                    <span className={styles.confidence}>{signal.confidence}% confidence</span>
                    <span className={styles.confidence}>{signal.opportunityScore} opportunity</span>
                    <span className={styles.freshness}>{signal.freshness}</span>
                    <p className={styles.evidence}>{signal.evidence}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {research.result.keywordClusters.length > 0 && (
            <section className={styles.section}>
              <h2>Keyword Clusters</h2>
              {research.result.keywordClusters.map((cluster, i) => (
                <div key={i} className={styles.keywordCluster}>
                  <h3>{cluster.clusterTopic}</h3>
                  {cluster.primaryKeywords.length > 0 && (
                    <>
                      <p className={styles.keywordSetLabel}>Primary</p>
                      <KeywordTable keywords={cluster.primaryKeywords} />
                    </>
                  )}
                  {cluster.secondaryKeywords.length > 0 && (
                    <>
                      <p className={styles.keywordSetLabel}>Secondary</p>
                      <KeywordTable keywords={cluster.secondaryKeywords} />
                    </>
                  )}
                </div>
              ))}
            </section>
          )}

          {research.result.contentAngles.length > 0 && (
            <section className={styles.section}>
              <h2>Content Angles</h2>
              <ul>
                {research.result.contentAngles.map((angle, i) => (
                  <li key={i}>{angle}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        );
      })()}
    </div>
  );
}
