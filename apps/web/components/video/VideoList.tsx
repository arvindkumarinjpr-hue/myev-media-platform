"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { videoApi } from "../../lib/api/video";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { ContentItemStatus, VideoListItem } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { DataTable, type Column } from "../ui/DataTable";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { PlusIcon, VideoIcon } from "../ui/icons";
import { ContentItemStatusBadge } from "./VideoStageBadge";
import { deriveListStageLabel } from "./videoStages";
import { TARGET_PLATFORM_LABEL } from "./videoLabels";
import styles from "./VideoList.module.css";

const STATUS_FILTERS: { value: "" | ContentItemStatus; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "REVIEW", label: "In review" },
  { value: "APPROVED", label: "Approved" },
  { value: "ARCHIVED", label: "Archived" },
];

export function VideoList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const [items, setItems] = useState<VideoListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"" | ContentItemStatus>("");
  const [query, setQuery] = useState("");

  function load() {
    setError(null);
    setItems(null);
    videoApi
      .list(workspaceId)
      .then(setItems)
      .catch((err) => setError(friendlyMessage(err)));
  }

  useEffect(load, [workspaceId]);

  const canCreate = hasPermission(permissions, "VIDEO_CREATE");
  const newHref = `/workspaces/${workspaceId}/video/new`;

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    return items.filter((i) => (status ? i.status === status : true) && (q ? i.title.toLowerCase().includes(q) : true));
  }, [items, status, query]);

  const columns: Column<VideoListItem>[] = [
    {
      key: "title",
      header: "Title",
      label: "Title",
      render: (v) => <Link href={`/workspaces/${workspaceId}/video/${v.publicId}`}>{v.title || "Untitled video"}</Link>,
    },
    {
      key: "platform",
      header: "Target platform",
      label: "Target platform",
      render: (v) => <span className={styles.stage}>{v.targetPlatform ? TARGET_PLATFORM_LABEL[v.targetPlatform] : "—"}</span>,
    },
    { key: "status", header: "Status", label: "Status", render: (v) => <ContentItemStatusBadge status={v.status} /> },
    {
      key: "stage",
      header: "Stage",
      label: "Stage",
      render: (v) => <span className={styles.stage}>{deriveListStageLabel(v)}</span>,
    },
    {
      key: "publishReady",
      header: "Publish",
      label: "Publish",
      render: (v) => (v.status === "APPROVED" ? <Badge tone="success">Publish ready</Badge> : <span className={styles.muted}>—</span>),
    },
    {
      key: "open",
      header: "",
      align: "end",
      render: (v) => <Link href={`/workspaces/${workspaceId}/video/${v.publicId}`}>Open</Link>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Video"
        description="Automate videos through the full brief → script → scene plan → assets → voice → subtitles → render → QA → SEO → review pipeline."
        actions={
          canCreate ? (
            <Button href={newHref} iconLeft={<PlusIcon />}>
              New Video
            </Button>
          ) : undefined
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && items === null && <LoadingState label="Loading videos…" />}

      {!error && items !== null && items.length === 0 && (
        <EmptyState
          icon={<VideoIcon />}
          title="No videos yet"
          description="Start from a topic, a target platform and an active Knowledge Pack — the pipeline scripts, sources assets, narrates, renders and QAs the video, then hands it to a human reviewer."
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
            <Select value={status} onChange={(e) => setStatus(e.target.value as "" | ContentItemStatus)} aria-label="Filter videos by status">
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Input type="search" value={query} placeholder="Search by title…" onChange={(e) => setQuery(e.target.value)} aria-label="Search videos by title" />
          </div>

          {filtered && filtered.length === 0 ? (
            <EmptyState title="No videos match these filters" description="Try a different status or clear the search." />
          ) : (
            <DataTable columns={columns} rows={filtered ?? []} rowKey={(v) => v.publicId} caption="Videos" />
          )}
        </>
      )}
    </div>
  );
}
