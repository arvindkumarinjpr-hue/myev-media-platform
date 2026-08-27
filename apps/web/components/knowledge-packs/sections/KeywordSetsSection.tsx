"use client";

import type { KeywordSet } from "../../../lib/types";
import { ChipsInput } from "../../ui/ChipsInput";
import { FormField } from "../../ui/FormField";
import { Input } from "../../ui/Input";
import { RepeatableList } from "./RepeatableList";

export function KeywordSetsSection({
  value,
  onChange,
  readOnly,
}: {
  value: KeywordSet[];
  onChange: (v: KeywordSet[]) => void;
  readOnly: boolean;
}) {
  return (
    <RepeatableList
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ name: "", keywords: [] })}
      emptyLabel="No keyword sets yet. Group related keywords your team reuses across content."
      addLabel="Add keyword set"
      itemLabel={(i) => `Keyword set ${i + 1}`}
      renderItem={(item, update) => (
        <>
          <FormField label="Set name">
            {(field) => (
              <Input
                {...field}
                value={item.name}
                readOnly={readOnly}
                placeholder="e.g. Buyer intent"
                maxLength={200}
                onChange={(e) => update({ ...item, name: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Keywords" hint="Press Enter or comma to add each keyword.">
            {(field) => (
              <ChipsInput
                {...field}
                value={item.keywords as string[]}
                readOnly={readOnly}
                placeholder="ev, electric vehicle, e-mobility…"
                onChange={(v) => update({ ...item, keywords: v })}
              />
            )}
          </FormField>
        </>
      )}
    />
  );
}
