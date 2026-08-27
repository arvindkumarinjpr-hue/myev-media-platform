"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { CloseIcon } from "./icons";
import styles from "./Drawer.module.css";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Which edge the panel slides in from. */
  side?: "left" | "right";
  className?: string;
}

/**
 * Native <dialog> in modal mode — Escape-to-close, focus trapping and the
 * inert backdrop all come from the platform. We only add the slide-in
 * panel styling, a visible close button, and backdrop-click-to-close.
 */
export function Drawer({ open, onClose, title, children, side = "left", className }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx(styles.drawer, side === "right" ? styles.right : styles.left, className)}
      aria-label={typeof title === "string" ? title : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Backdrop click: the dialog element itself fills the viewport;
        // the visible panel is an inner element, so a target of the
        // dialog node means the backdrop was clicked.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.title}>{title}</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close menu">
            <CloseIcon />
          </button>
        </div>
        <div className={styles.content}>{children}</div>
      </div>
    </dialog>
  );
}
