import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./DescriptionList.module.css";

export interface DescriptionItem {
  term: ReactNode;
  value: ReactNode;
}

interface DescriptionListProps {
  items: DescriptionItem[];
  /** "row" wraps term/value pairs inline (default); "stack" puts each pair in a column. */
  layout?: "row" | "stack";
  className?: string;
}

export function DescriptionList({ items, layout = "row", className }: DescriptionListProps) {
  return (
    <dl className={cx(styles.list, styles[layout], className)}>
      {items.map((item, i) => (
        <div key={i} className={styles.item}>
          <dt className={styles.term}>{item.term}</dt>
          <dd className={styles.value}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
