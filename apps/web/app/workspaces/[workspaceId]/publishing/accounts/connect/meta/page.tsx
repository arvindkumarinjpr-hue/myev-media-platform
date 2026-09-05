"use client";

import { use, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { MetaAccountSelection } from "../../../../../../../components/publishing/MetaAccountSelection";
import { Alert } from "../../../../../../../components/ui/Alert";

function MetaAccountSelectionGate({ workspaceId }: { workspaceId: string }) {
  const params = useSearchParams();
  const discoveryToken = params.get("discoveryToken");
  if (!discoveryToken) {
    return <Alert tone="danger">Missing discovery token. Start the connection again from Channel Accounts.</Alert>;
  }
  return <MetaAccountSelection workspaceId={workspaceId} discoveryToken={discoveryToken} />;
}

export default function ConnectMetaPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <Suspense fallback={null}>
      <MetaAccountSelectionGate workspaceId={workspaceId} />
    </Suspense>
  );
}
