"use client";

import { useState } from "react";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackDetail } from "../../lib/types";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ErrorBanner } from "../ui/Feedback";
import styles from "./ArchiveControl.module.css";

export function ArchiveControl({ workspaceId, knowledgePackId, onArchived }: { workspaceId: string; knowledgePackId: string; onArchived: (pack: KnowledgePackDetail) => void }) {
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
    <div className={styles.panel}>
      <h3 className={styles.heading}>Archive this version</h3>
      <p className={styles.description}>Retires this Active version permanently. It stays visible in version history, but nothing can activate it again.</p>
      {error && <ErrorBanner message={error} />}
      <button type="button" onClick={() => setOpen(true)} className={styles.archiveButton}>
        Archive
      </button>
      <ConfirmDialog
        open={open}
        title="Archive this Knowledge Pack version?"
        description="This can't be undone. If any Project still uses this exact version, archiving will be blocked until it's reassigned."
        confirmLabel="Archive"
        destructive
        pending={pending}
        onConfirm={handleConfirm}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
