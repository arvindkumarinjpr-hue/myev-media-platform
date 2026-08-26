"use client";

import { useEffect, useRef, useState } from "react";
import { researchApi } from "../../lib/api/research";
import { friendlyMessage } from "../../lib/errors";
import type { Research } from "../../lib/types";
import { ErrorBanner, LoadingState } from "../ui/Feedback";
import { ResearchStatusBadge } from "./ResearchStatusBadge";
import styles from "./ResearchDetail.module.css";

const POLL_INTERVAL_MS = 1_500;

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

      {research.status === "COMPLETED" && research.result && (
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
                    <p>{finding.summary}</p>
                    {finding.evidence && <p className={styles.evidence}>{finding.evidence}</p>}
                    {finding.sourceUrls.length > 0 && (
                      <p className={styles.citations}>
                        {finding.sourceUrls.map((url) => (
                          <a key={url} href={url} target="_blank" rel="noreferrer" className={styles.citationLink}>
                            {url}
                          </a>
                        ))}
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
                    <p className={styles.evidence}>{signal.evidence}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {research.result.keywordOpportunities.length > 0 && (
            <section className={styles.section}>
              <h2>Keyword Opportunities</h2>
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
                  {research.result.keywordOpportunities.map((kw, i) => (
                    <tr key={i}>
                      <td>{kw.keyword}</td>
                      <td>{kw.intent}</td>
                      <td>{kw.opportunityScore}</td>
                      <td>{kw.rationale}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
      )}
    </div>
  );
}
