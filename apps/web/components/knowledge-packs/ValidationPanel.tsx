"use client";

import { useState } from "react";
import Link from "next/link";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { ApiError, friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackDetail } from "../../lib/types";
import { ErrorBanner } from "../ui/Feedback";
import styles from "./ValidationPanel.module.css";

export function ValidationPanel({
  workspaceId,
  knowledgePackId,
  onActivated,
}: {
  workspaceId: string;
  knowledgePackId: string;
  onActivated: (pack: KnowledgePackDetail) => void;
}) {
  const { permissions } = useSession();
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<string[] | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);

  if (!hasPermission(permissions, "KP_VALIDATE")) return null;

  async function handleValidate() {
    if (pending) return;
    setPending(true);
    setFailures(null);
    setGenericError(null);
    try {
      const pack = await knowledgePacksApi.validate(workspaceId, knowledgePackId);
      onActivated(pack);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.code === "KNOWLEDGE_VALIDATION_FAILED") {
        setFailures(err.details ?? [err.message]);
      } else {
        setGenericError(friendlyMessage(err));
      }
    } finally {
      setPending(false);
    }
  }

  const hasRestrictFailure = failures?.some((f) => /RESTRICT/i.test(f)) ?? false;

  return (
    <div className={styles.panel}>
      <h3 className={styles.heading}>Validate &amp; activate</h3>
      <p className={styles.description}>Checks trusted sources, prompt template coverage, brand/industry profile, and publishing strategy, then activates this version if everything passes.</p>
      <button type="button" onClick={handleValidate} disabled={pending} className={styles.button}>
        {pending ? "Validating…" : "Validate"}
      </button>

      {genericError && <ErrorBanner message={genericError} />}

      {failures && (
        <div role="alert" className={styles.failures}>
          <p className={styles.failuresHeading}>This version can&apos;t activate yet:</p>
          <ul>
            {failures.map((failure, index) => (
              // eslint-disable-next-line react/no-array-index-key -- server-generated itemized strings, no stable id.
              <li key={index}>{failure}</li>
            ))}
          </ul>
          {hasRestrictFailure && (
            <p>
              <Link href={`/workspaces/${workspaceId}/projects`}>Manage Project assignments</Link> to free up the blocked predecessor.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
