"use client";

import { use } from "react";
import { PublicationsList } from "../../../../components/publishing/PublicationsList";

export default function PublishingPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <PublicationsList workspaceId={workspaceId} />;
}
