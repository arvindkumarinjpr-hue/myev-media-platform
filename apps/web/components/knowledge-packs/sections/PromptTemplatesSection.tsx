"use client";

import { KNOWLEDGE_PACK_CONTENT_TYPES } from "../../../lib/types";
import type { UpdateKnowledgePackInput } from "../../../lib/api/knowledge-packs";
import { ListSectionShell } from "./ListSectionShell";
import styles from "./ListSectionShell.module.css";

type Template = NonNullable<UpdateKnowledgePackInput["promptTemplates"]>[number];

export function PromptTemplatesSection({ value, onChange, readOnly }: { value: Template[]; onChange: (v: Template[]) => void; readOnly: boolean }) {
  return (
    <ListSectionShell
      heading="Prompt templates"
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ contentType: "BLOG" as const, promptBody: "" })}
      emptyLabel="No prompt templates yet — activation requires at least one for every content type."
      addLabel="Add template"
      renderRow={(item, update) => (
        <>
          <select value={item.contentType} onChange={(e) => update({ ...item, contentType: e.target.value as Template["contentType"] })} disabled={readOnly} className={styles.select}>
            {KNOWLEDGE_PACK_CONTENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <textarea
            value={item.promptBody}
            onChange={(e) => update({ ...item, promptBody: e.target.value })}
            readOnly={readOnly}
            placeholder="Write about {{topic}}…"
            className={styles.textInput}
            rows={2}
          />
        </>
      )}
    />
  );
}
