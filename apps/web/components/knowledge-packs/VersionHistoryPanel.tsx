"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackStatus, KnowledgePackVersion } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { DataTable, type Column } from "../ui/DataTable";
import { LoadingState } from "../ui/Feedback";
import { StatusBadge } from "../ui/StatusBadge";
import { PlusIcon } from "../ui/icons";
import styles from "./VersionHistoryPanel.module.css";

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function VersionHistoryPanel({
  workspaceId,
  knowledgePackId,
  currentStatus,
}: {
  workspaceId: string;
  knowledgePackId: string;
  currentStatus: KnowledgePackStatus;
}) {
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

  const columns: Column<KnowledgePackVersion>[] = [
    { key: "version", header: "Version", render: (v) => <span className={styles.version}>v{v.versionNumber}</span> },
    { key: "status", header: "Status", render: (v) => <StatusBadge status={v.status} /> },
    {
      key: "lineage",
      header: "Lineage",
      render: (v) => (v.currentVersionOfPublicId ? "Replaces an earlier version" : "First version"),
    },
    { key: "created", header: "Created", render: (v) => formatDate(v.createdAt) },
    {
      key: "open",
      header: "",
      align: "end",
      render: (v) =>
        v.publicId === knowledgePackId ? (
          <span className={styles.current}>Viewing</span>
        ) : (
          <Link href={`/workspaces/${workspaceId}/knowledge-packs/${v.publicId}`}>Open</Link>
        ),
    },
  ];

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <p className={styles.title}>Version history</p>
          <p className={styles.subtitle}>Every version of this Knowledge Pack. Only a Draft can be edited; the rest are read-only.</p>
        </div>
        {canCreateVersion && (
          <Button variant="secondary" size="sm" iconLeft={<PlusIcon />} onClick={handleCreateVersion} loading={creating}>
            Create new Draft version
          </Button>
        )}
      </div>

      {createError && <Alert tone="danger">{createError}</Alert>}
      {error && <Alert tone="danger" action={<Button size="sm" variant="secondary" onClick={load}>Retry</Button>}>{error}</Alert>}
      {!error && versions === null && <LoadingState label="Loading version history…" />}
      {!error && versions !== null && (
        <DataTable columns={columns} rows={versions} rowKey={(v) => v.publicId} caption="Knowledge Pack versions" />
      )}
    </div>
  );
}
