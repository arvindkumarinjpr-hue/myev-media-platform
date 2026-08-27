"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";
import styles from "./CreateKnowledgePackForm.module.css";

export function CreateKnowledgePackForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      // Only the name is needed to create the Draft — sources, prompt
      // templates, brand and SEO context are all filled in afterwards in
      // the editor, and checked when you validate.
      const pack = await knowledgePacksApi.create(workspaceId, { name: name.trim() });
      router.push(`/workspaces/${workspaceId}/knowledge-packs/${pack.publicId}`);
    } catch (err) {
      setError(friendlyMessage(err));
      setPending(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="New Knowledge Pack"
        description="Give it a name to get started — you'll add sources, prompts and brand rules next."
        eyebrow={
          <a href={`/workspaces/${workspaceId}/knowledge-packs`} className={styles.back}>
            ← Back to Knowledge Packs
          </a>
        }
      />

      <Card>
        <form onSubmit={handleSubmit} className={styles.form} aria-label="Create Knowledge Pack">
          {error && <Alert tone="danger">{error}</Alert>}

          <FormField label="Name" hint="A clear label your team will recognise, e.g. “EV Buyer Content Pack”.">
            {(field) => (
              <Input
                {...field}
                required
                autoFocus
                value={name}
                maxLength={200}
                placeholder="EV Buyer Content Pack"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>

          <div className={styles.actions}>
            <Button href={`/workspaces/${workspaceId}/knowledge-packs`} variant="ghost">
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={!name.trim()}>
              Create Draft
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
