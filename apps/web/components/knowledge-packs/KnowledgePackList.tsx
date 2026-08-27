"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackSummary } from "../../lib/types";
import { Button } from "../ui/Button";
import { DataTable, type Column } from "../ui/DataTable";
import { LoadingState, ErrorBanner, EmptyState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { StatusBadge } from "../ui/StatusBadge";
import { KnowledgePackIcon, PlusIcon } from "../ui/icons";

export function KnowledgePackList({ workspaceId }: { workspaceId: string }) {
  const { permissions } = useSession();
  const [packs, setPacks] = useState<KnowledgePackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setPacks(null);
    knowledgePacksApi
      .list(workspaceId)
      .then(setPacks)
      .catch((err) => setError(friendlyMessage(err)));
  }

  useEffect(load, [workspaceId]);

  const canCreate = hasPermission(permissions, "KP_CREATE");
  const newHref = `/workspaces/${workspaceId}/knowledge-packs/new`;

  const columns: Column<KnowledgePackSummary>[] = [
    {
      key: "name",
      header: "Name",
      render: (pack) => (
        <Link href={`/workspaces/${workspaceId}/knowledge-packs/${pack.publicId}`}>{pack.name}</Link>
      ),
    },
    { key: "status", header: "Status", render: (pack) => <StatusBadge status={pack.status} /> },
    { key: "version", header: "Version", render: (pack) => `v${pack.versionNumber}` },
    {
      key: "actions",
      header: "",
      align: "end",
      render: (pack) => <Link href={`/workspaces/${workspaceId}/knowledge-packs/${pack.publicId}`}>Open</Link>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Knowledge Packs"
        description="Manage the intelligence, brand, SEO and prompt context MYEV Media uses."
        actions={
          canCreate ? (
            <Button href={newHref} iconLeft={<PlusIcon />}>
              New Knowledge Pack
            </Button>
          ) : undefined
        }
      />

      {error && <ErrorBanner message={error} onRetry={load} />}
      {!error && packs === null && <LoadingState label="Loading Knowledge Packs…" />}
      {!error && packs !== null && packs.length === 0 && (
        <EmptyState
          icon={<KnowledgePackIcon />}
          title="No Knowledge Packs yet"
          description="A Knowledge Pack holds the trusted sources, prompt templates, brand rules and SEO context your content agents use."
          action={
            canCreate ? (
              <Button href={newHref} iconLeft={<PlusIcon />}>
                Create the first one
              </Button>
            ) : undefined
          }
        />
      )}
      {!error && packs !== null && packs.length > 0 && (
        <DataTable columns={columns} rows={packs} rowKey={(p) => p.publicId} caption="Knowledge Packs" />
      )}
    </div>
  );
}
