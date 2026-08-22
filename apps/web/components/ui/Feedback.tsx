import styles from "./Feedback.module.css";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className={styles.loading}>
      {label}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className={styles.error}>
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className={styles.retryButton}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {description && <p className={styles.emptyDescription}>{description}</p>}
      {action}
    </div>
  );
}
