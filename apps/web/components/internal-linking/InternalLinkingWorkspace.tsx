"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { internalLinksApi } from "../../lib/api/internal-links";
import { friendlyMessage } from "../../lib/errors";
import type { ClusterLinkHealth, OrphanBlog, WorkspaceLinkHealthSummary } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { DataTable, type Column } from "../ui/DataTable";
import { EmptyState, ErrorBanner, LoadingState } from "../ui/Feedback";
import { Meter } from "../ui/Meter";
import { PageHeader } from "../ui/PageHeader";
import { Tabs, tabPanelProps, type TabItem } from "../ui/Tabs";
import { LinkGraphIcon } from "../ui/icons";
import styles from "./InternalLinkingWorkspace.module.css";

type TabId = "overview" | "orphans" | "cluster-health";
const TABS: TabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "orphans", label: "Orphans" },
  { id: "cluster-health", label: "Cluster Health" },
];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function InternalLinkingWorkspace({ workspaceId }: { workspaceId: string }) {
  const [tab, setTab] = useState<TabId>("overview");

  const [summary, setSummary] = useState<WorkspaceLinkHealthSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<OrphanBlog[] | null>(null);
  const [orphansError, setOrphansError] = useState<string | null>(null);
  const [clusters, setClusters] = useState<ClusterLinkHealth[] | null>(null);
  const [clustersError, setClustersError] = useState<string | null>(null);

  function retrySummary() {
    setSummaryError(null);
    setSummary(null);
    internalLinksApi.summary(workspaceId).then(setSummary).catch((err) => setSummaryError(friendlyMessage(err)));
  }
  function retryOrphans() {
    setOrphansError(null);
    setOrphans(null);
    internalLinksApi.orphans(workspaceId).then(setOrphans).catch((err) => setOrphansError(friendlyMessage(err)));
  }
  function retryClusters() {
    setClustersError(null);
    setClusters(null);
    internalLinksApi.clusterHealth(workspaceId).then(setClusters).catch((err) => setClustersError(friendlyMessage(err)));
  }

  useEffect(() => {
    internalLinksApi.summary(workspaceId).then(setSummary).catch((err) => setSummaryError(friendlyMessage(err)));
    internalLinksApi.orphans(workspaceId).then(setOrphans).catch((err) => setOrphansError(friendlyMessage(err)));
    internalLinksApi.clusterHealth(workspaceId).then(setClusters).catch((err) => setClustersError(friendlyMessage(err)));
  }, [workspaceId]);

  const idBase = "internal-linking-tabs";

  return (
    <div className={styles.page}>
      <PageHeader title="Internal Linking" description="Workspace-level link-health intelligence: orphaned Blogs, topic-cluster coverage, and recommendation lifecycle counts." />

      <Tabs tabs={TABS} active={tab} onChange={(id) => setTab(id as TabId)} label="Internal Linking sections" idBase={idBase} />

      <div {...tabPanelProps(idBase, "overview", tab)}>
        {tab === "overview" && <OverviewPanel summary={summary} error={summaryError} onRetry={retrySummary} />}
      </div>
      <div {...tabPanelProps(idBase, "orphans", tab)}>
        {tab === "orphans" && <OrphansPanel workspaceId={workspaceId} orphans={orphans} error={orphansError} onRetry={retryOrphans} />}
      </div>
      <div {...tabPanelProps(idBase, "cluster-health", tab)}>
        {tab === "cluster-health" && <ClusterHealthPanel clusters={clusters} error={clustersError} onRetry={retryClusters} />}
      </div>
    </div>
  );
}

const SUMMARY_STATS: { key: keyof WorkspaceLinkHealthSummary; label: string }[] = [
  { key: "eligibleApprovedBlogs", label: "Eligible approved Blogs" },
  { key: "orphanBlogs", label: "Orphan Blogs" },
  { key: "blogsWithNoOutgoingAcceptedLinks", label: "Blogs with no outgoing accepted links" },
  { key: "acceptedLinks", label: "Accepted links" },
  { key: "generatedRecommendations", label: "Needs review" },
  { key: "staleRecommendations", label: "Stale recommendations" },
  { key: "rejectedRecommendations", label: "Rejected recommendations" },
  { key: "clustersEvaluated", label: "Clusters evaluated" },
  { key: "clustersWithOrphans", label: "Clusters with orphans" },
];

