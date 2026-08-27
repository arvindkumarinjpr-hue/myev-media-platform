import type { ReactNode } from "react";
import styles from "./DangerZone.module.css";

/** Visually separated container for destructive lifecycle actions (archive / delete). */
export function DangerZone({ children }: { children: ReactNode }) {
  return (
    <section className={styles.zone} aria-label="Danger zone">
      <p className={styles.heading}>Danger zone</p>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
