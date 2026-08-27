"use client";

import { KNOWLEDGE_PACK_CONTENT_TYPES } from "../../../lib/types";
import type { UpdateKnowledgePackInput } from "../../../lib/api/knowledge-packs";
import { Alert } from "../../ui/Alert";
import { FormField } from "../../ui/FormField";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";
import { contentTypeLabel } from "../labels";
import { RepeatableList } from "./RepeatableList";
import styles from "./sections.module.css";

type Template = NonNullable<UpdateKnowledgePackInput["promptTemplates"]>[number];

export function PromptTemplatesSection({
  value,
  onChange,
  readOnly,
}: {
  value: Template[];
  onChange: (v: Template[]) => void;
  readOnly: boolean;
}) {
  const covered = new Set(value.map((t) => t.contentType));
  const missing = KNOWLEDGE_PACK_CONTENT_TYPES.filter((t) => !covered.has(t));

  return (
    <div>
      {missing.length > 0 && (
        <Alert tone="info" className={styles.notice}>
          Going live needs one template per content type. Still missing: {missing.map(contentTypeLabel).join(", ")}.
        </Alert>
      )}
      <RepeatableList
        items={value}
        onChange={onChange}
        readOnly={readOnly}
        emptyRow={() => ({ contentType: "BLOG" as const, promptBody: "" })}
        emptyLabel="No prompt templates yet. Add one for each content type your team publishes."
        addLabel="Add template"
        itemLabel={(i) => `Template ${i + 1}`}
        renderItem={(item, update) => (
          <>
            <FormField label="Content type">
              {(field) => (
                <Select
                  {...field}
                  value={item.contentType}
                  disabled={readOnly}
                  onChange={(e) => update({ ...item, contentType: e.target.value as Template["contentType"] })}
                >
                  {KNOWLEDGE_PACK_CONTENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {contentTypeLabel(type)}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Prompt template" hint="Use {{topic}} and other placeholders your agents fill in.">
              {(field) => (
                <Textarea
                  {...field}
                  value={item.promptBody}
                  readOnly={readOnly}
                  rows={4}
                  placeholder="Write about {{topic}}…"
                  onChange={(e) => update({ ...item, promptBody: e.target.value })}
                />
              )}
            </FormField>
          </>
        )}
      />
    </div>
  );
}
