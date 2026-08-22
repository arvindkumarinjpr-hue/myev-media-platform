"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackSummary } from "../../lib/types";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { StatusBadge } from "../ui/StatusBadge";
import styles from "./KnowledgePackList.module.css";

export function KnowledgePackList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const [packs, setPacks] = useState<KnowledgePackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setPacks(null);
    knowledgePacksApi
      .list(workspaceId)
      .then(setPacks)
      .catch((err) => setError(friendlyMessage(err)));
  }

  useEffect(load, [workspaceId]);

  const canCreate = hasPermission(permissions, "KP_CREATE");

  return (
    <div>
      <div className={styles.header}>
        <h1>Knowledge Packs</h1>
        {canCreate && (
          <Link href={`/workspaces/${workspaceId}/knowledge-packs/new`} className={styles.createButton}>
            New Knowledge Pack
          </Link>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && packs === null && <LoadingState label="Loading Knowledge Packs…" />}
      {!error && packs !== null && packs.length === 0 && (
        <EmptyState
          title="No Knowledge Packs yet"
          description="A Knowledge Pack captures the trusted sources, prompt templates, and brand guidelines your AI content agents will use."
          action={
            canCreate ? (
              <Link href={`/workspaces/${workspaceId}/knowledge-packs/new`} className={styles.createButton}>
                Create the first one
              </Link>
            ) : undefined
          }
        />
      )}
      {!error && packs !== null && packs.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Version</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => (
              <tr key={pack.publicId}>
                <td>{pack.name}</td>
                <td>
                  <StatusBadge status={pack.status} />
                </td>
                <td>v{pack.versionNumber}</td>
                <td>
                  <Link href={`/workspaces/${workspaceId}/knowledge-packs/${pack.publicId}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
