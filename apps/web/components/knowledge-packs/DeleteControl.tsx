"use client";

import { useState } from "react";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import styles from "./DangerZone.module.css";

export function DeleteControl({
  workspaceId,
  knowledgePackId,
  onDeleted,
}: {
  workspaceId: string;
  knowledgePackId: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      await knowledgePacksApi.remove(workspaceId, knowledgePackId);
      onDeleted();
    } catch (err) {
      setError(friendlyMessage(err));
      setPending(false);
    }
  }

  return (
    <div className={styles.action}>
      <div className={styles.actionText}>
        <p className={styles.actionTitle}>Delete this Draft</p>
        <p className={styles.actionDesc}>Removes the Draft from view (a soft delete — it isn&apos;t physically erased). Only possible while it&apos;s still a Draft.</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete Draft
      </Button>
      <ConfirmDialog
        open={open}
        title="Remove this Draft?"
        description="This removes the Draft from view. It can't be edited or recovered from the UI afterwards."
        confirmLabel="Remove"
        destructive
        pending={pending}
        onConfirm={handleConfirm}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
