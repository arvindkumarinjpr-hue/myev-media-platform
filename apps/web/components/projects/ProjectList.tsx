"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { projectsApi } from "../../lib/api/projects";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import type { KnowledgePackSummary, ProjectSummary } from "../../lib/types";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { StatusBadge } from "../ui/StatusBadge";
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

  return (
    <div>
      <h1>Projects</h1>
      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && projects === null && <LoadingState label="Loading Projects…" />}
      {!error && projects !== null && projects.length === 0 && <EmptyState title="No Projects yet" />}
      {!error && projects !== null && projects.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Assigned Knowledge Pack</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const pack = project.knowledgePackPublicId ? packsById.get(project.knowledgePackPublicId) : undefined;
              return (
                <tr key={project.publicId}>
                  <td>{project.name}</td>
                  <td>
                    {!project.knowledgePackPublicId ? (
                      <span className={styles.unassigned}>Unassigned</span>
                    ) : pack ? (
                      <span className={styles.packCell}>
                        {pack.name} (v{pack.versionNumber}) <StatusBadge status={pack.status} />
                      </span>
                    ) : (
                      // Loaded before the Knowledge Pack list resolved, or a
                      // cross-tenant data anomaly — show the raw id rather
                      // than silently hiding that a reference exists.
                      project.knowledgePackPublicId
                    )}
                  </td>
                  <td>
                    <Link href={`/workspaces/${workspaceId}/projects/${project.publicId}`}>Manage</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
