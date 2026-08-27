"use client";

import { useEffect, useState } from "react";
import { cx } from "../../lib/cx";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { researchApi } from "../../lib/api/research";
import { topicClustersApi } from "../../lib/api/topic-clusters";
import { projectsApi } from "../../lib/api/projects";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import { PageHeader } from "../ui/PageHeader";
import { Button } from "../ui/Button";
import { ErrorBanner } from "../ui/Feedback";
import { KnowledgePackIcon, ProjectIcon, ResearchIcon, TopicClusterIcon } from "../ui/icons";
import styles from "./WorkspaceOverview.module.css";

interface Metrics {
  knowledgePacks?: { total: number; active: number };
  research?: { total: number; completed: number };
  topicClusters?: { total: number };
  projects?: { total: number; unassigned: number };
}

export function WorkspaceOverview({ workspaceId }: { workspaceId: string }) {
  const { workspace, permissions } = useSession();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canViewKp = hasPermission(permissions, "KP_VIEW");
  const canViewResearch = hasPermission(permissions, "RESEARCH_VIEW");
  const canViewProjects = hasPermission(permissions, "PROJECT_VIEW");
  const canRunResearch = hasPermission(permissions, "RESEARCH_RUN");
  const canCreateKp = hasPermission(permissions, "KP_CREATE");
  const canManageClusters = hasPermission(permissions, "TOPIC_CLUSTER_MANAGE");

  useEffect(() => {
    let cancelled = false;

    // Each read is independent — a 403 on one resource must not blank the
    // whole page, so a rejected fetch just leaves that card's metric
    // undefined ("—").
    const safe = <T,>(p: Promise<T>) => p.then((v) => v).catch(() => undefined);

    Promise.all([
      canViewKp ? safe(knowledgePacksApi.list(workspaceId)) : Promise.resolve(undefined),
      canViewResearch ? safe(researchApi.list(workspaceId)) : Promise.resolve(undefined),
      safe(topicClustersApi.list(workspaceId)),
      canViewProjects ? safe(projectsApi.list(workspaceId)) : Promise.resolve(undefined),
    ])
      .then(([packs, research, clusters, projects]) => {
        if (cancelled) return;
        setMetrics({
          knowledgePacks: packs && { total: packs.length, active: packs.filter((p) => p.status === "ACTIVE").length },
          research: research && {
            total: research.length,
            completed: research.filter((r) => r.status === "COMPLETED").length,
          },
          topicClusters: clusters && { total: clusters.length },
          projects: projects && {
            total: projects.length,
            unassigned: projects.filter((p) => !p.knowledgePackPublicId).length,
          },
        });
      })
      .catch((err) => !cancelled && setError(friendlyMessage(err)));

    return () => {
      cancelled = true;
    };
  }, [workspaceId, canViewKp, canViewResearch, canViewProjects]);

  const w = `/workspaces/${workspaceId}`;
  const fmt = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());
  const loading = metrics === null && !error;

  const actions = [
    canRunResearch && { label: "New Research", href: `${w}/research/new`, icon: <ResearchIcon /> },
    canCreateKp && { label: "New Knowledge Pack", href: `${w}/knowledge-packs/new`, icon: <KnowledgePackIcon /> },
    canManageClusters && { label: "New Topic Cluster", href: `${w}/topic-clusters/new`, icon: <TopicClusterIcon /> },
  ].filter(Boolean) as { label: string; href: string; icon: React.ReactNode }[];

  return (
    <div>
      <PageHeader title="Overview" description={`Everything happening in ${workspace.name}.`} />

      {error && <ErrorBanner message={error} />}

      <section aria-label="Workspace metrics" className={styles.grid}>
        <StatCard
          icon={<KnowledgePackIcon />}
          label="Knowledge Packs"
          value={fmt(metrics?.knowledgePacks?.total)}
          sub={metrics?.knowledgePacks ? `${metrics.knowledgePacks.active} active` : undefined}
          href={canViewKp ? `${w}/knowledge-packs` : undefined}
          loading={loading}
        />
        <StatCard
          icon={<ResearchIcon />}
          label="Research runs"
          value={fmt(metrics?.research?.total)}
          sub={metrics?.research ? `${metrics.research.completed} completed` : undefined}
          href={canViewResearch ? `${w}/research` : undefined}
          loading={loading}
        />
        <StatCard
          icon={<TopicClusterIcon />}
          label="Topic Clusters"
          value={fmt(metrics?.topicClusters?.total)}
          href={`${w}/topic-clusters`}
          loading={loading}
        />
        <StatCard
          icon={<ProjectIcon />}
          label="Projects"
          value={fmt(metrics?.projects?.total)}
          sub={
            metrics?.projects
              ? metrics.projects.unassigned > 0
                ? `${metrics.projects.unassigned} without a Knowledge Pack`
                : "all assigned"
              : undefined
          }
          href={canViewProjects ? `${w}/projects` : undefined}
          loading={loading}
        />
      </section>

      {actions.length > 0 && (
        <section className={styles.quickActions} aria-label="Quick actions">
          <h2 className={styles.quickTitle}>Quick actions</h2>
          <div className={styles.quickRow}>
            {actions.map((action) => (
              <Button key={action.href} href={action.href} variant="secondary" iconLeft={action.icon}>
                {action.label}
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  href,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  href?: string;
  loading: boolean;
}) {
  const body = (
    <>
      <span className={styles.statIcon}>{icon}</span>
      <span className={styles.statLabel}>{label}</span>
      {loading ? (
        <span className={styles.statSkeleton} aria-hidden="true" />
      ) : (
        <>
          <span className={styles.statValue}>{value}</span>
          {sub && <span className={styles.statSub}>{sub}</span>}
        </>
      )}
    </>
  );

  if (href) {
    return (
      <a href={href} className={cx(styles.statCard, styles.statLink)} aria-busy={loading || undefined}>
        {body}
      </a>
    );
  }
  return <div className={styles.statCard}>{body}</div>;
}
