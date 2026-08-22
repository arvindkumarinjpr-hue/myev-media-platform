"use client";

import { useState } from "react";
import { knowledgePacksApi, type UpdateKnowledgePackInput } from "../../lib/api/knowledge-packs";
import { friendlyMessage, isStaleLockConflict } from "../../lib/errors";
import type { KnowledgePackDetail } from "../../lib/types";
import { ErrorBanner } from "../ui/Feedback";
import { JsonField } from "./JsonField";
import { SourcesSection } from "./sections/SourcesSection";
import { PromptTemplatesSection } from "./sections/PromptTemplatesSection";
import { KeywordSetsSection } from "./sections/KeywordSetsSection";
import { CompetitorsSection } from "./sections/CompetitorsSection";
import { BrandGuidelinesSection } from "./sections/BrandGuidelinesSection";
import { SeoRulesSection } from "./sections/SeoRulesSection";
import styles from "./ConfigurationEditor.module.css";

interface EditableState {
  name: string;
  industryProfile: Record<string, unknown>;
  publishingStrategy: Record<string, unknown>;
  sources: UpdateKnowledgePackInput["sources"];
  promptTemplates: UpdateKnowledgePackInput["promptTemplates"];
  seoRules: UpdateKnowledgePackInput["seoRules"];
  brandGuidelines: UpdateKnowledgePackInput["brandGuidelines"];
  keywordSets: UpdateKnowledgePackInput["keywordSets"];
  competitors: UpdateKnowledgePackInput["competitors"];
}

function toEditableState(pack: KnowledgePackDetail): EditableState {
  return {
    name: pack.name,
    industryProfile: pack.industryProfile,
    publishingStrategy: pack.publishingStrategy,
    sources: pack.sources,
    promptTemplates: pack.promptTemplates.map((t) => ({ contentType: t.contentType, promptBody: t.promptBody })),
    seoRules: pack.seoRules,
    brandGuidelines: pack.brandGuidelines.map((b) => ({ toneOfVoice: b.toneOfVoice, ctaRules: b.ctaRules, logoAssetId: b.logoAssetId, terminology: b.terminology })),
    keywordSets: pack.keywordSets,
    competitors: pack.competitors,
  };
}

export function ConfigurationEditor({
  workspaceId,
  pack,
  editable,
  onSaved,
}: {
  workspaceId: string;
  pack: KnowledgePackDetail;
  editable: boolean;
  onSaved: (pack: KnowledgePackDetail) => void;
}) {
  const [state, setState] = useState<EditableState>(() => toEditableState(pack));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  function update<K extends keyof EditableState>(key: K, value: EditableState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (pending) return;
    setPending(true);
    setError(null);
    setConflict(false);
    try {
      const updated = await knowledgePacksApi.update(workspaceId, pack.publicId, { expectedLockVersion: pack.lockVersion, ...state });
      onSaved(updated);
      setState(toEditableState(updated));
    } catch (err) {
      if (isStaleLockConflict(err)) {
        setConflict(true);
      } else {
        setError(friendlyMessage(err));
      }
    } finally {
      setPending(false);
    }
  }

  async function handleReload() {
    const fresh = await knowledgePacksApi.get(workspaceId, pack.publicId);
    onSaved(fresh);
    setState(toEditableState(fresh));
    setConflict(false);
  }

  return (
    <div className={styles.container}>
      {conflict && (
        <div role="alert" className={styles.conflict}>
          <p>This Knowledge Pack was changed elsewhere since you loaded it. Your edits here haven&apos;t been saved.</p>
          <button type="button" onClick={handleReload} className={styles.reloadButton}>
            Reload latest and discard my changes
          </button>
        </div>
      )}
      {error && <ErrorBanner message={error} />}

      <label htmlFor="kp-edit-name" className={styles.label}>
        Name
      </label>
      <input id="kp-edit-name" value={state.name} onChange={(e) => update("name", e.target.value)} readOnly={!editable} className={styles.input} />

      <JsonField id="kp-industry-profile" label="Industry profile" value={state.industryProfile} onChange={(v) => update("industryProfile", v)} readOnly={!editable} />
      <JsonField id="kp-publishing-strategy" label="Publishing strategy" value={state.publishingStrategy} onChange={(v) => update("publishingStrategy", v)} readOnly={!editable} />

      <SourcesSection value={state.sources ?? []} onChange={(v) => update("sources", v)} readOnly={!editable} />
      <PromptTemplatesSection value={state.promptTemplates ?? []} onChange={(v) => update("promptTemplates", v)} readOnly={!editable} />
      <SeoRulesSection value={state.seoRules ?? []} onChange={(v) => update("seoRules", v)} readOnly={!editable} />
      <BrandGuidelinesSection value={state.brandGuidelines ?? []} onChange={(v) => update("brandGuidelines", v)} readOnly={!editable} />
      <KeywordSetsSection value={state.keywordSets ?? []} onChange={(v) => update("keywordSets", v)} readOnly={!editable} />
      <CompetitorsSection value={state.competitors ?? []} onChange={(v) => update("competitors", v)} readOnly={!editable} />

      {editable && (
        <button type="button" onClick={handleSave} disabled={pending} className={styles.saveButton}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      )}
      {!editable && <p className={styles.readOnlyNote}>Only a Draft version can be edited. {pack.status === "ACTIVE" ? "Create a new version to make changes." : "This version is Archived."}</p>}
    </div>
  );
}
