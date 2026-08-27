"use client";

import type { Competitor } from "../../../lib/types";
import { FormField } from "../../ui/FormField";
import { Input } from "../../ui/Input";
import { Textarea } from "../../ui/Textarea";
import { RepeatableList } from "./RepeatableList";

export function CompetitorsSection({
  value,
  onChange,
  readOnly,
}: {
  value: Competitor[];
  onChange: (v: Competitor[]) => void;
  readOnly: boolean;
}) {
  return (
    <RepeatableList
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ domain: "", notes: "" })}
      emptyLabel="No competitors tracked. Add the domains your team benchmarks content against."
      addLabel="Add competitor"
      itemLabel={(i) => `Competitor ${i + 1}`}
      renderItem={(item, update) => (
        <>
          <FormField label="Domain">
            {(field) => (
              <Input
                {...field}
                value={item.domain}
                readOnly={readOnly}
                placeholder="rival.example"
                maxLength={255}
                onChange={(e) => update({ ...item, domain: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Notes" optional>
            {(field) => (
              <Textarea
                {...field}
                value={item.notes ?? ""}
                readOnly={readOnly}
                rows={2}
                placeholder="What they do well, gaps to exploit…"
                onChange={(e) => update({ ...item, notes: e.target.value })}
              />
            )}
          </FormField>
        </>
      )}
    />
  );
}
