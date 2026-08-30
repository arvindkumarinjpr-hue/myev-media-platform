"use client";

import { use } from "react";
import { VideoPipelineDetail } from "../../../../../components/video/VideoPipelineDetail";

export default function VideoDetailPage({ params }: { params: Promise<{ workspaceId: string; itemId: string }> }) {
  const { workspaceId, itemId } = use(params);
  return <VideoPipelineDetail workspaceId={workspaceId} itemId={itemId} />;
}
