"use client";

import { use } from "react";
import { CreateResearchForm } from "../../../../../components/research/CreateResearchForm";

export default function NewResearchPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <div>
      <h1>New Research</h1>
      <CreateResearchForm workspaceId={workspaceId} />
    </div>
  );
}
