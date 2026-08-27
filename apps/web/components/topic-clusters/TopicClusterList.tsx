"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { topicClustersApi } from "../../lib/api/topic-clusters";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { TopicCluster } from "../../lib/types";
import { Button } from "../ui/Button";
import { DataTable, type Column } from "../ui/DataTable";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { TopicClusterIcon, PlusIcon } from "../ui/icons";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

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
  const newHref = `/workspaces/${workspaceId}/topic-clusters/new`;

  const columns: Column<TopicCluster>[] = [
    {
      key: "name",
      header: "Cluster",
      render: (c) => <Link href={`/workspaces/${workspaceId}/topic-clusters/${c.publicId}`}>{c.name}</Link>,
    },
    {
      key: "research",
      header: "Source Research",
      render: (c) => <Link href={`/workspaces/${workspaceId}/research/${c.sourceResearchId}`}>Research run</Link>,
    },
    {
      key: "keywords",
      header: "Keywords",
      render: (c) => c.primaryKeywords.length + c.secondaryKeywords.length,
    },
    { key: "series", header: "Content Series", render: (c) => c.contentSeries?.name ?? "—" },
    { key: "created", header: "Created", render: (c) => formatDate(c.createdAt) },
    {
      key: "open",
      header: "",
      align: "end",
      render: (c) => <Link href={`/workspaces/${workspaceId}/topic-clusters/${c.publicId}`}>Open</Link>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Topic Clusters"
        description="Turn Research keyword opportunities into reusable planning clusters."
        actions={
          canManage ? (
            <Button href={newHref} iconLeft={<PlusIcon />}>
              Create Topic Cluster
            </Button>
          ) : undefined
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && items === null && <LoadingState label="Loading topic clusters…" />}
      {!error && items !== null && items.length === 0 && (
        <EmptyState
          icon={<TopicClusterIcon />}
          title="No topic clusters yet"
          description="Promote a keyword cluster from a completed Research run into a plannable Topic Cluster."
          action={
            canManage ? (
              <Button href={newHref} iconLeft={<PlusIcon />}>
                Create the first one
              </Button>
            ) : undefined
          }
        />
      )}
      {!error && items !== null && items.length > 0 && (
        <DataTable columns={columns} rows={items} rowKey={(c) => c.publicId} caption="Topic clusters" />
      )}
    </div>
  );
}
