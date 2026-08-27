"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { topicClustersApi } from "../../lib/api/topic-clusters";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { TopicCluster } from "../../lib/types";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import styles from "./TopicClusterList.module.css";

export function TopicClusterList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const [items, setItems] = useState<TopicCluster[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setItems(null);
    topicClustersApi
      .list(workspaceId)
      .then(setItems)
      .catch((err) => setError(friendlyMessage(err)));
  }

  useEffect(load, [workspaceId]);

  const canManage = hasPermission(permissions, "TOPIC_CLUSTER_MANAGE");

  return (
    <div>
      <div className={styles.header}>
        <h1>Topic Clusters</h1>
        {canManage && (
          <Link href={`/workspaces/${workspaceId}/topic-clusters/new`} className={styles.createButton}>
            New Topic Cluster
          </Link>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && items === null && <LoadingState label="Loading topic clusters…" />}
      {!error && items !== null && items.length === 0 && (
        <EmptyState
          title="No topic clusters yet"
          description="Promote a keyword cluster from a completed Research run into a real, plannable Topic Cluster — the starting point for content planning."
          action={
            canManage ? (
              <Link href={`/workspaces/${workspaceId}/topic-clusters/new`} className={styles.createButton}>
                Create the first one
              </Link>
            ) : undefined
          }
        />
      )}
      {!error && items !== null && items.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Keywords</th>
              <th>Content Series</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.publicId}>
                <td>{item.name}</td>
                <td>{item.primaryKeywords.length + item.secondaryKeywords.length}</td>
                <td>{item.contentSeries?.name ?? "—"}</td>
                <td>{new Date(item.createdAt).toLocaleString()}</td>
                <td>
                  <Link href={`/workspaces/${workspaceId}/topic-clusters/${item.publicId}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
