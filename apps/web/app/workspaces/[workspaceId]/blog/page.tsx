"use client";

import { use } from "react";
import { BlogList } from "../../../../components/blog/BlogList";

export default function BlogPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <BlogList workspaceId={workspaceId} />;
}
