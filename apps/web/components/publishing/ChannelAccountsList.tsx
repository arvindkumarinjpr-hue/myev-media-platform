"use client";

import { useCallback, useEffect, useState } from "react";
import { publishingApi } from "../../lib/api/publishing";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { PublishingAccountView } from "../../lib/types";
import { Button } from "../ui/Button";
import { Card, CardBody } from "../ui/Card";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ErrorBanner, LoadingState, EmptyState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { PlusIcon } from "../ui/icons";
import { CHANNEL_LABEL } from "./publishingLabels";
import { ConnectionStatusBadge } from "./PublishingStatusBadges";
import styles from "./ChannelAccountsList.module.css";

/**
 * Module 9 Phase 9.7 (Part AA) — the Channel Accounts management view.
 * WordPress uses a write-only manual form (a separate route — Part F/AA:
 * "Never render credential fields after save"); YouTube/Facebook/
 * Instagram use Connect/Reconnect buttons that navigate the browser
 * directly to the provider's own consent screen (the authorization URL
 * this page fetches from the server) — never a client-side token.
 */
export function ChannelAccountsList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const canManage = hasPermission(permissions, "PUBLISH_CHANNEL_MANAGE");

  const [accounts, setAccounts] = useState<PublishingAccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<PublishingAccountView | null>(null);
  const [connecting, setConnecting] = useState<"youtube" | "meta" | null>(null);

  const load = useCallback(() => {
    setError(null);
    publishingApi.accounts
      .list(workspaceId)
      .then(setAccounts)
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId]);

  useEffect(load, [load]);

  async function startOAuth(provider: "youtube" | "meta") {
    setConnecting(provider);
    setActionError(null);
    try {
      const { authorizationUrl } = provider === "youtube" ? await publishingApi.oauth.startYouTube(workspaceId) : await publishingApi.oauth.startMeta(workspaceId);
      window.location.href = authorizationUrl;
    } catch (err) {
      setActionError(friendlyMessage(err));
      setConnecting(null);
    }
  }

  async function testConnection(accountId: string) {
    setPendingAction(accountId);
    setActionError(null);
    try {
      const updated = await publishingApi.accounts.testConnection(workspaceId, accountId);
      setAccounts((prev) => prev?.map((a) => (a.publicId === accountId ? updated : a)) ?? prev);
    } catch (err) {
      setActionError(friendlyMessage(err));
    } finally {
      setPendingAction(null);
    }
  }

  async function confirmDisconnect() {
    if (!disconnectTarget) return;
    setPendingAction(disconnectTarget.publicId);
    setActionError(null);
    try {
      const updated = await publishingApi.accounts.disconnect(workspaceId, disconnectTarget.publicId);
      setAccounts((prev) => prev?.map((a) => (a.publicId === updated.publicId ? updated : a)) ?? prev);
    } catch (err) {
      setActionError(friendlyMessage(err));
    } finally {
      setPendingAction(null);
      setDisconnectTarget(null);
    }
  }

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="Channel Accounts"
        description="Connect WordPress, YouTube, Facebook and Instagram accounts to publish approved content to."
        actions={
          canManage ? (
            <div className={styles.connectActions}>
              <Button href={`/workspaces/${workspaceId}/publishing/accounts/connect/wordpress`} variant="secondary" iconLeft={<PlusIcon />}>
                Connect WordPress
              </Button>
              <Button onClick={() => startOAuth("youtube")} loading={connecting === "youtube"} iconLeft={<PlusIcon />}>
                Connect YouTube
              </Button>
              <Button onClick={() => startOAuth("meta")} loading={connecting === "meta"} iconLeft={<PlusIcon />}>
                Connect Facebook / Instagram
              </Button>
            </div>
          ) : undefined
        }
      />

      {!canManage && (
        <p className={styles.viewOnlyNote}>You can see connected accounts here, but connecting or managing them requires an Administrator or Owner.</p>
      )}

      {error && <ErrorBanner message={error} onRetry={load} />}
      {actionError && <ErrorBanner message={actionError} onRetry={() => setActionError(null)} />}
      {!error && accounts === null && <LoadingState label="Loading channel accounts…" />}

      {!error && accounts !== null && accounts.length === 0 && (
        <EmptyState
          title="No channel accounts connected yet"
          description="Connect at least one channel account to start publishing approved content."
        />
      )}

      {!error && accounts !== null && accounts.length > 0 && (
        <div className={styles.grid}>
          {accounts.map((account) => (
            <Card key={account.publicId}>
              <CardBody className={styles.cardBody}>
                <div className={styles.cardHeader}>
                  <div>
                    <div className={styles.channelLabel}>{CHANNEL_LABEL[account.channelType]}</div>
                    <div className={styles.displayName}>{account.displayName}</div>
                  </div>
                  <ConnectionStatusBadge status={account.connectionStatus} />
                </div>
                <dl className={styles.meta}>
                  <div>
                    <dt>Identity</dt>
                    <dd>{account.externalAccountId}</dd>
                  </div>
                  {account.tokenExpiresAt && (
                    <div>
                      <dt>Token expires</dt>
                      <dd>{new Date(account.tokenExpiresAt).toLocaleString()}</dd>
                    </div>
                  )}
                  {account.lastVerifiedAt && (
                    <div>
                      <dt>Last verified</dt>
                      <dd>{new Date(account.lastVerifiedAt).toLocaleString()}</dd>
                    </div>
                  )}
                </dl>
                {canManage && account.connectionStatus !== "REVOKED" && (
                  <div className={styles.cardActions}>
                    <Button size="sm" variant="secondary" onClick={() => testConnection(account.publicId)} loading={pendingAction === account.publicId}>
                      Test connection
                    </Button>
                    {account.channelType === "WORDPRESS" && (
                      <Button size="sm" variant="ghost" href={`/workspaces/${workspaceId}/publishing/accounts/${account.publicId}/rotate`}>
                        Update credential
                      </Button>
                    )}
                    {account.channelType === "YOUTUBE" && (
                      <Button size="sm" variant="ghost" onClick={() => startOAuth("youtube")}>
                        Reconnect
                      </Button>
                    )}
                    {(account.channelType === "FACEBOOK" || account.channelType === "INSTAGRAM") && (
                      <Button size="sm" variant="ghost" onClick={() => startOAuth("meta")}>
                        Reconnect
                      </Button>
                    )}
                    <Button size="sm" variant="danger" onClick={() => setDisconnectTarget(account)} disabled={pendingAction === account.publicId}>
                      Disconnect
                    </Button>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!disconnectTarget}
        title={`Disconnect ${disconnectTarget ? CHANNEL_LABEL[disconnectTarget.channelType] : ""}?`}
        description="This account will no longer be usable for new publications. Existing publication history is preserved."
        confirmLabel="Disconnect"
        destructive
        pending={pendingAction === disconnectTarget?.publicId}
        onConfirm={confirmDisconnect}
        onCancel={() => setDisconnectTarget(null)}
      />
    </div>
  );
}
