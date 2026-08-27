"use client";

import type { SeoRule } from "../../../lib/types";
import { ChipsInput } from "../../ui/ChipsInput";
import { FormField } from "../../ui/FormField";
import { AdvancedJson } from "../AdvancedJson";
import { RepeatableList } from "./RepeatableList";

export function SeoRulesSection({
  value,
  onChange,
  readOnly,
}: {
  value: SeoRule[];
  onChange: (v: SeoRule[]) => void;
  readOnly: boolean;
}) {
  return (
    <RepeatableList
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ primaryKeywords: [], secondaryKeywords: [], internalLinkingPolicy: {}, schemaPreferences: {} })}
      emptyLabel="No SEO rules configured. Add the primary and secondary keywords content should target."
      addLabel="Add SEO rule"
      itemLabel={(i) => `SEO rule ${i + 1}`}
      renderItem={(item, update) => (
        <>
          <FormField label="Primary keywords" hint="Press Enter or comma to add each keyword.">
            {(field) => (
              <ChipsInput
                {...field}
                value={item.primaryKeywords as string[]}
                readOnly={readOnly}
                placeholder="ev charging, electric vehicle range…"
                onChange={(v) => update({ ...item, primaryKeywords: v })}
              />
            )}
          </FormField>
          <FormField label="Secondary keywords">
            {(field) => (
              <ChipsInput
                {...field}
                value={item.secondaryKeywords as string[]}
                readOnly={readOnly}
                placeholder="battery health, home charger…"
                onChange={(v) => update({ ...item, secondaryKeywords: v })}
              />
            )}
          </FormField>
          <AdvancedJson
            value={item.internalLinkingPolicy}
            onChange={(v) => update({ ...item, internalLinkingPolicy: v })}
            readOnly={readOnly}
            noun="internal linking policy"
          />
          <AdvancedJson
            value={item.schemaPreferences}
            onChange={(v) => update({ ...item, schemaPreferences: v })}
            readOnly={readOnly}
            noun="schema preferences"
          />
        </>
      )}
    />
  );
}
