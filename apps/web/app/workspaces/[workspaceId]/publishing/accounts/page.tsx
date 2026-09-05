"use client";

import { use } from "react";
import { ChannelAccountsList } from "../../../../../components/publishing/ChannelAccountsList";

export default function PublishingAccountsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <ChannelAccountsList workspaceId={workspaceId} />;
}
