"use client";

import { use } from "react";
import { VideoList } from "../../../../components/video/VideoList";

export default function VideoPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <VideoList workspaceId={workspaceId} />;
}
