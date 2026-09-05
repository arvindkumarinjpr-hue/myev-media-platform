"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { publishingApi } from "../../lib/api/publishing";
import { ApiError, friendlyMessage } from "../../lib/errors";
import type { MetaDiscoveredPage } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card, CardBody } from "../ui/Card";
import { LoadingState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import styles from "./MetaAccountSelection.module.css";

interface Selection {
  connectFacebook: boolean;
  connectInstagram: boolean;
}

/**
 * Module 9 Phase 9.7 (Part H) — the post-OAuth-callback landing page:
 * shows every Facebook Page the operator's Meta account can manage, and
 * (where eligible) its linked Instagram professional account, and lets
 * the operator choose which of each to actually connect. A personal
 * (non-Business/Creator) Instagram account is never offered as
 * selectable (Part H: "do not assume ordinary Instagram personal
 * accounts are publishable").
 */
export function MetaAccountSelection({ workspaceId, discoveryToken }: { workspaceId: string; discoveryToken: string }) {
  const router = useRouter();
  const [pages, setPages] = useState<MetaDiscoveredPage[] | null>(null);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    publishingApi.oauth
      .getMetaDiscovery(workspaceId, discoveryToken)
      .then((result) => {
        setPages(result);
        setSelections(Object.fromEntries(result.map((p) => [p.pageId, { connectFacebook: true, connectInstagram: p.instagramEligible }])));
      })
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, discoveryToken]);

  const backHref = `/workspaces/${workspaceId}/publishing/accounts`;
  const anySelected = Object.values(selections).some((s) => s.connectFacebook || s.connectInstagram);

  function toggle(pageId: string, key: keyof Selection) {
    setSelections((prev) => ({ ...prev, [pageId]: { ...prev[pageId], [key]: !prev[pageId][key] } }));
  }

  async function handleSubmit() {
    if (pending || !anySelected) return;
    setPending(true);
    setError(null);
    try {
      const payload = Object.entries(selections)
        .filter(([, s]) => s.connectFacebook || s.connectInstagram)
        .map(([pageId, s]) => ({ pageId, ...s }));
      await publishingApi.oauth.finalizeMeta(workspaceId, { discoveryToken, selections: payload });
      router.push(backHref);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : friendlyMessage(err));
      setPending(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="Select Meta Accounts"
        description="Choose which Facebook Page and linked Instagram account to connect for publishing."
        eyebrow={
          <a href={backHref} className={styles.back}>
            ← Back to Channel Accounts
          </a>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {pages === null && !error && <LoadingState label="Loading discovered accounts…" />}

      {pages !== null && pages.length === 0 && (
        <Alert tone="warning" title="No manageable Pages found">
          The Meta account you authorized does not administer any Facebook Pages. Connect a different account, or grant Page access first.
        </Alert>
      )}

      {pages !== null && pages.length > 0 && (
        <div className={styles.list}>
          {pages.map((page) => {
            const selection = selections[page.pageId] ?? { connectFacebook: false, connectInstagram: false };
            return (
              <Card key={page.pageId}>
                <CardBody className={styles.cardBody}>
                  <div className={styles.pageName}>{page.pageName}</div>
                  <label className={styles.option}>
                    <input type="checkbox" checked={selection.connectFacebook} onChange={() => toggle(page.pageId, "connectFacebook")} />
                    Connect as Facebook Page
                  </label>
                  {page.instagramBusinessAccountId ? (
                    <label className={styles.option} aria-disabled={!page.instagramEligible}>
                      <input type="checkbox" checked={selection.connectInstagram} disabled={!page.instagramEligible} onChange={() => toggle(page.pageId, "connectInstagram")} />
                      Connect linked Instagram {page.instagramUsername ? `@${page.instagramUsername}` : "account"}
                      {!page.instagramEligible && <span className={styles.ineligible}> — not a Business/Creator account, cannot be connected</span>}
                    </label>
                  ) : (
                    <p className={styles.noInstagram}>No Instagram account is linked to this Page.</p>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {pages !== null && pages.length > 0 && (
        <div className={styles.actions}>
          <Button href={backHref} variant="ghost">
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={pending} disabled={!anySelected}>
            Connect Selected
          </Button>
        </div>
      )}
    </div>
  );
}
