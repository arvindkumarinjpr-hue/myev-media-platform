"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { topicClustersApi } from "../../lib/api/topic-clusters";
import { friendlyMessage } from "../../lib/errors";
import type { TopicCluster } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Card } from "../ui/Card";
import { DescriptionList } from "../ui/DescriptionList";
import { LoadingState } from "../ui/Feedback";
import { ChevronRightIcon } from "../ui/icons";
import { KeywordClusterView } from "../shared/KeywordClusterView";
import { fromPersistedKeyword } from "../shared/keywords";
import styles from "./TopicClusterDetail.module.css";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!cluster) return <LoadingState label="Loading topic cluster…" />;

  const totalKeywords = cluster.primaryKeywords.length + cluster.secondaryKeywords.length;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href={`/workspaces/${workspaceId}/topic-clusters`}>Topic Clusters</Link>
          <ChevronRightIcon className={styles.sep} />
          <span aria-current="page">{cluster.name}</span>
        </nav>
        <h1 className={styles.title}>{cluster.name}</h1>
        <DescriptionList
          layout="row"
          items={[
            { term: "Created", value: formatDate(cluster.createdAt) },
            { term: "Keywords", value: totalKeywords },
            ...(cluster.contentSeries ? [{ term: "Content Series", value: cluster.contentSeries.name }] : []),
          ]}
        />
      </header>

      <Card>
        <h2 className={styles.sectionTitle}>Where this came from</h2>
        <p className={styles.provenance}>
          Promoted from the &ldquo;{cluster.clusterTopic}&rdquo; keyword cluster in{" "}
          <Link href={`/workspaces/${workspaceId}/research/${cluster.sourceResearchId}`}>this Research run</Link>.
        </p>
      </Card>

      <Card>
        <h2 className={styles.sectionTitle}>Keyword intelligence</h2>
        {totalKeywords === 0 ? (
          <p className={styles.muted}>This cluster has no keywords.</p>
        ) : (
          <KeywordClusterView
            showTitle={false}
            clusters={[
              {
                title: cluster.clusterTopic,
                primary: cluster.primaryKeywords.map(fromPersistedKeyword),
                secondary: cluster.secondaryKeywords.map(fromPersistedKeyword),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
