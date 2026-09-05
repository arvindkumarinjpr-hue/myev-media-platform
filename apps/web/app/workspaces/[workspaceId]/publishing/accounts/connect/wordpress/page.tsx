"use client";

import { use } from "react";
import { ConnectWordPressForm } from "../../../../../../../components/publishing/ConnectWordPressForm";

export default function ConnectWordPressPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return <ConnectWordPressForm workspaceId={workspaceId} />;
}
