"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { projectsApi } from "../../lib/api/projects";
import { friendlyMessage } from "../../lib/errors";
import type { ProjectSummary } from "../../lib/types";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import styles from "./ProjectList.module.css";

export function ProjectList({ workspaceId }: { workspaceId: string }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setProjects(null);
    projectsApi
      .list(workspaceId)
      .then(setProjects)
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
            {projects.map((project) => (
              <tr key={project.publicId}>
                <td>{project.name}</td>
                <td>{project.knowledgePackPublicId ?? <span className={styles.unassigned}>Unassigned</span>}</td>
                <td>
                  <Link href={`/workspaces/${workspaceId}/projects/${project.publicId}`}>Manage</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
