"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "../../../components/ui/Button";
import { Logo } from "../../../components/shell/Logo";
import { CHANNEL_LABEL } from "../../../components/publishing/publishingLabels";
import styles from "../../not-found.module.css";

const PROVIDER_LABEL: Record<string, string> = {
  youtube: CHANNEL_LABEL.YOUTUBE,
  meta: "Facebook / Instagram",
};

function OAuthErrorContent() {
  const params = useSearchParams();
  const provider = params.get("provider") ?? "";
  const label = PROVIDER_LABEL[provider] ?? "the channel";

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Logo size="sm" />
        <div>
          <h1 className={styles.title}>Connection failed</h1>
          <p className={styles.text}>
            We couldn&apos;t connect your {label} account. This can happen if the authorization was cancelled, expired, or denied. No credential was saved. You can try
            connecting again from Channel Accounts.
          </p>
        </div>
        <Button href="/workspaces">Back to your workspaces</Button>
      </div>
    </main>
  );
}

export default function PublishingOAuthErrorPage() {
  return (
    <Suspense fallback={null}>
      <OAuthErrorContent />
    </Suspense>
  );
}
