"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackDetail as KnowledgePackDetailType } from "../../lib/types";
import { LoadingState, ErrorBanner } from "../ui/Feedback";
import { StatusBadge } from "../ui/StatusBadge";
import { ConfigurationEditor } from "./ConfigurationEditor";
import { ValidationPanel } from "./ValidationPanel";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { ArchiveControl } from "./ArchiveControl";
import { DeleteControl } from "./DeleteControl";
import styles from "./KnowledgePackDetail.module.css";

type Tab = "overview" | "history";

export function KnowledgePackDetail({ workspaceId, knowledgePackId }: { workspaceId: string; knowledgePackId: string }) {
  const router = useRouter();
  const { permissions } = useSession();
  const [pack, setPack] = useState<KnowledgePackDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const load = useCallback(() => {
    setError(null);
    setPack(null);
    knowledgePacksApi
      .get(workspaceId, knowledgePackId)
      .then(setPack)
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, knowledgePackId]);

  useEffect(load, [load]);

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!pack) return <LoadingState label="Loading Knowledge Pack…" />;

  const isDraft = pack.status === "DRAFT";
  const canUpdate = hasPermission(permissions, "KP_UPDATE");
  const canDelete = hasPermission(permissions, "KP_DELETE");

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={styles.name}>{pack.name}</h1>
          <div className={styles.meta}>
            <StatusBadge status={pack.status} />
            <span>Version {pack.versionNumber}</span>
          </div>
        </div>
        {isDraft && canDelete && (
          <DeleteControl
            workspaceId={workspaceId}
            knowledgePackId={knowledgePackId}
            onDeleted={() => router.push(`/workspaces/${workspaceId}/knowledge-packs`)}
          />
        )}
      </div>

      <div className={styles.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? styles.tabActive : styles.tab} onClick={() => setTab("overview")}>
          Configuration
        </button>
        <button type="button" role="tab" aria-selected={tab === "history"} className={tab === "history" ? styles.tabActive : styles.tab} onClick={() => setTab("history")}>
          Versions
        </button>
      </div>

      {tab === "overview" && (
        <div>
          <ConfigurationEditor workspaceId={workspaceId} pack={pack} editable={isDraft && canUpdate} onSaved={setPack} />
          {isDraft && <ValidationPanel workspaceId={workspaceId} knowledgePackId={knowledgePackId} onActivated={setPack} />}
          {pack.status === "ACTIVE" && <ArchiveControl workspaceId={workspaceId} knowledgePackId={knowledgePackId} onArchived={setPack} />}
        </div>
      )}

      {tab === "history" && <VersionHistoryPanel workspaceId={workspaceId} knowledgePackId={knowledgePackId} currentStatus={pack.status} />}
    </div>
  );
}
