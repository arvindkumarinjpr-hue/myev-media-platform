"use client";

import { useState } from "react";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ErrorBanner } from "../ui/Feedback";
import styles from "./DeleteControl.module.css";

export function DeleteControl({ workspaceId, knowledgePackId, onDeleted }: { workspaceId: string; knowledgePackId: string; onDeleted: () => void }) {
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
    <div>
      {error && <ErrorBanner message={error} />}
      <button type="button" onClick={() => setOpen(true)} className={styles.deleteButton}>
        Delete Draft
      </button>
      <ConfirmDialog
        open={open}
        title="Remove this Draft?"
        description="This removes the Draft from view (a soft delete — it isn't physically erased). This can only be done while it's still a Draft."
        confirmLabel="Remove"
        destructive
        pending={pending}
        onConfirm={handleConfirm}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
