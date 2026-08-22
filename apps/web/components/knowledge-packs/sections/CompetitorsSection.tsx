"use client";

import type { Competitor } from "../../../lib/types";
import { ListSectionShell } from "./ListSectionShell";
import styles from "./ListSectionShell.module.css";

export function CompetitorsSection({ value, onChange, readOnly }: { value: Competitor[]; onChange: (v: Competitor[]) => void; readOnly: boolean }) {
  return (
    <ListSectionShell
      heading="Competitors"
      items={value}
      onChange={onChange}
      readOnly={readOnly}
      emptyRow={() => ({ domain: "", notes: "" })}
      emptyLabel="No competitors tracked yet."
      addLabel="Add competitor"
      renderRow={(item, update) => (
        <>
          <input value={item.domain} onChange={(e) => update({ ...item, domain: e.target.value })} readOnly={readOnly} placeholder="rival.example" className={styles.textInput} />
          <input value={item.notes ?? ""} onChange={(e) => update({ ...item, notes: e.target.value })} readOnly={readOnly} placeholder="Notes" className={styles.textInput} />
        </>
      )}
    />
  );
}
