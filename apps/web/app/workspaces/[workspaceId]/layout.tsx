import { serverGet } from "../../../lib/server-api";
import type { WorkspaceDetail } from "../../../lib/types";
import { SessionProvider } from "../../../contexts/session-context";
import { AppShell } from "../../../components/shell/AppShell";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, permissionsResult] = await Promise.all([
    serverGet<WorkspaceDetail>(`workspaces/${workspaceId}`),
    serverGet<{ permissions: string[] }>(`workspaces/${workspaceId}/permissions/me`),
  ]);

  return (
    <SessionProvider value={{ workspace, permissions: permissionsResult.permissions }}>
      <AppShell
        workspaceId={workspaceId}
        workspaceName={workspace.name}
        role={workspace.myRole}
        permissions={permissionsResult.permissions}
      >
        {children}
      </AppShell>
    </SessionProvider>
  );
}
