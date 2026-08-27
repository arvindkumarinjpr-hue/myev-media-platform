"use client";

import Link from "next/link";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import styles from "./error.module.css";

// Next.js strips custom Error properties (like an ApiError's .status) when
// crossing the server/client boundary in production — only .message
// survives reliably — so this can't distinguish "session expired" from
// any other failure. Offering both actions covers both causes without
// guessing.
export default function WorkspaceError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className={styles.wrap}>
      <Alert tone="danger" title="Couldn't load this workspace">
        {error.message || "Something went wrong. This can happen if your session expired."}
      </Alert>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={reset}>
          Try again
        </Button>
        <Button href="/login" variant="ghost">
          Sign in again
        </Button>
        <Link href="/workspaces" className={styles.link}>
          All workspaces
        </Link>
      </div>
    </div>
  );
}
