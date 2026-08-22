"use client";

import { useEffect, useRef } from "react";
import styles from "./ConfirmDialog.module.css";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Native <dialog> — Escape-to-close and focus handling come for free, no bespoke a11y plumbing needed for a control this small. */
export function ConfirmDialog({ open, title, description, confirmLabel = "Confirm", destructive, pending, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className={styles.dialog} onCancel={onCancel} aria-labelledby="confirm-dialog-title">
      <h2 id="confirm-dialog-title" className={styles.title}>
        {title}
      </h2>
      <p className={styles.description}>{description}</p>
      <div className={styles.actions}>
        <button type="button" onClick={onCancel} disabled={pending} className={styles.cancelButton}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={pending} className={destructive ? styles.destructiveButton : styles.confirmButton}>
          {pending ? "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
