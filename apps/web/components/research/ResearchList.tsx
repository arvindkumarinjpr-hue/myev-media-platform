"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { researchApi } from "../../lib/api/research";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { Research } from "../../lib/types";
import { Button } from "../ui/Button";
import { DataTable, type Column } from "../ui/DataTable";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { ResearchIcon, PlusIcon } from "../ui/icons";
import { ResearchStatusBadge } from "./ResearchStatusBadge";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ResearchList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const [items, setItems] = useState<Research[] | null>(null);
  const [packNames, setPackNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setItems(null);
    researchApi
      .list(workspaceId)
      .then(setItems)
      .catch((err) => setError(friendlyMessage(err)));
    // Best-effort name resolution — the research payload only carries the
    // Knowledge Pack version id, never its name. A failure here just
    // leaves the column blank.
    knowledgePacksApi
      .list(workspaceId)
      .then((packs) => setPackNames(new Map(packs.map((p) => [p.publicId, p.name]))))
      .catch(() => undefined);
  }

  useEffect(load, [workspaceId]);

  const canRun = hasPermission(permissions, "RESEARCH_RUN");
  const newHref = `/workspaces/${workspaceId}/research/new`;

  const columns: Column<Research>[] = [
    {
      key: "topic",
      header: "Topic",
      render: (r) => (
        <Link href={`/workspaces/${workspaceId}/research/${r.publicId}`}>{r.topic ?? "Untitled research"}</Link>
      ),
    },
    { key: "status", header: "Status", render: (r) => <ResearchStatusBadge status={r.status} /> },
    { key: "kp", header: "Knowledge Pack", render: (r) => packNames.get(r.knowledgePackVersionId) ?? "—" },
    { key: "created", header: "Created", render: (r) => formatDate(r.createdAt) },
    {
      key: "open",
      header: "",
      align: "end",
      render: (r) => <Link href={`/workspaces/${workspaceId}/research/${r.publicId}`}>Open</Link>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Research"
        description="Discover evidence-backed topics, trends and keyword opportunities."
        actions={
          canRun ? (
            <Button href={newHref} iconLeft={<PlusIcon />}>
              New Research
            </Button>
          ) : undefined
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && items === null && <LoadingState label="Loading research…" />}
      {!error && items !== null && items.length === 0 && (
        <EmptyState
          icon={<ResearchIcon />}
          title="No research yet"
          description="Start an evidence-backed research run grounded in a Knowledge Pack's trusted sources."
          action={
            canRun ? (
              <Button href={newHref} iconLeft={<PlusIcon />}>
                Start the first one
              </Button>
            ) : undefined
          }
        />
      )}
      {!error && items !== null && items.length > 0 && (
        <DataTable columns={columns} rows={items} rowKey={(r) => r.publicId} caption="Research runs" />
      )}
    </div>
  );
}
