"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { publishingApi } from "../../lib/api/publishing";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { PublicationListItemView, PublicationTargetStatus, PublishingChannelType } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardBody } from "../ui/Card";
import { DataTable, type Column } from "../ui/DataTable";
import { ErrorBanner, LoadingState, EmptyState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { PlusIcon } from "../ui/icons";
import { CHANNEL_LABEL } from "./publishingLabels";
import { TargetStatusBadge } from "./PublishingStatusBadges";
import styles from "./PublicationsList.module.css";

const STATUS_FILTERS: { value: "" | PublicationTargetStatus; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "SCHEDULED", label: "Scheduled" },
  { value: "QUEUED", label: "Queued" },
  { value: "PUBLISHING", label: "Publishing" },
  { value: "PUBLISHED", label: "Published" },
  { value: "FAILED", label: "Failed" },
  { value: "CANCELLED", label: "Cancelled" },
];

const CHANNEL_FILTERS: { value: "" | PublishingChannelType; label: string }[] = [
  { value: "", label: "All channels" },
  { value: "WORDPRESS", label: "WordPress" },
  { value: "YOUTUBE", label: "YouTube" },
  { value: "FACEBOOK", label: "Facebook" },
  { value: "INSTAGRAM", label: "Instagram" },
];

/**
 * Module 9 Phase 9.7 (Part R/S) — the Publishing dashboard. Summary
 * cards and every count are derived from real PublicationTarget rows
 * (Part S: "Use Phase 9.1 derivePublicationSummary()" — this reads the
 * server's own already-derived summary per publication, never re-derives
 * or fabricates an aggregate here) — no persisted/fake analytics.
 */
export function PublicationsList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const canCreate = hasPermission(permissions, "PUBLISH_CREATE");

  const [publications, setPublications] = useState<PublicationListItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"" | PublicationTargetStatus>("");
  const [channelType, setChannelType] = useState<"" | PublishingChannelType>("");

  const load = useCallback(() => {
    setError(null);
    publishingApi.publications
      .list(workspaceId, { status: status || undefined, channelType: channelType || undefined })
      .then(setPublications)
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, status, channelType]);

  useEffect(load, [load]);

  const counts = useMemo(() => {
    if (!publications) return null;
    const allTargets = publications.flatMap((p) => p.targets);
    return {
      live: allTargets.filter((t) => t.status === "PENDING" || t.status === "SCHEDULED" || t.status === "QUEUED" || t.status === "PUBLISHING").length,
      published: allTargets.filter((t) => t.status === "PUBLISHED").length,
      needsAttention: allTargets.filter((t) => t.status === "FAILED").length,
    };
  }, [publications]);

  const columns: Column<PublicationListItemView>[] = [
    {
      key: "content",
      header: "Content",
      label: "Content",
      render: (p) => <Link href={`/workspaces/${workspaceId}/publishing/publications/${p.publicId}`}>{p.contentTitle}</Link>,
    },
    { key: "type", header: "Type", label: "Type", render: (p) => <span>{p.contentType}</span> },
    {
      key: "channels",
      header: "Channels",
      label: "Channels",
      render: (p) => (
        <div className={styles.channelBadges}>
          {p.targets.map((t) => (
            <span key={t.publicId} className={styles.channelBadge}>
              <span className={styles.channelBadgeLabel}>{CHANNEL_LABEL[t.channelType]}</span>
              <TargetStatusBadge status={t.status} reconciliationRequired={t.reconciliationRequired} />
            </span>
          ))}
        </div>
      ),
    },
    {
      key: "when",
      header: "Scheduled / Requested",
      label: "Scheduled / Requested",
      render: (p) => <span>{p.scheduledFor ? new Date(p.scheduledFor).toLocaleString() : new Date(p.requestedAt).toLocaleString()}</span>,
    },
    {
      key: "summary",
      header: "Progress",
      label: "Progress",
      render: (p) => (
        <span>
          {p.summary.publishedCount}/{p.summary.totalTargets} published
          {p.summary.hasPartialFailure && (
            <>
              {" "}
              <Badge tone="danger">partial failure</Badge>
            </>
          )}
        </span>
      ),
    },
    { key: "open", header: "", align: "end", render: (p) => <Link href={`/workspaces/${workspaceId}/publishing/publications/${p.publicId}`}>Open</Link> },
  ];

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="Publishing"
        description="Publish approved content to connected channels, immediately or on a schedule."
        actions={
          <div className={styles.headerActions}>
            <Button href={`/workspaces/${workspaceId}/publishing/accounts`} variant="secondary">
              Channel Accounts
            </Button>
            {canCreate && (
              <Button href={`/workspaces/${workspaceId}/publishing/publications/new`} iconLeft={<PlusIcon />}>
                New Publication
              </Button>
            )}
          </div>
        }
      />

      {counts && (
        <div className={styles.summaryCards}>
          <Card>
            <CardBody className={styles.summaryCardBody}>
              <span className={styles.summaryValue}>{counts.live}</span>
              <span className={styles.summaryLabel}>Pending / Scheduled / In progress</span>
            </CardBody>
          </Card>
          <Card>
            <CardBody className={styles.summaryCardBody}>
              <span className={styles.summaryValue}>{counts.published}</span>
              <span className={styles.summaryLabel}>Published</span>
            </CardBody>
          </Card>
          <Card>
            <CardBody className={styles.summaryCardBody}>
              <span className={styles.summaryValue}>{counts.needsAttention}</span>
              <span className={styles.summaryLabel}>Failed / needs attention</span>
            </CardBody>
          </Card>
        </div>
      )}

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && publications === null && <LoadingState label="Loading publications…" />}

      {!error && publications !== null && publications.length === 0 && (
        <EmptyState
          title="No publications yet"
          description="Create a publication from an approved Blog or Video to send it to a connected channel."
          action={
            canCreate ? (
              <Button href={`/workspaces/${workspaceId}/publishing/publications/new`} iconLeft={<PlusIcon />}>
                New Publication
              </Button>
            ) : undefined
          }
        />
      )}

      {!error && publications !== null && publications.length > 0 && (
        <>
          <div className={styles.filters}>
            <Select value={status} onChange={(e) => setStatus(e.target.value as "" | PublicationTargetStatus)} aria-label="Filter by target status">
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Select value={channelType} onChange={(e) => setChannelType(e.target.value as "" | PublishingChannelType)} aria-label="Filter by channel">
              {CHANNEL_FILTERS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <DataTable columns={columns} rows={publications} rowKey={(p) => p.publicId} caption="Publications" />
        </>
      )}
    </div>
  );
}
