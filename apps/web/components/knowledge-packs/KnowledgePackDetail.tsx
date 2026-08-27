"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackDetail as KnowledgePackDetailType } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { LoadingState } from "../ui/Feedback";
import { KnowledgePackHeader } from "./KnowledgePackHeader";
import { KnowledgePackEditor } from "./KnowledgePackEditor";
import { ValidationPanel } from "./ValidationPanel";
import { ArchiveControl } from "./ArchiveControl";
import { DeleteControl } from "./DeleteControl";
import { DangerZone } from "./DangerZone";
import styles from "./KnowledgePackDetail.module.css";

export function KnowledgePackDetail({ workspaceId, knowledgePackId }: { workspaceId: string; knowledgePackId: string }) {
  const router = useRouter();
  const { permissions } = useSession();
  const [pack, setPack] = useState<KnowledgePackDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setPack(null);
    knowledgePacksApi
      .get(workspaceId, knowledgePackId)
      .then(setPack)
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, knowledgePackId]);

  useEffect(load, [load]);

  if (error)
    return (
      <Alert tone="danger" action={<Button size="sm" variant="secondary" onClick={load}>Retry</Button>}>
        {error}
      </Alert>
    );
  if (!pack) return <LoadingState label="Loading Knowledge Pack…" />;

  const isDraft = pack.status === "DRAFT";
  const isActive = pack.status === "ACTIVE";
  const canUpdate = hasPermission(permissions, "KP_UPDATE");
  const canDelete = hasPermission(permissions, "KP_DELETE");
  const canArchive = hasPermission(permissions, "KP_ARCHIVE");
  const canValidate = hasPermission(permissions, "KP_VALIDATE");

  async function createVersion() {
    if (creatingVersion) return;
    setCreatingVersion(true);
    setVersionError(null);
    try {
      const draft = await knowledgePacksApi.createVersion(workspaceId, knowledgePackId);
      router.push(`/workspaces/${workspaceId}/knowledge-packs/${draft.publicId}`);
    } catch (err) {
      setVersionError(friendlyMessage(err));
      setCreatingVersion(false);
    }
  }

  const headerActions =
    isActive && canUpdate ? (
      <Button variant="secondary" onClick={createVersion} loading={creatingVersion}>
        Create new version
      </Button>
    ) : null;

  return (
    <div className={styles.page}>
      <KnowledgePackHeader
        workspaceId={workspaceId}
        name={pack.name}
        status={pack.status}
        versionNumber={pack.versionNumber}
        actions={headerActions}
      />

      {versionError && <Alert tone="danger">{versionError}</Alert>}

      {isDraft && canValidate && (
        <div className={styles.validate}>
          <ValidationPanel workspaceId={workspaceId} knowledgePackId={knowledgePackId} onActivated={setPack} />
        </div>
      )}

      <KnowledgePackEditor
        workspaceId={workspaceId}
        pack={pack}
        status={pack.status}
        editable={isDraft && canUpdate}
        onSaved={setPack}
      />

      {((isActive && canArchive) || (isDraft && canDelete)) && (
        <DangerZone>
          {isActive && canArchive && (
            <ArchiveControl workspaceId={workspaceId} knowledgePackId={knowledgePackId} onArchived={setPack} />
          )}
          {isDraft && canDelete && (
            <DeleteControl
              workspaceId={workspaceId}
              knowledgePackId={knowledgePackId}
              onDeleted={() => router.push(`/workspaces/${workspaceId}/knowledge-packs`)}
            />
          )}
        </DangerZone>
      )}
    </div>
  );
}
