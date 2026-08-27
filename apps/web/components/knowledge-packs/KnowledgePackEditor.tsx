"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { knowledgePacksApi, type UpdateKnowledgePackInput } from "../../lib/api/knowledge-packs";
import { friendlyMessage, isStaleLockConflict } from "../../lib/errors";
import type { KnowledgePackDetail, KnowledgePackStatus } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Tabs, tabPanelProps, type TabItem } from "../ui/Tabs";
import { OverviewSection } from "./sections/OverviewSection";
import { TrustedSourcesSection } from "./sections/TrustedSourcesSection";
import { PromptTemplatesSection } from "./sections/PromptTemplatesSection";
import { BrandGuidelinesSection } from "./sections/BrandGuidelinesSection";
import { SeoRulesSection } from "./sections/SeoRulesSection";
import { KeywordSetsSection } from "./sections/KeywordSetsSection";
import { CompetitorsSection } from "./sections/CompetitorsSection";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import styles from "./KnowledgePackEditor.module.css";

interface EditableState {
  name: string;
  industryProfile: Record<string, unknown>;
  publishingStrategy: Record<string, unknown>;
  sources: NonNullable<UpdateKnowledgePackInput["sources"]>;
  promptTemplates: NonNullable<UpdateKnowledgePackInput["promptTemplates"]>;
  seoRules: NonNullable<UpdateKnowledgePackInput["seoRules"]>;
  brandGuidelines: NonNullable<UpdateKnowledgePackInput["brandGuidelines"]>;
  keywordSets: NonNullable<UpdateKnowledgePackInput["keywordSets"]>;
  competitors: NonNullable<UpdateKnowledgePackInput["competitors"]>;
}

function toEditableState(pack: KnowledgePackDetail): EditableState {
  return {
    name: pack.name,
    industryProfile: pack.industryProfile,
    publishingStrategy: pack.publishingStrategy,
    sources: pack.sources.map((s) => ({ sourceType: s.sourceType, url: s.url })),
    promptTemplates: pack.promptTemplates.map((t) => ({ contentType: t.contentType, promptBody: t.promptBody })),
    seoRules: pack.seoRules.map((r) => ({
      primaryKeywords: r.primaryKeywords,
      secondaryKeywords: r.secondaryKeywords,
      internalLinkingPolicy: r.internalLinkingPolicy,
      schemaPreferences: r.schemaPreferences,
    })),
    brandGuidelines: pack.brandGuidelines.map((b) => ({
      toneOfVoice: b.toneOfVoice,
      ctaRules: b.ctaRules,
      logoAssetId: b.logoAssetId,
      terminology: b.terminology,
    })),
    keywordSets: pack.keywordSets.map((k) => ({ name: k.name, keywords: k.keywords })),
    competitors: pack.competitors.map((c) => ({ domain: c.domain, notes: c.notes })),
  };
}

const SECTION_TABS: { id: string; label: string; count?: (s: EditableState) => number }[] = [
  { id: "overview", label: "Overview" },
  { id: "sources", label: "Sources", count: (s) => s.sources.length },
  { id: "prompts", label: "Prompts", count: (s) => s.promptTemplates.length },
  { id: "brand", label: "Brand", count: (s) => s.brandGuidelines.length },
  { id: "seo", label: "SEO", count: (s) => s.seoRules.length },
  { id: "keywords", label: "Keywords", count: (s) => s.keywordSets.length },
  { id: "competitors", label: "Competitors", count: (s) => s.competitors.length },
  { id: "versions", label: "Versions" },
];

