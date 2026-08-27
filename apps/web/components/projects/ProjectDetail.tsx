"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { projectsApi } from "../../lib/api/projects";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackSummary, ProjectSummary } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormField } from "../ui/FormField";
import { LoadingState } from "../ui/Feedback";
import { Select } from "../ui/Select";
import { StatusBadge } from "../ui/StatusBadge";
import { ChevronRightIcon, KnowledgePackIcon } from "../ui/icons";
import styles from "./ProjectDetail.module.css";

const UNASSIGNED = "__unassigned__";

function projectStatusTone(status: string): "success" | "info" | "neutral" {
  if (status === "ACTIVE") return "success";
  if (status === "ARCHIVED") return "info";
  return "neutral";
}

export function ProjectDetail({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const { permissions } = useSession();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [activePacks, setActivePacks] = useState<KnowledgePackSummary[] | null>(null);
  // The assigned pack may not be in the Active list (e.g. it was later
  // archived) — resolved separately so "currently assigned" never goes
  // blank just because it fell out of the assignable set.
  const [assignedPack, setAssignedPack] = useState<KnowledgePackSummary | null>(null);
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
        const inActiveList = packs.find((p) => p.publicId === loadedProject.knowledgePackPublicId);
        if (inActiveList) {
          setAssignedPack(inActiveList);
        } else if (loadedProject.knowledgePackPublicId) {
          knowledgePacksApi
            .get(workspaceId, loadedProject.knowledgePackPublicId)
            .then((full) => setAssignedPack({ publicId: full.publicId, name: full.name, status: full.status, versionNumber: full.versionNumber }))
            .catch(() => setAssignedPack(null));
        } else {
          setAssignedPack(null);
        }
      })
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, projectId]);

  useEffect(load, [load]);

  if (error)
    return (
      <Alert tone="danger" action={<Button size="sm" variant="secondary" onClick={load}>Retry</Button>}>
        {error}
      </Alert>
    );
  if (!project || !activePacks) return <LoadingState label="Loading Project…" />;

  async function handleSave() {
    if (pending) return;
    setPending(true);
    setSaveError(null);
    try {
      const updated = await projectsApi.assignKnowledgePack(workspaceId, projectId, selection === UNASSIGNED ? null : selection);
      setProject(updated);
      // The new assignment can only be Unassigned or one of the already-
      // loaded Active packs (that's the whole option list) — resolve it
      // from there rather than re-fetching everything.
      setAssignedPack(updated.knowledgePackPublicId ? (activePacks ?? []).find((p) => p.publicId === updated.knowledgePackPublicId) ?? null : null);
    } catch (err) {
      setSaveError(friendlyMessage(err));
    } finally {
      setPending(false);
    }
  }

  const dirty = selection !== (project.knowledgePackPublicId ?? UNASSIGNED);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href={`/workspaces/${workspaceId}/projects`}>Projects</Link>
          <ChevronRightIcon className={styles.sep} />
          <span aria-current="page">{project.name}</span>
        </nav>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{project.name}</h1>
          <Badge tone={projectStatusTone(project.status)}>{project.status}</Badge>
        </div>
      </header>

      <Card>
        <h2 className={styles.sectionTitle}>Assigned Knowledge Pack</h2>
        <p className={styles.description}>
          The exact Knowledge Pack version this Project uses to generate content. It never changes automatically — if a
          Knowledge Pack activation is blocked because this Project still references it, reassigning it here is what
          resolves that.
        </p>

        {project.knowledgePackPublicId && (
          <p className={styles.current}>
            <KnowledgePackIcon className={styles.currentIcon} />
            {assignedPack ? (
              <>
                <Link href={`/workspaces/${workspaceId}/knowledge-packs/${assignedPack.publicId}`}>
                  {assignedPack.name} (v{assignedPack.versionNumber})
                </Link>
                <StatusBadge status={assignedPack.status} />
              </>
            ) : (
              <span>{project.knowledgePackPublicId}</span>
            )}
          </p>
        )}

        {saveError && <Alert tone="danger">{saveError}</Alert>}

        <FormField label="Currently assigned" hint="Only Active, same-workspace Knowledge Packs can be assigned.">
          {(field) => (
            <Select {...field} value={selection} disabled={!canAssign} onChange={(e) => setSelection(e.target.value)}>
              <option value={UNASSIGNED}>Unassigned</option>
              {activePacks.map((pack) => (
                <option key={pack.publicId} value={pack.publicId}>
                  {pack.name} (v{pack.versionNumber})
                </option>
              ))}
            </Select>
          )}
        </FormField>

        {canAssign && (
          <div className={styles.actions}>
            <Button onClick={handleSave} loading={pending} disabled={!dirty}>
              Save assignment
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
