"use client";

import { use } from "react";
import { CreateKnowledgePackForm } from "../../../../../components/knowledge-packs/CreateKnowledgePackForm";

export default function NewKnowledgePackPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <CreateKnowledgePackForm workspaceId={workspaceId} />;
}
