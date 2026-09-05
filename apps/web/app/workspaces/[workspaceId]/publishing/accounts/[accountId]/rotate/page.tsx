"use client";

import { use } from "react";
import { ConnectWordPressForm } from "../../../../../../../components/publishing/ConnectWordPressForm";

export default function RotateWordPressCredentialPage({ params }: { params: Promise<{ workspaceId: string; accountId: string }> }) {
  const { workspaceId, accountId } = use(params);
  return <ConnectWordPressForm workspaceId={workspaceId} accountId={accountId} />;
}
