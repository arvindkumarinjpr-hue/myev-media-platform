"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { socialApi } from "../../lib/api/social";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { ContentItemStatus, SocialPlatform, SocialPostListItem } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { DataTable, type Column } from "../ui/DataTable";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { PlusIcon, SocialIcon } from "../ui/icons";
import { ContentItemStatusBadge, PlatformBadge } from "./SocialStatusBadge";
import { SOURCE_TYPE_LABEL, fmtDateTime } from "./socialLabels";
import styles from "./SocialList.module.css";

const STATUS_FILTERS: { value: "" | ContentItemStatus; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "REVIEW", label: "In review" },
  { value: "APPROVED", label: "Approved" },
];

const PLATFORM_FILTERS: { value: "" | SocialPlatform; label: string }[] = [
  { value: "", label: "All platforms" },
  { value: "FACEBOOK", label: "Facebook" },
  { value: "INSTAGRAM", label: "Instagram" },
];

const SOURCE_FILTERS: { value: "" | "BLOG" | "VIDEO"; label: string }[] = [
  { value: "", label: "All sources" },
  { value: "BLOG", label: "Blog" },
  { value: "VIDEO", label: "Video" },
];

/**
 * Module 10 Phase 10.6 (Parts D/E) — one list, not a page-per-status: the
 * "review queue" the checkpoint asks for is just the status filter below
 * set to "In review", exactly mirroring Blog/Video's own single-list shape
 * rather than adding a second page for it.
 */
export function SocialList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const [items, setItems] = useState<SocialPostListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"" | ContentItemStatus>("");
  const [platform, setPlatform] = useState<"" | SocialPlatform>("");
  const [source, setSource] = useState<"" | "BLOG" | "VIDEO">("");

  function load() {
    setError(null);
    setItems(null);
    socialApi
      .list(workspaceId)
      .then(setItems)
      .catch((err) => setError(friendlyMessage(err)));
  }

  useEffect(load, [workspaceId]);

  const canCreate = hasPermission(permissions, "SOCIAL_CREATE");
  const newHref = `/workspaces/${workspaceId}/social/new`;

  const filtered = useMemo(() => {
    if (!items) return null;
    return items.filter(
      (i) => (status ? i.status === status : true) && (platform ? i.platform === platform : true) && (source ? i.sourceContentType === source : true),
    );
  }, [items, status, platform, source]);

  const columns: Column<SocialPostListItem>[] = [
    {
      key: "title",
      header: "Title / source",
      label: "Title / source",
      render: (v) => (
        <span className={styles.titleCell}>
          <Link href={`/workspaces/${workspaceId}/social/${v.publicId}`}>{v.title || "Untitled social post"}</Link>
          <span className={styles.muted}>{v.sourceContentType ? SOURCE_TYPE_LABEL[v.sourceContentType] : "—"} source</span>
        </span>
      ),
    },
    { key: "platform", header: "Platform", label: "Platform", render: (v) => <PlatformBadge platform={v.platform} /> },
    { key: "status", header: "Status", label: "Status", render: (v) => <ContentItemStatusBadge status={v.status} /> },
    {
      key: "caption",
      header: "Caption",
      label: "Caption",
      render: (v) => <span className={styles.captionPreview}>{v.caption ? (v.caption.length > 80 ? `${v.caption.slice(0, 80)}…` : v.caption) : <span className={styles.muted}>No caption</span>}</span>,
    },
    {
      key: "media",
      header: "Media",
      label: "Media",
      render: (v) => (v.hasMedia ? <Badge tone="info">Attached</Badge> : v.platform === "INSTAGRAM" ? <Badge tone="warning">Media required</Badge> : <span className={styles.muted}>None</span>),
    },
    {
      key: "updated",
      header: "Updated",
      label: "Updated",
      render: (v) => <span className={styles.muted}>{fmtDateTime(v.updatedAt)}</span>,
    },
    {
      key: "open",
      header: "",
      align: "end",
      render: (v) => <Link href={`/workspaces/${workspaceId}/social/${v.publicId}`}>Open</Link>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Social Content"
        description="Facebook and Instagram posts generated from your Approved Blog and Video content."
        actions={
          canCreate ? (
            <Button href={newHref} iconLeft={<PlusIcon />}>
              New Social Post
            </Button>
          ) : undefined
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && items === null && <LoadingState label="Loading social content…" />}

      {!error && items !== null && items.length === 0 && (
        <EmptyState
          icon={<SocialIcon />}
          title="No social posts yet"
          description="Create a Facebook or Instagram post from an already-Approved Blog or Video — the caption and hashtags are generated from it, never written from scratch."
          action={
            canCreate ? (
              <Button href={newHref} iconLeft={<PlusIcon />}>
                Create the first one
              </Button>
            ) : undefined
          }
        />
      )}

      {!error && items !== null && items.length > 0 && (
        <>
          <div className={styles.filters}>
            <Select value={status} onChange={(e) => setStatus(e.target.value as "" | ContentItemStatus)} aria-label="Filter by status">
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Select value={platform} onChange={(e) => setPlatform(e.target.value as "" | SocialPlatform)} aria-label="Filter by platform">
              {PLATFORM_FILTERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Select value={source} onChange={(e) => setSource(e.target.value as "" | "BLOG" | "VIDEO")} aria-label="Filter by source">
              {SOURCE_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>

          {filtered && filtered.length === 0 ? (
            <EmptyState title="No social posts match these filters" description="Try a different status, platform or source." />
          ) : (
            <DataTable columns={columns} rows={filtered ?? []} rowKey={(v) => v.publicId} caption="Social posts" />
          )}
        </>
      )}
    </div>
  );
}
