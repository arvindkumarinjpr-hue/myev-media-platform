"use client";

import { KNOWLEDGE_SOURCE_TYPES, type KnowledgeSource } from "../../../lib/types";
import { FormField } from "../../ui/FormField";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { sourceTypeLabel } from "../labels";
import { RepeatableList } from "./RepeatableList";

export function TrustedSourcesSection({
  value,
  onChange,
  readOnly,
}: {
  value: KnowledgeSource[];
  onChange: (v: KnowledgeSource[]) => void;
  readOnly: boolean;
}) {
  return (
    <RepeatableList
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ sourceType: "GOVERNMENT" as const, url: "" })}
      emptyLabel="No trusted sources yet. Add at least one — a source is required before this Knowledge Pack can go live."
      addLabel="Add source"
      itemLabel={(i) => `Source ${i + 1}`}
      renderItem={(item, update) => (
        <>
          <FormField label="Source type">
            {(field) => (
              <Select
                {...field}
                value={item.sourceType}
                disabled={readOnly}
                onChange={(e) => update({ ...item, sourceType: e.target.value as KnowledgeSource["sourceType"] })}
              >
                {KNOWLEDGE_SOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {sourceTypeLabel(type)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="URL">
            {(field) => (
              <Input
                {...field}
                type="url"
                inputMode="url"
                value={item.url}
                readOnly={readOnly}
                placeholder="https://example.gov"
                onChange={(e) => update({ ...item, url: e.target.value })}
              />
            )}
          </FormField>
        </>
      )}
    />
  );
}
