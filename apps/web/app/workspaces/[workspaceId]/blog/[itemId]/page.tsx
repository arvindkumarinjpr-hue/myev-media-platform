"use client";

import { use } from "react";
import { BlogPipelineDetail } from "../../../../../components/blog/BlogPipelineDetail";

export default function BlogDetailPage({ params }: { params: Promise<{ workspaceId: string; itemId: string }> }) {
  const { workspaceId, itemId } = use(params);
  return <BlogPipelineDetail workspaceId={workspaceId} itemId={itemId} />;
}
