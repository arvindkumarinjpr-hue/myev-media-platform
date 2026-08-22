"use client";

import type { UpdateKnowledgePackInput } from "../../../lib/api/knowledge-packs";
import { ListSectionShell } from "./ListSectionShell";
import styles from "./ListSectionShell.module.css";

type BrandGuidelineRow = NonNullable<UpdateKnowledgePackInput["brandGuidelines"]>[number];

export function BrandGuidelinesSection({ value, onChange, readOnly }: { value: BrandGuidelineRow[]; onChange: (v: BrandGuidelineRow[]) => void; readOnly: boolean }) {
  return (
    <ListSectionShell
      heading="Brand guidelines"
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ toneOfVoice: "", ctaRules: "", logoAssetId: null, terminology: {} })}
      emptyLabel="No brand guidelines set yet."
      addLabel="Add brand guideline"
      renderRow={(item, update) => (
        <>
          <input value={item.toneOfVoice ?? ""} onChange={(e) => update({ ...item, toneOfVoice: e.target.value })} readOnly={readOnly} placeholder="Tone of voice" className={styles.textInput} />
          <input value={item.ctaRules ?? ""} onChange={(e) => update({ ...item, ctaRules: e.target.value })} readOnly={readOnly} placeholder="CTA rules" className={styles.textInput} />
        </>
      )}
    />
  );
}
