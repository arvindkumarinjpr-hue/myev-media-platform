"use client";

import { use } from "react";
import { KnowledgePackList } from "../../../../components/knowledge-packs/KnowledgePackList";

export default function KnowledgePacksPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <KnowledgePackList workspaceId={workspaceId} />;
}
