"use client";

import { use } from "react";
import { CreateSocialPostFlow } from "../../../../../components/social/CreateSocialPostFlow";

export default function NewSocialPostPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <CreateSocialPostFlow workspaceId={workspaceId} />;
}
