"use client";

import { useState } from "react";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackDetail } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import styles from "./DangerZone.module.css";

export function ArchiveControl({
  workspaceId,
  knowledgePackId,
  onArchived,
}: {
  workspaceId: string;
  knowledgePackId: string;
  onArchived: (pack: KnowledgePackDetail) => void;
}) {
  const { permissions } = useSession();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasPermission(permissions, "KP_ARCHIVE")) return null;

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      const pack = await knowledgePacksApi.archive(workspaceId, knowledgePackId);
      onArchived(pack);
      setOpen(false);
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.action}>
      <div className={styles.actionText}>
        <p className={styles.actionTitle}>Archive this version</p>
        <p className={styles.actionDesc}>Retires this Active version for good. It stays in version history but can never be reactivated.</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Archive
      </Button>
      <ConfirmDialog
        open={open}
        title="Archive this Knowledge Pack version?"
        description="This can't be undone. If any Project still uses this exact version, archiving is blocked until it's reassigned."
        confirmLabel="Archive"
        destructive
        pending={pending}
        onConfirm={handleConfirm}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
