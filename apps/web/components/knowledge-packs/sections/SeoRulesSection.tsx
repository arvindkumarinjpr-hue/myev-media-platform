"use client";

import type { SeoRule } from "../../../lib/types";
import { ListSectionShell } from "./ListSectionShell";
import styles from "./ListSectionShell.module.css";

function toKeywordList(value: string): string[] {
  return value
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export function SeoRulesSection({ value, onChange, readOnly }: { value: SeoRule[]; onChange: (v: SeoRule[]) => void; readOnly: boolean }) {
  return (
    <ListSectionShell
      heading="SEO rules"
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ primaryKeywords: [], secondaryKeywords: [], internalLinkingPolicy: {}, schemaPreferences: {} })}
      emptyLabel="No SEO rules configured yet."
      addLabel="Add SEO rule"
      renderRow={(item, update) => (
        <>
          <input
            value={item.primaryKeywords.join(", ")}
            onChange={(e) => update({ ...item, primaryKeywords: toKeywordList(e.target.value) })}
            readOnly={readOnly}
            placeholder="Primary keywords, comma-separated"
            className={styles.textInput}
          />
          <input
            value={item.secondaryKeywords.join(", ")}
            onChange={(e) => update({ ...item, secondaryKeywords: toKeywordList(e.target.value) })}
            readOnly={readOnly}
            placeholder="Secondary keywords, comma-separated"
            className={styles.textInput}
          />
        </>
      )}
    />
  );
}