function OverviewPanel({ summary, error, onRetry }: { summary: WorkspaceLinkHealthSummary | null; error: string | null; onRetry: () => void }) {
  if (error && !summary) return <ErrorBanner message={error} onRetry={onRetry} />;
  if (!summary) return <LoadingState label="Loading link-health summary…" />;
  return (
    <div className={styles.statGrid}>
      {SUMMARY_STATS.map((s) => (
        <Card key={s.key} className={styles.statCard}>
          <span className={styles.statValue}>{summary[s.key]}</span>
          <span className={styles.statLabel}>{s.label}</span>
        </Card>
      ))}
    </div>
  );
}

function OrphansPanel({ workspaceId, orphans, error, onRetry }: { workspaceId: string; orphans: OrphanBlog[] | null; error: string | null; onRetry: () => void }) {
  if (error && !orphans) return <ErrorBanner message={error} onRetry={onRetry} />;
  if (!orphans) return <LoadingState label="Loading orphan Blogs…" />;
  if (orphans.length === 0) {
    return <EmptyState icon={<LinkGraphIcon />} title="No orphan Blogs detected." description="Every approved Blog has at least one accepted incoming internal link." />;
  }

  const columns: Column<OrphanBlog>[] = [
    { key: "title", header: "Blog", render: (o) => <Link href={`/workspaces/${workspaceId}/blog/${o.contentItemPublicId}`}>{o.title}</Link> },
    { key: "cluster", header: "Cluster", render: (o) => o.topicClusterPublicId ?? "—" },
    { key: "incoming", header: "Incoming accepted", align: "end", render: (o) => o.incomingAcceptedLinkCount },
    { key: "outgoing", header: "Outgoing accepted", align: "end", render: (o) => o.outgoingAcceptedLinkCount },
    { key: "score", header: "Content score", align: "end", render: (o) => o.latestContentScore ?? "—" },
    { key: "updated", header: "Updated", render: (o) => fmtDate(o.updatedAt) },
    { key: "reason", header: "Reason", render: () => <Badge tone="warning">No accepted incoming links</Badge> },
  ];

  return <DataTable columns={columns} rows={orphans} rowKey={(o) => o.contentItemPublicId} caption="Orphan Blogs" />;
}

function ClusterHealthPanel({ clusters, error, onRetry }: { clusters: ClusterLinkHealth[] | null; error: string | null; onRetry: () => void }) {
  if (error && !clusters) return <ErrorBanner message={error} onRetry={onRetry} />;
  if (!clusters) return <LoadingState label="Loading cluster health…" />;
  if (clusters.length === 0) {
    return <EmptyState icon={<LinkGraphIcon />} title="No eligible topic clusters found." />;
  }

  const columns: Column<ClusterLinkHealth>[] = [
    { key: "name", header: "Cluster", render: (c) => c.name },
    { key: "approved", header: "Approved Blogs", align: "end", render: (c) => c.approvedBlogCount },
    { key: "orphan", header: "Orphans", align: "end", render: (c) => c.orphanBlogCount },
    { key: "zeroOut", header: "Zero outgoing", align: "end", render: (c) => c.blogsWithZeroOutgoingAcceptedLinksCount },
    { key: "intra", header: "Intra-cluster accepted", align: "end", render: (c) => c.intraClusterAcceptedLinkCount },
    { key: "cross", header: "Cross-cluster accepted", align: "end", render: (c) => c.crossClusterAcceptedLinkCount },
    {
      key: "coverage",
      header: "Link coverage",
      render: (c) => (c.linkCoveragePercentage === null ? "—" : <Meter value={c.linkCoveragePercentage} label={`${c.name} link coverage`} />),
    },
  ];

  return <DataTable columns={columns} rows={clusters} rowKey={(c) => c.topicClusterPublicId} caption="Topic cluster link health" />;
}
