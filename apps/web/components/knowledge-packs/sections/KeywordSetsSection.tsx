"use client";

import type { KeywordSet } from "../../../lib/types";
import { ListSectionShell } from "./ListSectionShell";
import styles from "./ListSectionShell.module.css";

export function KeywordSetsSection({ value, onChange, readOnly }: { value: KeywordSet[]; onChange: (v: KeywordSet[]) => void; readOnly: boolean }) {
  return (
    <ListSectionShell
      heading="Keyword sets"
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ name: "", keywords: [] })}
      emptyLabel="No keyword sets yet."
      addLabel="Add keyword set"
      renderRow={(item, update) => (
        <>
          <input value={item.name} onChange={(e) => update({ ...item, name: e.target.value })} readOnly={readOnly} placeholder="Set name" className={styles.textInput} />
          <input
            value={item.keywords.join(", ")}
            onChange={(e) =>
              update({
                ...item,
                keywords: e.target.value
                  .split(",")
                  .map((k) => k.trim())
                  .filter(Boolean),
              })
            }
            readOnly={readOnly}
            placeholder="ev, electric vehicle, …"
            className={styles.textInput}
          />
        </>
      )}
    />
  );
}
