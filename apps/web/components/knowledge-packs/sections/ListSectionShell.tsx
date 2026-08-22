"use client";

import type { ReactNode } from "react";
import styles from "./ListSectionShell.module.css";

/** Shared add/remove chrome for the 6 repeatable child collections (sources, prompt templates, SEO rules, brand guidelines, keyword sets, competitors) — each section supplies its own row fields and its own empty-row factory; this owns only the list mechanics. */
export function ListSectionShell<T>({
  heading,
  items,
  onChange,
  readOnly,
  emptyRow,
  renderRow,
  addLabel,
  emptyLabel,
}: {
  heading: string;
  items: T[];
  onChange: (next: T[]) => void;
  readOnly: boolean;
  emptyRow: () => T;
  renderRow: (item: T, update: (next: T) => void) => ReactNode;
  addLabel: string;
  emptyLabel: string;
}) {
  function updateRow(index: number, next: T) {
    onChange(items.map((item, i) => (i === index ? next : item)));
  }
  function removeRow(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{heading}</h3>
      {items.length === 0 && <p className={styles.empty}>{emptyLabel}</p>}
      {items.map((item, index) => (
        // eslint-disable-next-line react/no-array-index-key -- rows have no stable id from the backend; index is fine since add/remove always rebuild the full array in place.
        <div className={styles.row} key={index}>
          <div className={styles.rowFields}>{renderRow(item, (next) => updateRow(index, next))}</div>
          {!readOnly && (
            <button type="button" onClick={() => removeRow(index)} className={styles.removeButton} aria-label={`Remove ${heading.toLowerCase()} row ${index + 1}`}>
              Remove
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button type="button" onClick={() => onChange([...items, emptyRow()])} className={styles.addButton}>
          + {addLabel}
        </button>
      )}
    </section>
  );
}
