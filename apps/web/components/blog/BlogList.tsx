"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { blogApi } from "../../lib/api/blog";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { BlogListItem, ContentItemStatus } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { DataTable, type Column } from "../ui/DataTable";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { BlogIcon, PlusIcon } from "../ui/icons";
import { ContentItemStatusBadge } from "./BlogStageBadge";
import { deriveListStage } from "./pipelineStage";
import { PIPELINE_STAGE_LABEL } from "./blogLabels";
import styles from "./BlogList.module.css";

const STATUS_FILTERS: { value: "" | ContentItemStatus; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "REVIEW", label: "In review" },
  { value: "APPROVED", label: "Approved" },
  { value: "ARCHIVED", label: "Archived" },
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function BlogList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const [items, setItems] = useState<BlogListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"" | ContentItemStatus>("");
  const [query, setQuery] = useState("");

  function load() {
    setError(null);
    setItems(null);
    blogApi
      .list(workspaceId)
      .then(setItems)
      .catch((err) => setError(friendlyMessage(err)));
  }

  useEffect(load, [workspaceId]);

  const canCreate = hasPermission(permissions, "BLOG_CREATE");
  const canSeeScore = hasPermission(permissions, "BLOG_VIEW"); // score read is BLOG_VIEW-gated on the backend
  const newHref = `/workspaces/${workspaceId}/blog/new`;

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    return items.filter((i) => (status ? i.status === status : true) && (q ? i.title.toLowerCase().includes(q) : true));
  }, [items, status, query]);

  const columns: Column<BlogListItem>[] = [
    {
      key: "title",
      header: "Title",
      label: "Title",
      render: (b) => <Link href={`/workspaces/${workspaceId}/blog/${b.publicId}`}>{b.title || "Untitled article"}</Link>,
    },
    { key: "status", header: "Status", label: "Status", render: (b) => <ContentItemStatusBadge status={b.status} /> },
    {
      key: "stage",
      header: "Stage",
      label: "Stage",
      render: (b) => <span className={styles.stage}>{PIPELINE_STAGE_LABEL[deriveListStage(b)]}</span>,
    },
    {
      key: "score",
      header: "Score",
      label: "Score",
      render: (b) => {
        if (!canSeeScore || b.scoring.status !== "COMPLETED" || b.scoring.overallScore === null) return <span className={styles.muted}>—</span>;
        return (
          <span className={styles.score}>
            <strong>{b.scoring.overallScore}</strong>
            <Badge tone={b.scoring.passed ? "success" : "danger"}>{b.scoring.passed ? "Passed" : "Below threshold"}</Badge>
          </span>
        );
      },
    },
    {
      key: "publishReady",
      header: "Publish",
      label: "Publish",
      render: (b) => (b.status === "APPROVED" ? <Badge tone="success">Publish ready</Badge> : <span className={styles.muted}>—</span>),
    },
    {
      key: "open",
      header: "",
      align: "end",
      render: (b) => <Link href={`/workspaces/${workspaceId}/blog/${b.publicId}`}>Open</Link>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Blog"
        description="Automate research-grounded blog articles through the full brief → outline → draft → SEO → review pipeline."
        actions={
          canCreate ? (
            <Button href={newHref} iconLeft={<PlusIcon />}>
              Create Blog
            </Button>
          ) : undefined
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && items === null && <LoadingState label="Loading blog articles…" />}

      {!error && items !== null && items.length === 0 && (
        <EmptyState
          icon={<BlogIcon />}
          title="No blog articles yet"
          description="Start from a validated topic and an active Knowledge Pack — the pipeline drafts, optimises and scores the article, then hands it to a human reviewer."
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
            <Select value={status} onChange={(e) => setStatus(e.target.value as "" | ContentItemStatus)} aria-label="Filter blog articles by status">
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Input
              type="search"
              value={query}
              placeholder="Search by title…"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search blog articles by title"
            />
          </div>

          {filtered && filtered.length === 0 ? (
            <EmptyState title="No articles match these filters" description="Try a different status or clear the search." />
          ) : (
            <DataTable columns={columns} rows={filtered ?? []} rowKey={(b) => b.publicId} caption="Blog articles" />
          )}
        </>
      )}
    </div>
  );
}
