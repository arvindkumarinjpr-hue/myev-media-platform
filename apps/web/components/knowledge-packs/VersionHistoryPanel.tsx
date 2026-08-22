"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackStatus, KnowledgePackVersion } from "../../lib/types";
import { LoadingState, ErrorBanner } from "../ui/Feedback";
import { StatusBadge } from "../ui/StatusBadge";
import styles from "./VersionHistoryPanel.module.css";

export function VersionHistoryPanel({ workspaceId, knowledgePackId, currentStatus }: { workspaceId: string; knowledgePackId: string; currentStatus: KnowledgePackStatus }) {
  const router = useRouter();
  const { permissions } = useSession();
  const [versions, setVersions] = useState<KnowledgePackVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    knowledgePacksApi
      .listVersions(workspaceId, knowledgePackId)
      .then(setVersions)
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, knowledgePackId]);

  useEffect(load, [load]);

  const canCreateVersion = currentStatus === "ACTIVE" && hasPermission(permissions, "KP_UPDATE");

  async function handleCreateVersion() {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const draft = await knowledgePacksApi.createVersion(workspaceId, knowledgePackId);
      router.push(`/workspaces/${workspaceId}/knowledge-packs/${draft.publicId}`);
    } catch (err) {
      setCreateError(friendlyMessage(err));
      setCreating(false);
    }
  }

  return (
    <div>
      {canCreateVersion && (
        <div className={styles.createRow}>
          <button type="button" onClick={handleCreateVersion} disabled={creating} className={styles.createButton}>
            {creating ? "Creating new version…" : "Create new Draft version"}
          </button>
          {createError && <ErrorBanner message={createError} />}
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && versions === null && <LoadingState label="Loading version history…" />}
      {!error && versions !== null && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Predecessor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.publicId}>
                <td>v{version.versionNumber}</td>
                <td>
                  <StatusBadge status={version.status} />
                </td>
                <td>{version.currentVersionOfPublicId ? "successor" : "root"}</td>
                <td>
                  {version.publicId === knowledgePackId ? "current" : <Link href={`/workspaces/${workspaceId}/knowledge-packs/${version.publicId}`}>Open</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
