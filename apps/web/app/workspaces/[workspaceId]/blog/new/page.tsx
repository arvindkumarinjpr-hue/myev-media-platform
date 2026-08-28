"use client";

import { use } from "react";
import { CreateBlogForm } from "../../../../../components/blog/CreateBlogForm";

export default function NewBlogPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <CreateBlogForm workspaceId={workspaceId} />;
}
