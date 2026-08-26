"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { researchApi } from "../../lib/api/research";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { Research } from "../../lib/types";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { ResearchStatusBadge } from "./ResearchStatusBadge";
import styles from "./ResearchList.module.css";

export function ResearchList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const [items, setItems] = useState<Research[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setItems(null);
    researchApi
      .list(workspaceId)
      .then(setItems)
      .catch((err) => setError(friendlyMessage(err)));
  }

  useEffect(load, [workspaceId]);

  const canRun = hasPermission(permissions, "RESEARCH_RUN");

  return (
    <div>
      <div className={styles.header}>
        <h1>Research</h1>
        {canRun && (
          <Link href={`/workspaces/${workspaceId}/research/new`} className={styles.createButton}>
            New Research
          </Link>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && items === null && <LoadingState label="Loading research…" />}
      {!error && items !== null && items.length === 0 && (
        <EmptyState
          title="No research yet"
          description="Start a research run to gather findings, evidence, trend signals, and keyword opportunities for a topic — grounded in your Knowledge Pack's own trusted sources."
          action={
            canRun ? (
              <Link href={`/workspaces/${workspaceId}/research/new`} className={styles.createButton}>
                Start the first one
              </Link>
            ) : undefined
          }
        />
      )}
      {!error && items !== null && items.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Topic</th>
              <th>Status</th>
              <th>Started</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.publicId}>
                <td>{item.topic ?? "—"}</td>
                <td>
                  <ResearchStatusBadge status={item.status} />
                </td>
                <td>{new Date(item.createdAt).toLocaleString()}</td>
                <td>
                  <Link href={`/workspaces/${workspaceId}/research/${item.publicId}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
