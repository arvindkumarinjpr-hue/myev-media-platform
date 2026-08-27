"use client";

import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Logo } from "../../components/shell/Logo";
import styles from "./route-message.module.css";

/**
 * Catches failures in the /workspaces picker page AND in the
 * /workspaces/[workspaceId] layout's own data fetch (a layout's error
 * bubbles to the parent segment's boundary). The most common cause is an
 * expired session, so signing in again is the primary action.
 */
export default function WorkspacesError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Logo size="sm" />
        <Alert tone="danger" title="Something went wrong">
          {error.message || "We couldn't load your workspaces. Your session may have expired."}
        </Alert>
        <div className={styles.actions}>
          <Button href="/login">Sign in again</Button>
          <Button variant="secondary" onClick={reset}>
            Retry
          </Button>
        </div>
      </div>
    </main>
  );
}
