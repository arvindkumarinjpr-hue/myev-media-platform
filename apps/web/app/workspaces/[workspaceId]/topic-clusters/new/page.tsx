"use client";

import { use } from "react";
import { CreateTopicClusterForm } from "../../../../../components/topic-clusters/CreateTopicClusterForm";

export default function NewTopicClusterPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <div>
      <h1>New Topic Cluster</h1>
      <CreateTopicClusterForm workspaceId={workspaceId} />
    </div>
  );
}
