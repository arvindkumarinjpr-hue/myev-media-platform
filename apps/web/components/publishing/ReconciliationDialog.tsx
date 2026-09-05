"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { Textarea } from "../ui/Textarea";
import styles from "./ReconciliationDialog.module.css";

interface Props {
  open: boolean;
  mode: "mark-published" | "confirm-not-published";
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmitMarkPublished: (input: { externalContentId: string; externalUrl?: string; note: string }) => void;
  onSubmitConfirmNotPublished: (input: { note: string }) => void;
}

/**
 * Module 9 Phase 9.7 (Part V/X/AE) — the manual reconciliation action
 * UI. Native <dialog> (mirrors ConfirmDialog's own precedent exactly —
 * Escape-to-close and focus handling come for free, no bespoke a11y
 * plumbing). Requires the operator to type a note either way (the
 * server itself validates this is non-empty) — an audit trail of HOW
 * the operator verified externally, not just THAT they clicked a
 * button.
 */
export function ReconciliationDialog({ open, mode, pending, error, onCancel, onSubmitMarkPublished, onSubmitConfirmNotPublished }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [externalContentId, setExternalContentId] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (open) {
      setExternalContentId("");
      setExternalUrl("");
      setNote("");
    }
  }, [open]);

  const canSubmit = mode === "mark-published" ? !!(externalContentId.trim() && note.trim()) : !!note.trim();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || pending) return;
    if (mode === "mark-published") {
      onSubmitMarkPublished({ externalContentId: externalContentId.trim(), externalUrl: externalUrl.trim() || undefined, note: note.trim() });
    } else {
      onSubmitConfirmNotPublished({ note: note.trim() });
    }
  }

  return (
    <dialog ref={ref} className={styles.dialog} onCancel={onCancel} aria-labelledby="reconciliation-title">
      <h2 id="reconciliation-title" className={styles.title}>
        {mode === "mark-published" ? "Mark as externally published" : "Confirm this was NOT published"}
      </h2>
      <p className={styles.description}>
        {mode === "mark-published"
          ? "Use this only after verifying directly on the provider's own site/app that the content was actually published. This records the real external id and transitions this target to Published — it never calls the provider again."
          : "Use this only after verifying directly on the provider's own site/app that the content was NOT published. This clears the block on ordinary retry — it does not retry automatically."}
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      <form onSubmit={handleSubmit} className={styles.form}>
        {mode === "mark-published" && (
          <>
            <FormField label="External content ID" hint="The real id the provider assigned, exactly as shown on the provider's own site/app.">
              {(field) => <Input {...field} required autoFocus value={externalContentId} onChange={(e) => setExternalContentId(e.target.value)} />}
            </FormField>
            <FormField label="External URL" optional hint="Only if the provider exposes a real, stable link.">
              {(field) => <Input {...field} type="url" value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} />}
            </FormField>
          </>
        )}
        <FormField label="Note" hint="How did you verify this? (required, kept in the audit history)">
          {(field) => <Textarea {...field} required rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
        </FormField>
        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending} disabled={!canSubmit}>
            {mode === "mark-published" ? "Mark as Published" : "Confirm Not Published"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
