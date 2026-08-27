"use client";

import type { ReactNode } from "react";
import { Button } from "../../ui/Button";
import { PlusIcon } from "../../ui/icons";
import styles from "./RepeatableList.module.css";

interface RepeatableListProps<T> {
  items: T[];
  onChange: (next: T[]) => void;
  readOnly: boolean;
  emptyRow: () => T;
  /** Renders the editable fields for one item. */
  renderItem: (item: T, update: (next: T) => void, index: number) => ReactNode;
  addLabel: string;
  emptyLabel: string;
  /** Accessible name for each item, e.g. (i) => `Source ${i + 1}`. */
  itemLabel: (index: number) => string;
}

/**
 * Card-per-item repeatable editor. Rows have no backend id, so add/remove
 * always rebuilds the whole array — the parent section sends the full
 * collection on save, which the backend replaces wholesale.
 */
export function RepeatableList<T>({
  items,
  onChange,
  readOnly,
  emptyRow,
  renderItem,
  addLabel,
  emptyLabel,
  itemLabel,
}: RepeatableListProps<T>) {
  function update(index: number, next: T) {
    onChange(items.map((it, i) => (i === index ? next : it)));
  }
  function remove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <div className={styles.list}>
      {items.length === 0 && <p className={styles.empty}>{emptyLabel}</p>}

      {items.map((item, index) => (
        // eslint-disable-next-line react/no-array-index-key -- no stable id; array is rebuilt in place on every add/remove.
        <div key={index} className={styles.item} role="group" aria-label={itemLabel(index)}>
          <div className={styles.fields}>{renderItem(item, (next) => update(index, next), index)}</div>
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className={styles.remove}
              onClick={() => remove(index)}
              aria-label={`Remove ${itemLabel(index).toLowerCase()}`}
            >
              Remove
            </Button>
          )}
        </div>
      ))}

      {!readOnly && (
        <Button variant="secondary" size="sm" iconLeft={<PlusIcon />} onClick={() => onChange([...items, emptyRow()])}>
          {addLabel}
        </Button>
      )}
    </div>
  );
}
