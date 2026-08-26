"use client";

import { use } from "react";
import { ResearchDetail } from "../../../../../components/research/ResearchDetail";

export default function ResearchDetailPage({ params }: { params: Promise<{ workspaceId: string; researchId: string }> }) {
  const { workspaceId, researchId } = use(params);
  return <ResearchDetail workspaceId={workspaceId} researchId={researchId} />;
}