export function KnowledgePackEditor({
  workspaceId,
  pack,
  editable,
  status,
  onSaved,
}: {
  workspaceId: string;
  pack: KnowledgePackDetail;
  editable: boolean;
  status: KnowledgePackStatus;
  onSaved: (pack: KnowledgePackDetail) => void;
}) {
  const idBase = useId();
  const [tab, setTab] = useState("overview");
  const [state, setState] = useState<EditableState>(() => toEditableState(pack));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const baseline = useMemo(() => JSON.stringify(toEditableState(pack)), [pack]);

  // Reset the working copy only when the server truth actually moved on
  // (a save/activate bumped lockVersion, or a different pack version
  // loaded) — never on an unrelated re-render, which would discard edits.
  useEffect(() => {
    setState(toEditableState(pack));
    setConflict(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack.publicId, pack.lockVersion, pack.status]);

  const dirty = editable && JSON.stringify(state) !== baseline;

  function set<K extends keyof EditableState>(key: K, value: EditableState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (pending) return;
    setPending(true);
    setError(null);
    setConflict(false);
    try {
      const updated = await knowledgePacksApi.update(workspaceId, pack.publicId, {
        expectedLockVersion: pack.lockVersion,
        ...state,
      });
      onSaved(updated);
    } catch (err) {
      if (isStaleLockConflict(err)) setConflict(true);
      else setError(friendlyMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function handleReload() {
    try {
      const fresh = await knowledgePacksApi.get(workspaceId, pack.publicId);
      onSaved(fresh);
    } catch (err) {
      setError(friendlyMessage(err));
    }
  }

  function discard() {
    setState(toEditableState(pack));
  }

  const tabs: TabItem[] = SECTION_TABS.map((t) => ({
    id: t.id,
    label: t.label,
    badge: t.count ? t.count(state) : undefined,
  }));

  return (
    <div className={styles.editor}>
      {conflict && (
        <Alert
          tone="warning"
          title="This Knowledge Pack changed elsewhere"
          action={
            <div className={styles.conflictActions}>
              <Button size="sm" variant="secondary" onClick={handleReload}>
                Reload latest version
              </Button>
            </div>
          }
        >
          Your unsaved edits here weren&apos;t applied. Reload to get the current version (this discards your changes), or keep
          editing and try saving again.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Knowledge Pack sections" idBase={idBase} />

      <div className={styles.panels}>
        <div {...tabPanelProps(idBase, "overview", tab)}>
          {tab === "overview" && (
            <OverviewSection
              pack={pack}
              name={state.name}
              onNameChange={(v) => set("name", v)}
              industryProfile={state.industryProfile}
              publishingStrategy={state.publishingStrategy}
              onIndustryChange={(v) => set("industryProfile", v)}
              onStrategyChange={(v) => set("publishingStrategy", v)}
              readOnly={!editable}
            />
          )}
        </div>
        <div {...tabPanelProps(idBase, "sources", tab)}>
          {tab === "sources" && (
            <TrustedSourcesSection value={state.sources} onChange={(v) => set("sources", v)} readOnly={!editable} />
          )}
        </div>
        <div {...tabPanelProps(idBase, "prompts", tab)}>
          {tab === "prompts" && (
            <PromptTemplatesSection value={state.promptTemplates} onChange={(v) => set("promptTemplates", v)} readOnly={!editable} />
          )}
        </div>
        <div {...tabPanelProps(idBase, "brand", tab)}>
          {tab === "brand" && (
            <BrandGuidelinesSection value={state.brandGuidelines} onChange={(v) => set("brandGuidelines", v)} readOnly={!editable} />
          )}
        </div>
        <div {...tabPanelProps(idBase, "seo", tab)}>
          {tab === "seo" && <SeoRulesSection value={state.seoRules} onChange={(v) => set("seoRules", v)} readOnly={!editable} />}
        </div>
        <div {...tabPanelProps(idBase, "keywords", tab)}>
          {tab === "keywords" && (
            <KeywordSetsSection value={state.keywordSets} onChange={(v) => set("keywordSets", v)} readOnly={!editable} />
          )}
        </div>
        <div {...tabPanelProps(idBase, "competitors", tab)}>
          {tab === "competitors" && (
            <CompetitorsSection value={state.competitors} onChange={(v) => set("competitors", v)} readOnly={!editable} />
          )}
        </div>
        <div {...tabPanelProps(idBase, "versions", tab)}>
          {tab === "versions" && (
            <VersionHistoryPanel workspaceId={workspaceId} knowledgePackId={pack.publicId} currentStatus={status} />
          )}
        </div>
      </div>

      {!editable && status !== "ARCHIVED" && (
        <p className={styles.readOnlyNote}>
          Only a Draft version can be edited. Use <strong>Create new version</strong> to make changes.
        </p>
      )}

      {editable && dirty && (
        <div className={styles.saveBar} role="region" aria-label="Unsaved changes">
          <span className={styles.saveBarText}>You have unsaved changes.</span>
          <div className={styles.saveBarActions}>
            <Button variant="ghost" size="sm" onClick={discard} disabled={pending}>
              Discard
            </Button>
            <Button size="sm" onClick={handleSave} loading={pending}>
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
