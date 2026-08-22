import { serverGet } from "../../../lib/server-api";
import type { WorkspaceDetail } from "../../../lib/types";
import { SessionProvider } from "../../../contexts/session-context";
import { AppNav } from "../../../components/AppNav";
import styles from "./layout.module.css";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, permissionsResult] = await Promise.all([
    serverGet<WorkspaceDetail>(`workspaces/${workspaceId}`),
    serverGet<{ permissions: string[] }>(`workspaces/${workspaceId}/permissions/me`),
  ]);

  return (
    <SessionProvider value={{ workspace, permissions: permissionsResult.permissions }}>
      <div className={styles.shell}>
        <AppNav workspaceId={workspaceId} workspaceName={workspace.name} />
        <div className={styles.content}>{children}</div>
      </div>
    </SessionProvider>
  );
}
