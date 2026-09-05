"use client";

import { use } from "react";
import { PublicationDetail } from "../../../../../../components/publishing/PublicationDetail";

export default function PublicationDetailPage({ params }: { params: Promise<{ workspaceId: string; publicationId: string }> }) {
  const { workspaceId, publicationId } = use(params);
  return <PublicationDetail workspaceId={workspaceId} publicationId={publicationId} />;
}
