"use client";

import { use } from "react";
import { SocialList } from "../../../../components/social/SocialList";

export default function SocialPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <SocialList workspaceId={workspaceId} />;
}
