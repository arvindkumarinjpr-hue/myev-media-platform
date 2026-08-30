"use client";

import { use } from "react";
import { CreateVideoForm } from "../../../../../components/video/CreateVideoForm";

export default function NewVideoPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <CreateVideoForm workspaceId={workspaceId} />;
}
