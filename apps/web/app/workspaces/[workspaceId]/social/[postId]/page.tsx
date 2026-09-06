"use client";

import { use } from "react";
import { SocialPostDetail } from "../../../../../components/social/SocialPostDetail";

export default function SocialPostDetailPage({ params }: { params: Promise<{ workspaceId: string; postId: string }> }) {
  const { workspaceId, postId } = use(params);
  return <SocialPostDetail workspaceId={workspaceId} itemId={postId} />;
}
