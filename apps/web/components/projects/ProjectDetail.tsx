"use client";

import { useCallback, useEffect, useState } from "react";
import { projectsApi } from "../../lib/api/projects";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackSummary, ProjectSummary } from "../../lib/types";
import { LoadingState, ErrorBanner } from "../ui/Feedback";
import styles from "./ProjectDetail.module.css";

const UNASSIGNED = "__unassigned__";

export function ProjectDetail({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const { permissions } = useSession();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [activePacks, setActivePacks] = useState<KnowledgePackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string>(UNASSIGNED);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canAssign = hasPermission(permissions, "PROJECT_UPDATE");

  const load = useCallback(() => {
    setError(null);
    Promise.all([projectsApi.get(workspaceId, projectId), knowledgePacksApi.list(workspaceId)])
      .then(([loadedProject, packs]) => {
        setProject(loadedProject);
        setActivePacks(packs.filter((p) => p.status === "ACTIVE"));
        setSelection(loadedProject.knowledgePackPublicId ?? UNASSIGNED);
      })
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, projectId]);

  useEffect(load, [load]);

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!project || !activePacks) return <LoadingState label="Loading Project…" />;

  async function handleSave() {
    if (pending) return;
    setPending(true);
    setSaveError(null);
    try {
      const updated = await projectsApi.assignKnowledgePack(workspaceId, projectId, selection === UNASSIGNED ? null : selection);
      setProject(updated);
    } catch (err) {
      setSaveError(friendlyMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <h1>{project.name}</h1>

      <div className={styles.panel}>
        <h2 className={styles.heading}>Assigned Knowledge Pack</h2>
        <p className={styles.description}>
          The exact Knowledge Pack version this Project uses. Never changes automatically — a blocked Knowledge Pack activation always requires reassigning it here explicitly.
        </p>
        {saveError && <ErrorBanner message={saveError} />}
        <label htmlFor="kp-assignment" className={styles.label}>
          Currently assigned
        </label>
        <select id="kp-assignment" value={selection} onChange={(e) => setSelection(e.target.value)} disabled={!canAssign} className={styles.select}>
          <option value={UNASSIGNED}>Unassigned</option>
          {activePacks.map((pack) => (
            <option key={pack.publicId} value={pack.publicId}>
              {pack.name} (v{pack.versionNumber})
            </option>
          ))}
        </select>
        {canAssign && (
          <button type="button" onClick={handleSave} disabled={pending || selection === (project.knowledgePackPublicId ?? UNASSIGNED)} className={styles.saveButton}>
            {pending ? "Saving…" : "Save assignment"}
          </button>
        )}
      </div>
    </div>
  );
}
