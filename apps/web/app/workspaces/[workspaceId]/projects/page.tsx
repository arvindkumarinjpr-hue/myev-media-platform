"use client";

import { use } from "react";
import { ProjectList } from "../../../../components/projects/ProjectList";

export default function ProjectsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <ProjectList workspaceId={workspaceId} />;
}
