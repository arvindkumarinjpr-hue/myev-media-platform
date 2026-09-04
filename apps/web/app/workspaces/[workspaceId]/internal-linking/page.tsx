"use client";

import { use } from "react";
import { InternalLinkingWorkspace } from "../../../../components/internal-linking/InternalLinkingWorkspace";

export default function InternalLinkingPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <InternalLinkingWorkspace workspaceId={workspaceId} />;
}
