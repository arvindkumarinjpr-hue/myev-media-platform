"use client";

import Link from "next/link";
import { ErrorBanner } from "../../../components/ui/Feedback";

// Next.js strips custom Error properties (like an ApiError's .status) when
// crossing the server/client boundary in production — only .message
// survives reliably — so this can't distinguish "session expired" from
// any other failure. Offering both actions covers both causes without
// guessing.
export default function WorkspaceError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main style={{ maxWidth: "40rem", margin: "2rem auto", padding: "0 1rem" }}>
      <ErrorBanner message={error.message || "Something went wrong loading this workspace."} onRetry={reset} />
      <p style={{ marginTop: "0.75rem" }}>
        <Link href="/login">Sign in again</Link>
      </p>
    </main>
  );
}
