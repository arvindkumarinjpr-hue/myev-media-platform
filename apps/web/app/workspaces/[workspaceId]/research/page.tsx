"use client";

import { use } from "react";
import { ResearchList } from "../../../../components/research/ResearchList";

export default function ResearchPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <ResearchList workspaceId={workspaceId} />;
}
