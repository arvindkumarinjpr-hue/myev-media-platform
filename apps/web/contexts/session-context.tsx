"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceDetail } from "../lib/types";

export interface SessionValue {
  workspace: WorkspaceDetail;
  permissions: string[];
}

const SessionContext = createContext<SessionValue | null>(null);

/** Populated once, server-side, by the workspace layout — every Client Component under it reads workspace/permission context from here instead of re-fetching. */
export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession() must be used within a SessionProvider (i.e. under app/workspaces/[workspaceId]/layout.tsx).");
  }
  return value;
}
