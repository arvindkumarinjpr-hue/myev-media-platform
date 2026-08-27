"use client";

import { use } from "react";
import { TopicClusterList } from "../../../../components/topic-clusters/TopicClusterList";

export default function TopicClustersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <TopicClusterList workspaceId={workspaceId} />;
}
