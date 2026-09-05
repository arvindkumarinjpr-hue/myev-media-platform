"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { publishingApi } from "../../lib/api/publishing";
import { ApiError, friendlyMessage } from "../../lib/errors";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";
import styles from "./ConnectWordPressForm.module.css";

interface Props {
  workspaceId: string;
  /** Present only when rotating an EXISTING account's credential (Part F/AA) — connect (no accountId) creates a new one. */
  accountId?: string;
}

/**
 * Module 9 Phase 9.7 (Part F) — a write-only credential form: the
 * Application Password field is NEVER pre-filled (there is nothing to
 * pre-fill — the server never returns it) and is cleared from local
 * state the instant the request resolves either way.
 */
export function ConnectWordPressForm({ workspaceId, accountId }: Props) {
  const router = useRouter();
  const isRotation = !!accountId;
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [applicationPassword, setApplicationPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const backHref = `/workspaces/${workspaceId}/publishing/accounts`;
  const canSubmit = siteUrl.trim() && username.trim() && applicationPassword.trim() && (isRotation || displayName.trim());

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setError(null);
    try {
      if (isRotation) {
        await publishingApi.accounts.rotateWordPress(workspaceId, accountId!, { siteUrl: siteUrl.trim(), username: username.trim(), applicationPassword });
      } else {
        await publishingApi.accounts.connectWordPress(workspaceId, { siteUrl: siteUrl.trim(), username: username.trim(), applicationPassword, displayName: displayName.trim() });
      }
      router.push(backHref);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : friendlyMessage(err));
      setApplicationPassword("");
      setPending(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <PageHeader
        title={isRotation ? "Update WordPress Credential" : "Connect WordPress"}
        description={
          isRotation
            ? "Enter the new Application Password. It replaces the stored credential only after it validates successfully against the site."
            : "Uses WordPress's own Application Passwords feature — never your account password. The site is validated before anything is saved."
        }
        eyebrow={
          <a href={backHref} className={styles.back}>
            ← Back to Channel Accounts
          </a>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <form onSubmit={handleSubmit} className={styles.form} aria-label={isRotation ? "Update WordPress credential" : "Connect WordPress"}>
          <FormField label="Site URL" hint="Include the protocol, e.g. https://example.com">
            {(field) => <Input {...field} type="url" required autoFocus value={siteUrl} placeholder="https://example.com" onChange={(e) => setSiteUrl(e.target.value)} />}
          </FormField>

          <FormField label="Username">{(field) => <Input {...field} required value={username} onChange={(e) => setUsername(e.target.value)} />}</FormField>

          <FormField label="Application Password" hint="Generate one under Users → Profile → Application Passwords on the WordPress site.">
            {(field) => <Input {...field} type="password" required autoComplete="new-password" value={applicationPassword} onChange={(e) => setApplicationPassword(e.target.value)} />}
          </FormField>

          {!isRotation && (
            <FormField label="Display name" hint="How this account appears in MYEV.">
              {(field) => <Input {...field} required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
            </FormField>
          )}

          <div className={styles.actions}>
            <Button href={backHref} variant="ghost">
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={!canSubmit}>
              {isRotation ? "Update Credential" : "Connect"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
