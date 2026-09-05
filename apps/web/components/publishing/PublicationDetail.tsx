"use client";

import { useCallback, useEffect, useState } from "react";
import { publishingApi } from "../../lib/api/publishing";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { PublicationListItemView, PublicationTargetView, SafeAttemptView } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardBody } from "../ui/Card";
import { ErrorBanner, LoadingState } from "../ui/Feedback";
import { ExternalLink } from "../ui/ExternalLink";
import { PageHeader } from "../ui/PageHeader";
import { CHANNEL_LABEL, readinessReasonLabel } from "./publishingLabels";
import { TargetStatusBadge } from "./PublishingStatusBadges";
import { ReconciliationDialog } from "./ReconciliationDialog";
import styles from "./PublicationDetail.module.css";

const RETRYABLE_STATUSES = new Set(["FAILED"]);
const CANCELLABLE_STATUSES = new Set(["PENDING", "SCHEDULED", "QUEUED", "FAILED"]);

export function PublicationDetail({ workspaceId, publicationId }: { workspaceId: string; publicationId: string }) {
  const { permissions } = useSession();
  const canExecute = hasPermission(permissions, "PUBLISH_EXECUTE");
  const canCancel = hasPermission(permissions, "PUBLISH_CANCEL");
  const canReconcile = hasPermission(permissions, "PUBLISH_CHANNEL_MANAGE");

  const [publication, setPublication] = useState<PublicationListItemView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [attemptsByTarget, setAttemptsByTarget] = useState<Record<string, SafeAttemptView[]>>({});
  const [expandedTargetId, setExpandedTargetId] = useState<string | null>(null);
  const [reconcileState, setReconcileState] = useState<{ target: PublicationTargetView; mode: "mark-published" | "confirm-not-published" } | null>(null);

  const load = useCallback(() => {
    setError(null);
    publishingApi.publications
      .detail(workspaceId, publicationId)
      .then(setPublication)
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, publicationId]);

  useEffect(load, [load]);

  async function toggleAttempts(targetId: string) {
    if (expandedTargetId === targetId) {
      setExpandedTargetId(null);
      return;
    }
    setExpandedTargetId(targetId);
    if (!attemptsByTarget[targetId]) {
      try {
        const attempts = await publishingApi.publications.attempts(workspaceId, targetId);
        setAttemptsByTarget((prev) => ({ ...prev, [targetId]: attempts }));
      } catch (err) {
        setActionError(friendlyMessage(err));
      }
    }
  }

  async function retry(targetId: string) {
    setPendingTargetId(targetId);
    setActionError(null);
    try {
      await publishingApi.publications.retry(workspaceId, targetId);
      load();
    } catch (err) {
      setActionError(friendlyMessage(err));
    } finally {
      setPendingTargetId(null);
    }
  }

  async function cancel(targetId: string) {
    setPendingTargetId(targetId);
    setActionError(null);
    try {
      await publishingApi.publications.cancel(workspaceId, targetId);
      load();
    } catch (err) {
      setActionError(friendlyMessage(err));
    } finally {
      setPendingTargetId(null);
    }
  }

  async function submitMarkPublished(input: { externalContentId: string; externalUrl?: string; note: string }) {
    if (!reconcileState) return;
    setPendingTargetId(reconcileState.target.publicId);
    setActionError(null);
    try {
      await publishingApi.publications.markExternallyPublished(workspaceId, reconcileState.target.publicId, input);
      setReconcileState(null);
      load();
    } catch (err) {
      setActionError(friendlyMessage(err));
    } finally {
      setPendingTargetId(null);
    }
  }

  async function submitConfirmNotPublished(input: { note: string }) {
    if (!reconcileState) return;
    setPendingTargetId(reconcileState.target.publicId);
    setActionError(null);
    try {
      await publishingApi.publications.confirmNotPublished(workspaceId, reconcileState.target.publicId, input);
      setReconcileState(null);
      load();
    } catch (err) {
      setActionError(friendlyMessage(err));
    } finally {
      setPendingTargetId(null);
    }
  }

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!publication) return <LoadingState label="Loading publication…" />;

  return (
    <div className={styles.wrap}>
      <PageHeader
        title={publication.contentTitle}
        description={`${publication.contentType} • requested ${new Date(publication.requestedAt).toLocaleString()}`}
        eyebrow={
          <a href={`/workspaces/${workspaceId}/publishing`} className={styles.back}>
            ← Back to Publishing
          </a>
        }
      />

      {actionError && <ErrorBanner message={actionError} onRetry={() => setActionError(null)} />}

      {publication.summary.hasPartialFailure && (
        <Badge tone="danger">Partial failure — {publication.summary.publishedCount}/{publication.summary.totalTargets} targets published</Badge>
      )}

      <div className={styles.targets}>
        {publication.targets.map((target) => {
          const canRetryThis = canExecute && RETRYABLE_STATUSES.has(target.status) && !target.reconciliationRequired;
          const canCancelThis = canCancel && CANCELLABLE_STATUSES.has(target.status);
          const attempts = attemptsByTarget[target.publicId];
          return (
            <Card key={target.publicId}>
              <CardBody className={styles.targetBody}>
                <div className={styles.targetHeader}>
                  <div>
                    <div className={styles.channelLabel}>{CHANNEL_LABEL[target.channelType]}</div>
                    <div className={styles.channelName}>{target.channelDisplayName}</div>
                  </div>
                  <TargetStatusBadge status={target.status} reconciliationRequired={target.reconciliationRequired} />
                </div>

                <dl className={styles.meta}>
                  {target.scheduledFor && (
                    <div>
                      <dt>Scheduled for</dt>
                      <dd>{new Date(target.scheduledFor).toLocaleString()}</dd>
                    </div>
                  )}
                  {target.publishedAt && (
                    <div>
                      <dt>Published at</dt>
                      <dd>{new Date(target.publishedAt).toLocaleString()}</dd>
                    </div>
                  )}
                  {target.externalUrl && (
                    <div>
                      <dt>External link</dt>
                      <dd>
                        <ExternalLink href={target.externalUrl}>{target.externalUrl}</ExternalLink>
                      </dd>
                    </div>
                  )}
                  {!target.externalUrl && target.externalContentId && (
                    <div>
                      <dt>External ID</dt>
                      <dd>{target.externalContentId}</dd>
                    </div>
                  )}
                  {target.lastErrorMessageSafe && (
                    <div>
                      <dt>Last error</dt>
                      <dd>{readinessReasonLabel(target.lastErrorCode ?? "")} — {target.lastErrorMessageSafe}</dd>
                    </div>
                  )}
                </dl>

                {target.reconciliationRequired && (
                  <div className={styles.reconciliationNote}>
                    This target&rsquo;s last attempt had an ambiguous external outcome and cannot be retried until an operator verifies the real result directly with the provider.
                  </div>
                )}

                <div className={styles.targetActions}>
                  {canRetryThis && (
                    <Button size="sm" variant="secondary" onClick={() => retry(target.publicId)} loading={pendingTargetId === target.publicId}>
                      Retry
                    </Button>
                  )}
                  {canCancelThis && (
                    <Button size="sm" variant="ghost" onClick={() => cancel(target.publicId)} loading={pendingTargetId === target.publicId}>
                      Cancel
                    </Button>
                  )}
                  {canReconcile && target.reconciliationRequired && (
                    <>
                      <Button size="sm" onClick={() => setReconcileState({ target, mode: "mark-published" })}>
                        Mark as Published
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setReconcileState({ target, mode: "confirm-not-published" })}>
                        Confirm Not Published
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => toggleAttempts(target.publicId)}>
                    {expandedTargetId === target.publicId ? "Hide history" : "View history"}
                  </Button>
                </div>

                {expandedTargetId === target.publicId && (
                  <div className={styles.attempts}>
                    {!attempts && <LoadingState label="Loading attempt history…" />}
                    {attempts?.map((attempt) => (
                      <div key={attempt.attemptNumber} className={styles.attemptRow}>
                        <span className={styles.attemptNumber}>#{attempt.attemptNumber}</span>
                        <span>{attempt.fromStatus ?? "—"} → {attempt.toStatus}</span>
                        <span className={styles.attemptTime}>{new Date(attempt.occurredAt).toLocaleString()}</span>
                        {attempt.detail?.errorCode && <Badge tone="danger">{String(attempt.detail.errorCode)}</Badge>}
                      </div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          );
        })}
      </div>

      <ReconciliationDialog
        open={!!reconcileState}
        mode={reconcileState?.mode ?? "confirm-not-published"}
        pending={!!reconcileState && pendingTargetId === reconcileState.target.publicId}
        error={null}
        onCancel={() => setReconcileState(null)}
        onSubmitMarkPublished={submitMarkPublished}
        onSubmitConfirmNotPublished={submitConfirmNotPublished}
      />
    </div>
  );
}
