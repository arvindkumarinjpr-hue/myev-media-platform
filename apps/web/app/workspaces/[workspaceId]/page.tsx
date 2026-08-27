"use client";

import { use } from "react";
import { WorkspaceOverview } from "../../../components/workspace/WorkspaceOverview";

export default function WorkspaceOverviewPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <WorkspaceOverview workspaceId={workspaceId} />;
}
