"use client";

import { KNOWLEDGE_SOURCE_TYPES, type KnowledgeSource } from "../../../lib/types";
import { ListSectionShell } from "./ListSectionShell";
import styles from "./ListSectionShell.module.css";

export function SourcesSection({ value, onChange, readOnly }: { value: KnowledgeSource[]; onChange: (v: KnowledgeSource[]) => void; readOnly: boolean }) {
  return (
    <ListSectionShell
      heading="Trusted sources"
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ sourceType: "GOVERNMENT" as const, url: "" })}
      emptyLabel="No trusted sources yet — at least one is required before this Knowledge Pack can activate."
      addLabel="Add source"
      renderRow={(item, update) => (
        <>
          <select value={item.sourceType} onChange={(e) => update({ ...item, sourceType: e.target.value as KnowledgeSource["sourceType"] })} disabled={readOnly} className={styles.select}>
            {KNOWLEDGE_SOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <input value={item.url} onChange={(e) => update({ ...item, url: e.target.value })} readOnly={readOnly} placeholder="https://…" className={styles.textInput} />
        </>
      )}
    />
  );
}
