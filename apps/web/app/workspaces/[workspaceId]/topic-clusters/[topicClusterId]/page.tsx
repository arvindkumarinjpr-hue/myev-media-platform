"use client";

import { use } from "react";
import { TopicClusterDetail } from "../../../../../components/topic-clusters/TopicClusterDetail";

export default function TopicClusterDetailPage({ params }: { params: Promise<{ workspaceId: string; topicClusterId: string }> }) {
  const { workspaceId, topicClusterId } = use(params);
  return <TopicClusterDetail workspaceId={workspaceId} topicClusterId={topicClusterId} />;
}
