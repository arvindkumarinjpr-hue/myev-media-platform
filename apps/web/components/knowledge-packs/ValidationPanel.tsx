"use client";

import { useState } from "react";
import Link from "next/link";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { ApiError, friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackDetail } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { CheckIcon } from "../ui/icons";
import { toReadableFailure } from "./validationLabels";
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

  const readable = failures?.map(toReadableFailure) ?? [];
  const hasRestrict = readable.some((f) => f.isRestrict);

  return (
    <section className={styles.panel} aria-label="Validate and activate">
      <div className={styles.head}>
        <div>
          <p className={styles.title}>Ready to go live?</p>
          <p className={styles.subtitle}>
            Validation checks trusted sources, prompt coverage, industry profile and publishing strategy, then makes this the
            active context.
          </p>
        </div>
        <Button onClick={handleValidate} loading={pending} iconLeft={<CheckIcon />}>
          Validate
        </Button>
      </div>

      {genericError && <Alert tone="danger">{genericError}</Alert>}

      {failures && (
        <div className={styles.result} role="alert">
          <p className={styles.resultHeading}>This version isn&apos;t ready to activate yet</p>
          <ul className={styles.failureList}>
            {readable.map((failure, i) => (
              // eslint-disable-next-line react/no-array-index-key -- server-ordered strings, no id.
              <li key={i}>
                <span className={styles.failureTitle}>{failure.title}</span>
                {failure.help && <span className={styles.failureHelp}>{failure.help}</span>}
                <span className={styles.failureRaw}>{failure.raw}</span>
              </li>
            ))}
          </ul>
          {hasRestrict && (
            <p className={styles.restrictLink}>
              <Link href={`/workspaces/${workspaceId}/projects`}>Manage Project assignments</Link> to free up the blocked
              version.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
