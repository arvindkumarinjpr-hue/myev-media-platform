"use client";

import { use } from "react";
import { ProjectDetail } from "../../../../../components/projects/ProjectDetail";

export default function ProjectDetailPage({ params }: { params: Promise<{ workspaceId: string; projectId: string }> }) {
  const { workspaceId, projectId } = use(params);
  return <ProjectDetail workspaceId={workspaceId} projectId={projectId} />;
}
