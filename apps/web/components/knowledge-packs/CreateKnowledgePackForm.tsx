"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { ErrorBanner } from "../ui/Feedback";
import styles from "./CreateKnowledgePackForm.module.css";

export function CreateKnowledgePackForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      // Only the name is required at creation — every other section
      // (sources, prompt templates, brand guidelines, etc.) is filled in
      // afterward in the editor. The backend itself has no "complete
      // before creation" requirement (that's what validate/activate is
      // for), so this form doesn't invent one either.
      const pack = await knowledgePacksApi.create(workspaceId, { name });
      router.push(`/workspaces/${workspaceId}/knowledge-packs/${pack.publicId}`);
    } catch (err) {
      setError(friendlyMessage(err));
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form} aria-label="Create Knowledge Pack">
      {error && <ErrorBanner message={error} />}
      <label htmlFor="kp-name" className={styles.label}>
        Name
      </label>
      <input id="kp-name" required value={name} onChange={(e) => setName(e.target.value)} className={styles.input} placeholder="e.g. EV Buyer Content Pack" />
      <button type="submit" disabled={pending || !name.trim()} className={styles.submitButton}>
        {pending ? "Creating…" : "Create Draft"}
      </button>
    </form>
  );
}
