"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { researchApi } from "../../lib/api/research";
import { topicClustersApi } from "../../lib/api/topic-clusters";
import { projectsApi } from "../../lib/api/projects";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import { Button } from "../ui/Button";
import { ErrorBanner } from "../ui/Feedback";
import { OrbitArt } from "../ui/OrbitArt";
import { KnowledgePackIcon, ProjectIcon, ResearchIcon, TopicClusterIcon, ChevronRightIcon } from "../ui/icons";
import type { KnowledgePackSummary, ProjectSummary, Research, TopicCluster } from "../../lib/types";
import styles from "./WorkspaceOverview.module.css";

interface Lists {
  packs?: KnowledgePackSummary[];
  research?: Research[];
  clusters?: TopicCluster[];
  projects?: ProjectSummary[];
}

export function WorkspaceOverview({ workspaceId }: { workspaceId: string }) {
  const { workspace, permissions } = useSession();
  const [lists, setLists] = useState<Lists | null>(null);
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
    // whole page, so a rejected fetch just leaves that resource undefined
    // ("—" on its card, and it's excluded from anything derived below).
    const safe = <T,>(p: Promise<T>) => p.then((v) => v).catch(() => undefined);

    Promise.all([
      canViewKp ? safe(knowledgePacksApi.list(workspaceId)) : Promise.resolve(undefined),
      canViewResearch ? safe(researchApi.list(workspaceId)) : Promise.resolve(undefined),
      safe(topicClustersApi.list(workspaceId)),
      canViewProjects ? safe(projectsApi.list(workspaceId)) : Promise.resolve(undefined),
    ])
      .then(([packs, research, clusters, projects]) => {
        if (cancelled) return;
        setLists({ packs, research, clusters, projects });
      })
      .catch((err) => !cancelled && setError(friendlyMessage(err)));

    return () => {
      cancelled = true;
    };
  }, [workspaceId, canViewKp, canViewResearch, canViewProjects]);

  const metrics = useMemo(() => deriveMetrics(lists), [lists]);
  const loading = lists === null && !error;

  const w = `/workspaces/${workspaceId}`;
  const actions = [
    canRunResearch && { label: "New Research", href: `${w}/research/new`, icon: <ResearchIcon /> },
    canCreateKp && { label: "New Knowledge Pack", href: `${w}/knowledge-packs/new`, icon: <KnowledgePackIcon /> },
    canManageClusters && { label: "New Topic Cluster", href: `${w}/topic-clusters/new`, icon: <TopicClusterIcon /> },
  ].filter(Boolean) as { label: string; href: string; icon: ReactNode }[];

  const recommendation = useMemo(() => recommend(metrics, w), [metrics, w]);
  const recentActivity = useMemo(() => buildActivity(lists, w), [lists, w]);
  const activeKp = lists?.packs?.find((p) => p.status === "ACTIVE");

  return (
    <div>
      {error && <ErrorBanner message={error} />}

      <Hero workspaceName={workspace.name} actions={actions} />

      <section aria-label="Workspace metrics" className={styles.grid}>
        <StatCard
          accent="blue"
          icon={<KnowledgePackIcon />}
          label="Knowledge Packs"
          value={fmt(metrics?.knowledgePacks?.total)}
          sub={metrics?.knowledgePacks ? `${metrics.knowledgePacks.active} active` : undefined}
          href={canViewKp ? `${w}/knowledge-packs` : undefined}
          loading={loading}
        />
        <StatCard
          accent="violet"
          icon={<ResearchIcon />}
          label="Research runs"
          value={fmt(metrics?.research?.total)}
          sub={metrics?.research ? `${metrics.research.completed} completed` : undefined}
          href={canViewResearch ? `${w}/research` : undefined}
          loading={loading}
        />
        <StatCard
          accent="teal"
          icon={<TopicClusterIcon />}
          label="Topic Clusters"
          value={fmt(metrics?.topicClusters?.total)}
          href={`${w}/topic-clusters`}
          loading={loading}
        />
        <StatCard
          accent="amber"
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

      {!loading && (recommendation || activeKp || recentActivity.length > 0 || metrics) && (
        <section className={styles.insightRow} aria-label="Workspace snapshot">
          <div className={cx(styles.panel, styles.recommendPanel)}>
            <h2 className={styles.panelTitle}>Next step</h2>
            {recommendation ? (
              <>
                <p className={styles.recommendText}>{recommendation.text}</p>
                {recommendation.href && (
                  <Button href={recommendation.href} variant="secondary" size="sm">
                    {recommendation.cta ?? "Go"}
                  </Button>
                )}
              </>
            ) : (
              <p className={styles.recommendText}>You&apos;re all set — nothing needs attention right now.</p>
            )}

            {activeKp && (
              <div className={styles.activeKp}>
                <span className={styles.activeKpDot} aria-hidden="true" />
                <span>
                  Active context: <a href={`${w}/knowledge-packs/${activeKp.publicId}`}>{activeKp.name}</a>
                </span>
              </div>
            )}
          </div>

          <div className={cx(styles.panel, styles.activityPanel)}>
            <h2 className={styles.panelTitle}>Recent activity</h2>
            {recentActivity.length > 0 ? (
              <ul className={styles.activityList}>
                {recentActivity.map((item) => (
                  <li key={item.key} className={styles.activityItem}>
                    <span className={cx(styles.activityDot, styles[`activityDot_${item.kind}`])} aria-hidden="true" />
                    <div className={styles.activityBody}>
                      <a href={item.href} className={styles.activityLink}>
                        {item.title}
                      </a>
                      <span className={styles.activityMeta}>{item.meta}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.emptyText}>
                Nothing to show yet — activity from Research and Topic Clusters will appear here as you work.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface Metrics {
  knowledgePacks?: { total: number; active: number };
  research?: { total: number; completed: number; running: number };
  topicClusters?: { total: number };
  projects?: { total: number; unassigned: number };
}

function deriveMetrics(lists: Lists | null): Metrics | null {
  if (!lists) return null;
  const { packs, research, clusters, projects } = lists;
  return {
    knowledgePacks: packs && { total: packs.length, active: packs.filter((p) => p.status === "ACTIVE").length },
    research: research && {
      total: research.length,
      completed: research.filter((r) => r.status === "COMPLETED").length,
      running: research.filter((r) => r.status === "QUEUED" || r.status === "RUNNING").length,
    },
    topicClusters: clusters && { total: clusters.length },
    projects: projects && {
      total: projects.length,
      unassigned: projects.filter((p) => !p.knowledgePackPublicId).length,
    },
  };
}

const fmt = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());

/**
 * Deterministic, rule-based "what should I do next" — every branch reads
 * only counts already derived from real API responses. No AI call, no
 * fabricated suggestion; a metric the user can't view (undefined) simply
 * skips its rule rather than being treated as zero.
 */
function recommend(m: Metrics | null, w: string): { text: string; href?: string; cta?: string } | null {
  if (!m) return null;
  if (m.knowledgePacks && m.knowledgePacks.total === 0) {
    return {
      text: "Create your first Knowledge Pack to give your content agents real grounding context.",
      href: `${w}/knowledge-packs/new`,
      cta: "New Knowledge Pack",
    };
  }
  if (m.knowledgePacks && m.knowledgePacks.active === 0) {
    return {
      text: "You have Draft Knowledge Packs but none are Active yet. Validate one to make it the live context.",
      href: `${w}/knowledge-packs`,
      cta: "Review Drafts",
    };
  }
  if (m.research && m.research.total === 0) {
    return {
      text: "Run your first Research to start discovering real content opportunities.",
      href: `${w}/research/new`,
      cta: "New Research",
    };
  }
  if (m.research && m.research.running > 0) {
    const n = m.research.running;
    return {
      text: `${n} Research run${n === 1 ? "" : "s"} still in progress — check back soon.`,
      href: `${w}/research`,
      cta: "View Research",
    };
  }
  if (m.topicClusters && m.topicClusters.total === 0 && m.research && m.research.completed > 0) {
    return {
      text: "You have completed Research — promote a keyword cluster into a Topic Cluster.",
      href: `${w}/topic-clusters/new`,
      cta: "New Topic Cluster",
    };
  }
  if (m.projects && m.projects.unassigned > 0) {
    const n = m.projects.unassigned;
    return {
      text: `${n} Project${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} a Knowledge Pack assignment.`,
      href: `${w}/projects`,
      cta: "Review Projects",
    };
  }
  return null;
}

interface ActivityItem {
  key: string;
  kind: "research" | "cluster";
  title: string;
  meta: string;
  href: string;
  at: number;
}

/**
 * Merges real Research + Topic Cluster records by their actual createdAt
 * timestamp. Knowledge Packs and Projects are deliberately excluded here —
 * their list endpoints don't return createdAt, so there is no real date to
 * sort by (surfaced instead via "Active context" and the KPI card's own
 * "without a Knowledge Pack" count). Anything missing a real createdAt is
 * skipped rather than shown with a fabricated or blank date.
 */
function buildActivity(lists: Lists | null, w: string): ActivityItem[] {
  if (!lists) return [];
  const items: ActivityItem[] = [];

  for (const r of lists.research ?? []) {
    if (!r.createdAt) continue;
    const at = Date.parse(r.createdAt);
    if (Number.isNaN(at)) continue;
    items.push({
      key: `r-${r.publicId}`,
      kind: "research",
      title: r.topic ?? "Untitled research",
      meta: `Research · ${statusLabel(r.status)} · ${formatDate(r.createdAt)}`,
      href: `${w}/research/${r.publicId}`,
      at,
    });
  }
  for (const c of lists.clusters ?? []) {
    if (!c.createdAt) continue;
    const at = Date.parse(c.createdAt);
    if (Number.isNaN(at)) continue;
    items.push({
      key: `c-${c.publicId}`,
      kind: "cluster",
      title: c.name || c.clusterTopic || "Untitled cluster",
      meta: `Topic Cluster · ${formatDate(c.createdAt)}`,
      href: `${w}/topic-clusters/${c.publicId}`,
      at,
    });
  }

  return items.sort((a, b) => b.at - a.at).slice(0, 6);
}

function statusLabel(status: string): string {
  switch (status) {
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Running";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "TIMED_OUT":
      return "Timed out";
    default:
      return status;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ */

function Hero({
  workspaceName,
  actions,
}: {
  workspaceName: string;
  actions: { label: string; href: string; icon: ReactNode }[];
}) {
  return (
    <section className={styles.hero} aria-label="Workspace welcome">
      <div className={styles.heroText}>
        <p className={styles.heroEyebrow}>{workspaceName}</p>
        <h1 className={styles.heroTitle}>
          Plan smarter.
          <br />
          Create faster.
          <br />
          <span className={styles.heroTitleAccent}>Grow your impact.</span>
        </h1>
        <p className={styles.heroSubtitle}>
          MYEV Media turns grounded research into planned content — one connected workflow from trusted sources, to
          keyword-backed Topic Clusters, to the Knowledge Pack that keeps every piece on-brand.
        </p>
        {actions.length > 0 && (
          <div className={styles.heroActions}>
            {actions.map((action) => (
              <Button key={action.href} href={action.href} variant="primary" iconLeft={action.icon}>
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className={styles.heroArt}>
        <OrbitArt className={styles.orbitSvg} />
      </div>
    </section>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  href,
  loading,
  accent,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  href?: string;
  loading: boolean;
  accent: "blue" | "violet" | "teal" | "amber";
}) {
  const body = (
    <>
      <span className={cx(styles.statIcon, styles[`accent_${accent}`])}>{icon}</span>
      <span className={styles.statLabel}>{label}</span>
      {loading ? (
        <span className={styles.statSkeleton} aria-hidden="true" />
      ) : (
        <>
          <span className={styles.statValue}>{value}</span>
          {sub && <span className={styles.statSub}>{sub}</span>}
        </>
      )}
      {href && !loading && <ChevronRightIcon className={styles.statArrow} />}
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
