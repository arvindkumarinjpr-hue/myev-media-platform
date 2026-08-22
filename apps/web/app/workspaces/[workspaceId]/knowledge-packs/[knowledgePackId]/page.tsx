"use client";

import { use } from "react";
import { KnowledgePackDetail } from "../../../../../components/knowledge-packs/KnowledgePackDetail";

export default function KnowledgePackDetailPage({ params }: { params: Promise<{ workspaceId: string; knowledgePackId: string }> }) {
  const { workspaceId, knowledgePackId } = use(params);
  return <KnowledgePackDetail workspaceId={workspaceId} knowledgePackId={knowledgePackId} />;
}
