import styles from "./loading.module.css";

/** Shown while the workspace layout resolves its data (and on nav between sections). */
export default function WorkspaceLoading() {
  return (
    <div className={styles.wrap} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className={styles.header} />
      <div className={styles.grid}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={styles.card} />
        ))}
      </div>
      <div className={styles.block} />
    </div>
  );
}
