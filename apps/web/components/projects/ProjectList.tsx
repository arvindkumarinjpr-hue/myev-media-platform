"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { projectsApi } from "../../lib/api/projects";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import type { KnowledgePackSummary, ProjectSummary } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { StatusBadge } from "../ui/StatusBadge";
import { ProjectIcon } from "../ui/icons";
import styles from "./ProjectList.module.css";

export function ProjectList({ workspaceId }: { workspaceId: string }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  // The Project's own knowledgePackPublicId is the only authoritative
  // value — this map exists purely to render it as a name instead of a
  // raw id, reusing the already-loaded Knowledge Pack list rather than
  // adding a new backend read model or inventing any "latest active"
  // resolution.
  const [packsById, setPacksById] = useState<Map<string, KnowledgePackSummary>>(new Map());
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setProjects(null);
    Promise.all([projectsApi.list(workspaceId), knowledgePacksApi.list(workspaceId)])
      .then(([loadedProjects, packs]) => {
        setProjects(loadedProjects);
        setPacksById(new Map(packs.map((p) => [p.publicId, p])));
      })
      .catch((err) => setError(friendlyMessage(err)));
  }

  useEffect(load, [workspaceId]);

  const columns: Column<ProjectSummary>[] = [
    {
      key: "name",
      header: "Name",
      render: (p) => <Link href={`/workspaces/${workspaceId}/projects/${p.publicId}`}>{p.name}</Link>,
    },
    {
      key: "kp",
      header: "Assigned Knowledge Pack",
      render: (p) => {
        if (!p.knowledgePackPublicId) return <Badge tone="neutral">Unassigned</Badge>;
        const pack = packsById.get(p.knowledgePackPublicId);
        if (!pack) return <span>{p.knowledgePackPublicId}</span>;
        return (
          <span className={styles.packCell}>
            {pack.name} (v{pack.versionNumber}) <StatusBadge status={pack.status} />
          </span>
        );
      },
    },
    {
      key: "open",
      header: "",
      align: "end",
      render: (p) => <Link href={`/workspaces/${workspaceId}/projects/${p.publicId}`}>Manage</Link>,
    },
  ];

  return (
    <div>
      <PageHeader title="Projects" description="Every content Project in this workspace and the Knowledge Pack it publishes with." />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && projects === null && <LoadingState label="Loading Projects…" />}
      {!error && projects !== null && projects.length === 0 && (
        <EmptyState icon={<ProjectIcon />} title="No Projects yet" description="Projects will appear here once your workspace has one." />
      )}
      {!error && projects !== null && projects.length > 0 && (
        <DataTable columns={columns} rows={projects} rowKey={(p) => p.publicId} caption="Projects" />
      )}
    </div>
  );
}
