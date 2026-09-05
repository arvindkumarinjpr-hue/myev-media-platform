"use client";

import { use } from "react";
import { PublishFlow } from "../../../../../../components/publishing/PublishFlow";

export default function NewPublicationPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <PublishFlow workspaceId={workspaceId} />;
}
