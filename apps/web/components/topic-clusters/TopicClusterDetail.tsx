"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { topicClustersApi } from "../../lib/api/topic-clusters";
import { friendlyMessage } from "../../lib/errors";
import type { PersistedKeyword, TopicCluster } from "../../lib/types";
import { ErrorBanner, LoadingState } from "../ui/Feedback";
import styles from "./TopicClusterDetail.module.css";

function KeywordTable({ keywords }: { keywords: PersistedKeyword[] }) {
  return (
    <table className={styles.keywordTable}>
      <thead>
        <tr>
          <th>Term</th>
          <th>Intent</th>
          <th>Opportunity</th>
          <th>Rationale</th>
        </tr>
      </thead>
      <tbody>
        {keywords.map((kw, i) => (
          <tr key={i}>
            <td>{kw.term}</td>
            <td>{kw.searchIntent}</td>
            <td>{kw.opportunityScore}</td>
            <td>{kw.rationale}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TopicClusterDetail({ workspaceId, topicClusterId }: { workspaceId: string; topicClusterId: string }) {
  const [cluster, setCluster] = useState<TopicCluster | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    topicClustersApi
      .get(workspaceId, topicClusterId)
      .then(setCluster)
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, topicClusterId]);

  if (error) return <ErrorBanner message={error} />;
  if (!cluster) return <LoadingState label="Loading topic cluster…" />;

  return (
    <div>
      <div className={styles.header}>
        <h1>{cluster.name}</h1>
      </div>

      <section className={styles.section}>
        <h2>Provenance</h2>
        <p className={styles.provenance}>
          Derived from{" "}
          <Link href={`/workspaces/${workspaceId}/research/${cluster.sourceResearchId}`}>this Research run</Link>
          {cluster.contentSeries && (
            <>
              {" "}
              — part of the <strong>{cluster.contentSeries.name}</strong> series
            </>
          )}
          .
        </p>
      </section>

      {cluster.primaryKeywords.length > 0 && (
        <section className={styles.section}>
          <h2>Primary Keywords</h2>
          <KeywordTable keywords={cluster.primaryKeywords} />
        </section>
      )}

      {cluster.secondaryKeywords.length > 0 && (
        <section className={styles.section}>
          <h2>Secondary Keywords</h2>
          <KeywordTable keywords={cluster.secondaryKeywords} />
        </section>
      )}
    </div>
  );
}
