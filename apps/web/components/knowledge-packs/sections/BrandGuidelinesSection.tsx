"use client";

import type { UpdateKnowledgePackInput } from "../../../lib/api/knowledge-packs";
import { FormField } from "../../ui/FormField";
import { Input } from "../../ui/Input";
import { Textarea } from "../../ui/Textarea";
import { AdvancedJson } from "../AdvancedJson";
import { RepeatableList } from "./RepeatableList";

type BrandGuidelineRow = NonNullable<UpdateKnowledgePackInput["brandGuidelines"]>[number];

export function BrandGuidelinesSection({
  value,
  onChange,
  readOnly,
}: {
  value: BrandGuidelineRow[];
  onChange: (v: BrandGuidelineRow[]) => void;
  readOnly: boolean;
}) {
  return (
    <RepeatableList
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ toneOfVoice: "", ctaRules: "", logoAssetId: null, terminology: {} })}
      emptyLabel="No brand guidelines set. Add tone of voice, calls-to-action, and preferred terminology so generated content stays on-brand."
      addLabel="Add brand guideline"
      itemLabel={(i) => `Brand guideline ${i + 1}`}
      renderItem={(item, update) => (
        <>
          <FormField label="Tone of voice">
            {(field) => (
              <Input
                {...field}
                value={item.toneOfVoice ?? ""}
                readOnly={readOnly}
                placeholder="e.g. Confident, plain-spoken, never hype"
                maxLength={200}
                onChange={(e) => update({ ...item, toneOfVoice: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Call-to-action rules">
            {(field) => (
              <Textarea
                {...field}
                value={item.ctaRules ?? ""}
                readOnly={readOnly}
                rows={2}
                placeholder="e.g. End every post with a link to the buyer's guide"
                onChange={(e) => update({ ...item, ctaRules: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Logo" hint="Optional — the media asset ID of the approved logo.">
            {(field) => (
              <Input
                {...field}
                value={item.logoAssetId ?? ""}
                readOnly={readOnly}
                placeholder="Media asset ID"
                onChange={(e) => update({ ...item, logoAssetId: e.target.value || null })}
              />
            )}
          </FormField>
          <AdvancedJson
            value={item.terminology ?? {}}
            onChange={(v) => update({ ...item, terminology: v })}
            readOnly={readOnly}
            noun="terminology glossary"
          />
        </>
      )}
    />
  );
}
